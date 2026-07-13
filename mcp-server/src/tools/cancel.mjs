import { z } from "zod";

import { terminateProcessTreesAndWait } from "../lib/process.mjs";
import {
  appendJobLog,
  compareAndSwapJobState,
  isActiveJob,
  isJobOwnershipFresh,
  patchJobState,
  readJob,
  recordedJobPids,
  recordedProcessesGone,
  releaseWriteLock,
  resolveJobReference
} from "../lib/state.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { errorContent, jsonContent } from "./shared.mjs";

export const inputSchema = z.object({ cwd: z.string(), job_id: z.string().min(1) });

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const cwd = canonicalDirectory(input.cwd);
    const found = resolveJobReference(cwd, input.job_id);
    if (!found) throw new Error(`No Grok job found for "${input.job_id}".`);
    const priorStatus = found.status;
    if (!isActiveJob(found)) throw new Error(`Job ${found.id} is already ${found.status}.`);
    if (!isJobOwnershipFresh(found) && recordedProcessesGone(found)) {
      const orphaned = await compareAndSwapJobState(cwd, found.id, found.status, {
        ...found,
        status: "orphaned",
        pid: null,
        workerPid: null,
        grokPid: null,
        completedAt: new Date().toISOString(),
        errorMessage: "Worker ownership lease expired after all recorded processes exited."
      });
      if (!orphaned.success) throw new Error(`Job ${found.id} state changed before stale ownership could be recorded.`);
      if (found.request?.write === true) releaseWriteLock(cwd, found.id);
      appendJobLog(cwd, found.id, "Marked orphaned after the ownership lease expired and all recorded processes were confirmed gone.");
      return jsonContent({ job_id: found.id, prior_status: priorStatus, status: "orphaned", termination: null });
    }
    let cancelling = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = readJob(cwd, found.id);
      if (!current || !isActiveJob(current)) throw new Error(`Job ${found.id} is already ${current?.status ?? "unknown"}.`);
      if (current.status === "cancelling") {
        cancelling = current;
        break;
      }
      const result = await compareAndSwapJobState(cwd, found.id, current.status, {
        ...current,
        status: "cancelling",
        cancellationRequestedAt: new Date().toISOString()
      });
      if (result.success) { cancelling = result.job; break; }
    }
    if (!cancelling) throw new Error(`Job ${found.id} state changed before cancellation could complete.`);
    const pids = recordedJobPids(cancelling);
    if (pids.length === 0) {
      appendJobLog(cwd, found.id, "Cancellation is waiting for a killable worker or Grok PID to be recorded.");
      throw new Error(`Job ${found.id} is still cancelling; no killable process PID has been recorded yet.`);
    }
    const termination = await terminateProcessTreesAndWait(pids, { cwd });
    if (!termination.confirmed) {
      appendJobLog(cwd, found.id, `Cancellation could not confirm process exit: ${termination.remaining.join(", ")}.`);
      throw new Error(`Job ${found.id} is still cancelling; process exit could not be confirmed.`);
    }
    const finished = await patchJobState(cwd, found.id, "cancelling", () => ({
      status: "cancelled",
      completedAt: new Date().toISOString(),
      errorMessage: "Cancelled by user."
    }));
    if (!finished.success) {
      const current = readJob(cwd, found.id);
      if (!current || isActiveJob(current)) throw new Error(`Job ${found.id} state changed before cancellation could finish.`);
      if (cancelling.request?.write === true && recordedProcessesGone(current)) releaseWriteLock(cwd, found.id);
      appendJobLog(cwd, found.id, `Cancellation raced terminal completion; retained status ${current.status}.`);
      return jsonContent({ job_id: found.id, prior_status: priorStatus, status: current.status, termination });
    }
    const terminal = readJob(cwd, found.id);
    if (cancelling.request?.write === true) {
      if (!terminal || !recordedProcessesGone(terminal)) {
        throw new Error(`Job ${found.id} was cancelled but process exit could not be re-confirmed; the write lock was retained.`);
      }
      releaseWriteLock(cwd, found.id);
    }
    appendJobLog(cwd, found.id, "Cancelled by user.");
    return jsonContent({ job_id: found.id, prior_status: priorStatus, status: "cancelled", termination });
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_cancel",
  title: "Cancel a Grok Build job",
  description: "Atomically cancel an active job, terminate its process tree, and release its write lock.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema,
  handler
};

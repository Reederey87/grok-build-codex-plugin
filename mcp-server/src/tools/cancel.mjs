import { z } from "zod";

import { terminateProcessTree } from "../lib/process.mjs";
import {
  appendJobLog,
  compareAndSwapJobState,
  isActiveJob,
  readJob,
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
    let cancelled = null;
    let processId = found.grokPid ?? found.pid ?? Number.NaN;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = readJob(cwd, found.id);
      if (!current || !isActiveJob(current)) throw new Error(`Job ${found.id} is already ${current?.status ?? "unknown"}.`);
      processId = current.grokPid ?? current.pid ?? processId;
      const result = compareAndSwapJobState(cwd, found.id, current.status, {
        ...current,
        status: "cancelled",
        pid: null,
        grokPid: null,
        completedAt: new Date().toISOString(),
        errorMessage: "Cancelled by user."
      });
      if (result.success) { cancelled = result.job; break; }
    }
    if (!cancelled) throw new Error(`Job ${found.id} state changed before cancellation could complete.`);
    const termination = terminateProcessTree(processId, { cwd });
    if (found.request?.write === true) releaseWriteLock(cwd, found.id);
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
  inputSchema,
  handler
};

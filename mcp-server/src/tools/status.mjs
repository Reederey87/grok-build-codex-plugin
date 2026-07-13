import { z } from "zod";

import { attachRunningLiveness, isActiveJob, isJobOwnershipFresh, listJobs, resolveJobReference } from "../lib/state.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { errorContent, jsonContent } from "./shared.mjs";

export const inputSchema = z.object({
  cwd: z.string(),
  job_id: z.string().min(1).optional(),
  all: z.boolean().optional()
});

function publicStatus(job) {
  const live = attachRunningLiveness(job);
  return {
    id: live.id,
    job_id: live.id,
    kind: live.kind,
    status: live.status,
    summary: live.summary ?? null,
    created_at: live.createdAt,
    updated_at: live.updatedAt,
    started_at: live.startedAt ?? null,
    completed_at: live.completedAt ?? null,
    pid: live.workerPid ?? live.pid ?? null,
    workerPid: live.workerPid ?? live.pid ?? null,
    grokPid: live.grokPid ?? null,
    stopReason: live.stopReason ?? null,
    liveness: live.liveness ?? null,
    ownership: isActiveJob(live) ? (isJobOwnershipFresh(live) ? "fresh" : "stale") : null,
    error: live.errorMessage
      ? live.status === "cancelled" ? "Cancelled by user." : "Job did not complete successfully; use grok_build_result for details."
      : null
  };
}

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const cwd = canonicalDirectory(input.cwd);
    if (input.job_id) {
      const job = resolveJobReference(cwd, input.job_id);
      if (!job) throw new Error(`No Grok job found for "${input.job_id}".`);
      return jsonContent(publicStatus(job));
    }
    const jobs = listJobs(cwd);
    return jsonContent((input.all ? jobs : jobs.filter(isActiveJob)).map(publicStatus));
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_status",
  title: "Check Grok Build jobs",
  description: "List active or all stored jobs for a repository, including process liveness.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema,
  handler
};

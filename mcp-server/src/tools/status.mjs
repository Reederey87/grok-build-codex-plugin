import { z } from "zod";

import { attachRunningLiveness, isActiveJob, listJobs, resolveJobReference } from "../lib/state.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { errorContent, jsonContent } from "./shared.mjs";

export const inputSchema = z.object({
  cwd: z.string(),
  job_id: z.string().min(1).optional(),
  all: z.boolean().optional()
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const cwd = canonicalDirectory(input.cwd);
    if (input.job_id) {
      const job = resolveJobReference(cwd, input.job_id);
      if (!job) throw new Error(`No Grok job found for "${input.job_id}".`);
      return jsonContent(attachRunningLiveness(job));
    }
    const jobs = listJobs(cwd);
    return jsonContent((input.all ? jobs : jobs.filter(isActiveJob)).map(attachRunningLiveness));
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_status",
  title: "Check Grok Build jobs",
  description: "List active or all stored jobs for a repository, including process liveness.",
  inputSchema,
  handler
};

import { z } from "zod";

import { isActiveJob, resolveJobReference } from "../lib/state.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { errorContent, jsonContent, publicJobResult } from "./shared.mjs";

export const inputSchema = z.object({ cwd: z.string(), job_id: z.string().min(1) });

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const job = resolveJobReference(canonicalDirectory(input.cwd), input.job_id);
    if (!job) throw new Error(`No Grok job found for "${input.job_id}".`);
    if (isActiveJob(job)) throw new Error(`Job ${job.id} is still ${job.status}; check grok_build_status before requesting its result.`);
    return jsonContent(publicJobResult(job));
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_result",
  title: "Get a Grok Build result",
  description: "Return the stored result and evidence for a finished Grok job.",
  inputSchema,
  handler
};

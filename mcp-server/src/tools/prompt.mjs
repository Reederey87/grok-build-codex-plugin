import { z } from "zod";

import { readOnlyPrompt } from "../lib/prompts.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { DEFAULT_TIMEOUT_MS, errorContent, executeModelRequest, jsonContent } from "./shared.mjs";

export const inputSchema = z.object({
  cwd: z.string(),
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  output_format: z.enum(["json", "text"]).optional(),
  allow_api_fallback: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  session_id: z.string().min(1).optional(),
  resume: z.boolean().optional()
}).refine((value) => value.resume !== true || Boolean(value.session_id), {
  message: "session_id is required when resume is true",
  path: ["session_id"]
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const execution = await executeModelRequest({
      write: false,
      cwd: canonicalDirectory(input.cwd),
      prompt: readOnlyPrompt(input.prompt, "answer a repository question"),
      model: input.model,
      sessionId: input.resume ? undefined : input.session_id,
      resumeSessionId: input.resume ? input.session_id : undefined,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      allowApiFallback: input.allow_api_fallback
    });
    const response = jsonContent(execution.result);
    return execution.status === "succeeded" ? response : { ...response, isError: true };
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_prompt",
  title: "Prompt Grok Build",
  description: "Run a foreground, strictly read-only Grok Build prompt in a workspace.",
  inputSchema,
  handler
};

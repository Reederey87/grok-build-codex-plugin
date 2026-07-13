import process from "node:process";

import { z } from "zod";

import { readOnlyPrompt, writePrompt } from "../lib/prompts.mjs";
import { canonicalDirectory, getGitRepositoryRoot } from "../lib/workspace.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_LOCAL_TIMEOUT_MS,
  enqueueBackgroundJob,
  errorContent,
  jsonContent,
  publicJobResult,
  runForegroundJob
} from "./shared.mjs";

export const inputSchema = z.object({
  cwd: z.string(),
  task: z.string().min(1),
  write: z.boolean().optional(),
  background: z.boolean().optional(),
  always_approve: z.boolean().optional(),
  resume: z.boolean().optional(),
  session_id: z.string().min(1).optional(),
  allow_api_fallback: z.boolean().optional(),
  model: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1).max(MAX_LOCAL_TIMEOUT_MS).optional()
}).refine((value) => value.resume !== true || Boolean(value.session_id), {
  message: "session_id is required when resume is true",
  path: ["session_id"]
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const write = input.write === true;
    if (write && process.env.GROK_BUILD_ALLOW_WRITE !== "true") {
      return errorContent("write mode disabled — set GROK_BUILD_ALLOW_WRITE=true to enable");
    }
    if (write && input.always_approve === true && process.env.GROK_BUILD_ALLOW_ALWAYS_APPROVE !== "true") {
      return errorContent("always_approve disabled — set GROK_BUILD_ALLOW_ALWAYS_APPROVE=true to enable unattended writes");
    }
    const cwd = canonicalDirectory(input.cwd);
    if (write) getGitRepositoryRoot(cwd);
    const request = {
      cwd,
      write,
      prompt: write ? writePrompt(input.task) : readOnlyPrompt(input.task, "complete a bounded repository task"),
      model: input.model,
      sessionId: input.resume ? undefined : input.session_id,
      resumeSessionId: input.resume ? input.session_id : undefined,
      alwaysApprove: write && input.always_approve === true,
      allowApiFallback: !write && input.allow_api_fallback === true,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      summary: input.task.slice(0, 160)
    };
    if (input.background === true) return jsonContent(await enqueueBackgroundJob(cwd, "task", request));
    const completed = await runForegroundJob(cwd, "task", request);
    const result = publicJobResult(completed);
    const response = jsonContent(result);
    return completed.status === "succeeded" ? response : { ...response, isError: true };
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_task",
  title: "Run a Grok Build task",
  description: "Run or queue a bounded Grok task, optionally with gated workspace writes.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema,
  handler
};

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

import { collectReviewContext } from "../lib/git-context.mjs";
import { reviewPrompt } from "../lib/prompts.mjs";
import { errorContent, executeModelRequest, jsonContent } from "./shared.mjs";

const INLINE_REVIEW_LIMIT = 60 * 1024;

export const inputSchema = z.object({
  cwd: z.string(),
  base_ref: z.string().min(1).optional(),
  scope: z.enum(["working-tree", "branch", "repo"]).default("working-tree"),
  adversarial: z.boolean().optional(),
  focus: z.string().min(1).optional(),
  allow_api_fallback: z.boolean().optional()
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    const context = collectReviewContext(input.cwd, { base: input.base_ref, scope: input.scope });
    let content = context.content;
    if (Buffer.byteLength(content, "utf8") > INLINE_REVIEW_LIMIT) {
      const stateRoot = process.env.GROK_BUILD_PLUGIN_DATA || path.join(os.tmpdir(), "grok-build-mcp");
      const reviewDir = path.join(stateRoot, "review-inputs");
      fs.mkdirSync(reviewDir, { recursive: true });
      const reviewPath = path.join(reviewDir, `${randomUUID()}.md`);
      fs.writeFileSync(reviewPath, content, "utf8");
      content = `The review context is too large to inline. Read the review input at ${reviewPath}. Do not modify that file.`;
    }
    if (input.focus) content = `Review focus: ${input.focus}\n\n${content}`;
    if (input.adversarial) {
      content = `Use an adversarial review posture: actively challenge assumptions and search for subtle failure modes, while reporting only evidence-backed findings.\n\n${content}`;
    }
    const execution = await executeModelRequest({
      write: false,
      cwd: context.repoRoot,
      prompt: reviewPrompt({ content }),
      allowApiFallback: input.allow_api_fallback
    });
    const result = {
      source: execution.result.source,
      stop_reason: execution.result.stop_reason ?? null,
      findings: execution.result.text,
      ...(execution.result.model !== undefined ? { model: execution.result.model } : {}),
      ...(execution.result.error ? { error: execution.result.error } : {})
    };
    const response = jsonContent(result);
    return execution.status === "succeeded" ? response : { ...response, isError: true };
  } catch (error) {
    return errorContent(error);
  }
}

export const tool = {
  name: "grok_build_review",
  title: "Review with Grok Build",
  description: "Collect safe Git context and run a read-only Grok code review.",
  inputSchema,
  handler
};

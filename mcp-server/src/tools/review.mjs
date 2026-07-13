import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { collectReviewContext, collectReviewSnapshots, redactReviewContent } from "../lib/git-context.mjs";
import { reviewPrompt } from "../lib/prompts.mjs";
import { resolveStateRoot } from "../lib/state.mjs";
import { DEFAULT_TIMEOUT_MS, MAX_LOCAL_TIMEOUT_MS, errorContent, executeModelRequest, jsonContent } from "./shared.mjs";

const INLINE_REVIEW_LIMIT = 60 * 1024;
const REVIEW_INPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Best-effort removal of review-input files older than a week. @param {string} reviewDir */
function pruneStaleReviewInputs(reviewDir) {
  let entries;
  try {
    entries = fs.readdirSync(reviewDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - REVIEW_INPUT_MAX_AGE_MS;
  for (const entry of entries) {
    const entryPath = path.join(reviewDir, entry);
    try {
      if (fs.statSync(entryPath).mtimeMs < cutoff) fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Best effort: a vanished or locked file must not fail the review.
    }
  }
}

export const inputSchema = z.object({
  cwd: z.string(),
  base_ref: z.string().min(1).optional(),
  scope: z.enum(["working-tree", "branch", "repo"]).default("working-tree"),
  adversarial: z.boolean().optional(),
  focus: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1).max(MAX_LOCAL_TIMEOUT_MS).optional(),
  allow_api_fallback: z.boolean().optional(),
  preview_only: z.boolean().optional(),
  external_disclosure_acknowledged: z.boolean().optional()
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function handler(rawInput) {
  try {
    const input = inputSchema.parse(rawInput);
    if (input.scope === "repo" && input.base_ref) {
      return errorContent("base_ref is not valid with scope: \"repo\"; use scope: \"branch\" for a base comparison.");
    }
    const context = collectReviewContext(input.cwd, { base: input.base_ref, scope: input.scope });
    const redactedContext = redactReviewContent(context.content);
    const snapshots = input.scope === "repo"
      ? { content: "", includedFiles: 0, omittedBinaryFiles: 0, omittedLargeFiles: 0, truncatedFiles: 0, redactedMatches: 0 }
      : collectReviewSnapshots(context.repoRoot, context.changedFiles);
    let content = [redactedContext.content, snapshots.content].filter(Boolean).join("\n\n");
    let reviewPath = null;
    let reviewSessionDir = null;
    let executionCwd = context.repoRoot;
    const contentBytes = Buffer.byteLength(content, "utf8");
    const usesReviewInputFile = contentBytes > INLINE_REVIEW_LIMIT;
    const coverage = {
      path_filtered_files: context.changedFiles.length,
      redacted_matches: redactedContext.redactedMatches + snapshots.redactedMatches,
      snapshot_files: snapshots.includedFiles,
      omitted_binary_files: snapshots.omittedBinaryFiles,
      omitted_large_files: snapshots.omittedLargeFiles,
      truncated_snapshot_files: snapshots.truncatedFiles,
      diff_complete: !context.content.includes("diff omitted because it exceeds"),
      source_snapshot_available: snapshots.includedFiles > 0,
      content_redaction_applied: input.scope !== "repo"
    };
    if (input.preview_only === true) {
      return jsonContent({
        preview: true,
        scope: input.scope,
        target: context.targetLabel,
        path_filtered_changed_files: context.changedFiles,
        omitted_sensitive_paths: context.omittedSensitivePaths ?? 0,
        coverage,
        content_bytes: contentBytes,
        uses_review_input_file: usesReviewInputFile,
        external_service: "xAI via local Grok CLI",
        would_send_repository_content: true
      });
    }
    if (input.external_disclosure_acknowledged !== true) {
      return errorContent(
        "external_disclosure_acknowledged must be true: this review sends safe repository context to xAI via the local Grok CLI; use preview_only first to inspect the disclosure summary."
      );
    }
    // The API fallback only receives prompt text: it cannot follow a local
    // review-input path or inspect the repository, so it is viable only for
    // fully inlined diff context.
    let fallbackViable = input.scope !== "repo";
    if (input.scope !== "repo") {
      const stateRoot = resolveStateRoot();
      const reviewDir = path.join(stateRoot, "review-inputs");
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      fs.chmodSync(stateRoot, 0o700);
      fs.mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(reviewDir, 0o700);
      pruneStaleReviewInputs(reviewDir);
      reviewSessionDir = fs.mkdtempSync(path.join(reviewDir, "review-"));
      fs.chmodSync(reviewSessionDir, 0o700);
      executionCwd = reviewSessionDir;
    }
    if (usesReviewInputFile) {
      const reviewDir = reviewSessionDir ?? path.join(resolveStateRoot(), "review-inputs");
      if (!reviewSessionDir) {
        fs.mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(reviewDir, 0o700);
        pruneStaleReviewInputs(reviewDir);
      }
      reviewPath = path.join(reviewDir, `${randomUUID()}.md`);
      const descriptor = fs.openSync(reviewPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, content, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      content = `The review context is too large to inline. Read the review input at ${reviewPath}. Do not modify that file.`;
      fallbackViable = false;
    }
    if (input.focus) content = `Review focus: ${input.focus}\n\n${content}`;
    if (input.adversarial) {
      content = `Use an adversarial review posture: actively challenge assumptions and search for subtle failure modes, while reporting only evidence-backed findings.\n\n${content}`;
    }
    let execution;
    try {
      execution = await executeModelRequest({
        write: false,
        cwd: executionCwd,
        prompt: reviewPrompt({ content }),
        model: input.model,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        allowApiFallback: fallbackViable ? input.allow_api_fallback : false,
        cleanupSession: true
      });
    } finally {
      if (reviewPath) {
        try { fs.unlinkSync(reviewPath); } catch { /* crash recovery pruning remains as a backstop */ }
      }
      if (reviewSessionDir) {
        try { fs.rmSync(reviewSessionDir, { recursive: true, force: true }); } catch { /* crash recovery pruning remains as a backstop */ }
      }
    }
    const result = {
      source: execution.result.source,
      stop_reason: execution.result.stop_reason ?? null,
      findings: execution.result.text,
      requested_model: input.model ?? null,
      configured_model: execution.result.configured_model ?? null,
      effective_model: execution.result.model ?? input.model ?? null,
      model_source: execution.result.model_source ?? null,
      result_model: execution.result.model ?? null,
      coverage,
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
  description: "Preview or send safe Git context to xAI through the local Grok CLI for a read-only review. Execution requires explicit external-disclosure acknowledgement.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema,
  handler
};

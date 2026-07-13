import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { apiFallbackAvailable } from "../lib/api-fallback.mjs";
import { getGrokAvailability, getGrokInspect, getGrokModels, parseGrokModelsOutput, selectEffectiveModel } from "../lib/grok-cli.mjs";
import { readOnlyPrompt } from "../lib/prompts.mjs";
import { resolveJobsDir, resolveStateRoot } from "../lib/state.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { errorContent, executeModelRequest, jsonContent } from "./shared.mjs";

export const inputSchema = z.object({
  cwd: z.string().optional(),
  check_model: z.string().min(1).optional(),
  run_smoke_test: z.boolean().optional(),
  smoke_models: z.union([
    z.enum(["default", "all"]),
    z.array(z.string().min(1)).min(1).max(8)
  ]).optional(),
  allow_api_fallback: z.boolean().optional()
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function runSetup(rawInput) {
  const input = inputSchema.parse(rawInput);
  const cwd = canonicalDirectory(input.cwd ?? process.cwd());
  const grok = getGrokAvailability(cwd);
  let authOk = false;
  let authStatus = grok.available ? "unknown" : "cli_unavailable";
  let availableModels = [];
  let defaultModel = null;
  let inspectStatus = "not_run";
  if (grok.available) {
    const models = await getGrokModels(cwd);
    const parsedModels = parseGrokModelsOutput(models.stdout, models.stderr);
    availableModels = parsedModels.models;
    defaultModel = parsedModels.defaultModel;
    if (models.status === 0 && availableModels.length > 0) {
      authOk = true;
      authStatus = "authenticated";
    } else if (/not authenticated|unauthorized|log\s*in|login|\b401\b/i.test(parsedModels.output)) {
      authStatus = "unauthenticated";
    } else {
      authStatus = "probe_failed";
    }
    // Inspect is configuration discovery only. Run it for compatibility and
    // diagnostics, but never infer authentication from a missing JSON field.
    const inspect = await getGrokInspect(cwd);
    inspectStatus = inspect.status === 0 && !inspect.error ? "succeeded" : "failed";
  }

  let stateWritable = false;
  const probe = path.join(resolveJobsDir(cwd), `.write-probe-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(resolveStateRoot(), { recursive: true, mode: 0o700 });
    fs.chmodSync(resolveStateRoot(), 0o700);
    fs.mkdirSync(path.dirname(probe), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(path.dirname(probe)), 0o700);
    fs.chmodSync(path.dirname(probe), 0o700);
    fs.writeFileSync(probe, "ok", { encoding: "utf8", mode: 0o600 });
    fs.unlinkSync(probe);
    stateWritable = true;
  } catch {
    try { fs.unlinkSync(probe); } catch { /* best effort */ }
  }

  const requestedModel = input.check_model ?? defaultModel;
  let effectiveModel = requestedModel;
  try {
    effectiveModel = selectEffectiveModel({
      explicitModel: input.check_model,
      envModel: null,
      availableModels,
      defaultModel
    }).model;
  } catch {
    // Setup is diagnostic: report unavailable below instead of turning the
    // entire health check into a tool error.
  }
  let modelAvailable = effectiveModel === null ? availableModels.length > 0 : availableModels.includes(effectiveModel);
  const smokeRequested = input.run_smoke_test === true || input.smoke_models !== undefined;
  let smokeStatus = smokeRequested ? "not_run" : "not_requested";
  let smokeSource = null;
  const modelResults = [];
  if (smokeRequested && ((grok.available && authOk) || (input.allow_api_fallback === true && apiFallbackAvailable()))) {
    let modelsToSmoke;
    if (input.smoke_models === "all") {
      if (availableModels.length > 8) throw new Error("Refusing to smoke more than 8 discovered models; pass an explicit smoke_models list.");
      modelsToSmoke = availableModels;
    } else if (Array.isArray(input.smoke_models)) {
      modelsToSmoke = [...new Set(input.smoke_models)];
      const unavailable = modelsToSmoke.filter((model) => !availableModels.includes(model));
      if (unavailable.length > 0 && grok.available && authOk) {
        throw new Error(`Requested smoke model(s) not listed by \`grok models\`: ${unavailable.join(", ")}`);
      }
    } else {
      modelsToSmoke = [effectiveModel].filter(Boolean);
    }
    if (modelsToSmoke.length === 0 && input.allow_api_fallback === true && apiFallbackAvailable()) {
      modelsToSmoke = [effectiveModel ?? "grok-4.5"];
    }
    for (const model of modelsToSmoke) {
      const startedAt = Date.now();
      const smoke = await executeModelRequest({
        write: false,
        cwd,
        prompt: readOnlyPrompt("Reply exactly GROK_READY", "verify local model readiness"),
        model,
        timeoutMs: 60_000,
        allowApiFallback: input.allow_api_fallback,
        cleanupSession: true
      });
      const status = smoke.status === "succeeded" && smoke.result.text.trim() ? "succeeded" : smoke.status;
      modelResults.push({
        model,
        status,
        source: smoke.result.source,
        stop_reason: smoke.result.stop_reason ?? null,
        latency_ms: Date.now() - startedAt,
        ...(smoke.result.error ? { error: smoke.result.error.slice(0, 300) } : {})
      });
    }
    smokeStatus = modelResults.length > 0 && modelResults.every((result) => result.status === "succeeded")
      ? "succeeded"
      : modelResults.some((result) => result.status === "failed") ? "failed" : "incomplete";
    smokeSource = modelResults.length === 0
      ? null
      : new Set(modelResults.map((result) => result.source)).size === 1 ? modelResults[0].source : "mixed";
    const selectedResult = modelResults.find((result) => result.model === effectiveModel);
    if (selectedResult?.status === "succeeded" && selectedResult.source === "local_grok_cli") modelAvailable = true;
  }
  const smokeOk = !smokeRequested || smokeStatus === "succeeded";
  const localReady = grok.available && authOk && stateWritable && modelAvailable && smokeOk && smokeSource !== "xai_api_fallback";
  const fallbackReady = stateWritable && smokeStatus === "succeeded" && smokeSource === "xai_api_fallback";

  const nextSteps = [];
  if (!grok.available) nextSteps.push("Install the local Grok Build CLI and ensure `grok` is on PATH.");
  else if (!authOk) nextSteps.push("run `grok login` or `grok login --device-auth`");
  if (!stateWritable) nextSteps.push("Make the Grok Build plugin state directory writable.");
  if (requestedModel && !modelAvailable && grok.available && authOk) nextSteps.push(`Select an available Grok model; ${requestedModel} was not listed by \`grok models\`.`);
  if (smokeRequested && smokeStatus !== "succeeded" && grok.available && authOk && modelAvailable) nextSteps.push("Retry the Grok model smoke test and inspect its per-model diagnostic status.");
  return {
    ready: localReady || fallbackReady,
    grok_available: grok.available,
    local_cli_available: grok.available,
    grok_version: grok.available ? grok.detail : null,
    auth_ok: authOk,
    auth_status: authStatus,
    inspect_status: inspectStatus,
    requested_model: requestedModel,
    effective_model: effectiveModel,
    model_alias_applied: false,
    default_model: defaultModel,
    available_models: availableModels,
    model_available: modelAvailable,
    model_ok: modelAvailable && smokeOk,
    smoke_status: smokeStatus,
    model_results: modelResults,
    source: smokeSource ?? (grok.available ? "local_grok_cli" : null),
    local_ready: localReady,
    fallback_ready: fallbackReady,
    state_writable: stateWritable,
    state_directory: resolveStateRoot(),
    api_fallback_available: apiFallbackAvailable(),
    next_steps: nextSteps
  };
}

/** @param {z.infer<typeof inputSchema>} input */
export async function handler(input) {
  try { return jsonContent(await runSetup(input)); } catch (error) { return errorContent(error); }
}

export const tool = {
  name: "grok_build_setup",
  title: "Set up Grok Build",
  description: "Check the local Grok CLI, authentication, model, fallback, and state storage.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema,
  handler
};

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { apiFallbackAvailable } from "../lib/api-fallback.mjs";
import { getGrokAvailability, getGrokInspect } from "../lib/grok-cli.mjs";
import { resolveJobsDir } from "../lib/state.mjs";
import { canonicalDirectory } from "../lib/workspace.mjs";
import { errorContent, executeModelRequest, jsonContent } from "./shared.mjs";

export const inputSchema = z.object({
  cwd: z.string().optional(),
  check_model: z.string().min(1).optional(),
  run_smoke_test: z.boolean().optional(),
  allow_api_fallback: z.boolean().optional()
});

/** @param {z.infer<typeof inputSchema>} rawInput */
export async function runSetup(rawInput) {
  const input = inputSchema.parse(rawInput);
  const cwd = canonicalDirectory(input.cwd ?? process.cwd());
  const grok = getGrokAvailability(cwd);
  let authOk = false;
  if (grok.available) {
    const inspect = await getGrokInspect(cwd);
    if (inspect.status === 0) {
      try {
        const parsed = JSON.parse(inspect.stdout);
        authOk = !(parsed && typeof parsed === "object" && parsed.authenticated === false);
      } catch {
        authOk = true;
      }
    }
  }

  let stateWritable = false;
  const probe = path.join(resolveJobsDir(cwd), `.write-probe-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    stateWritable = true;
  } catch {
    try { fs.unlinkSync(probe); } catch { /* best effort */ }
  }

  const checkRequested = input.run_smoke_test === true || input.check_model !== undefined;
  let modelOk = checkRequested ? false : true;
  if (checkRequested && grok.available && authOk) {
    const smoke = await executeModelRequest({
      write: false,
      cwd,
      prompt: "Reply exactly GROK_READY",
      model: input.check_model,
      allowApiFallback: input.allow_api_fallback
    });
    modelOk = smoke.status === "succeeded" && smoke.result.text.trim() === "GROK_READY";
  }

  const nextSteps = [];
  if (!grok.available) nextSteps.push("Install the local Grok Build CLI and ensure `grok` is on PATH.");
  else if (!authOk) nextSteps.push("run `grok login` or `grok login --device-auth`");
  if (!stateWritable) nextSteps.push("Make the Grok Build plugin state directory writable.");
  if (checkRequested && !modelOk && grok.available && authOk) nextSteps.push("Verify the selected Grok model and retry the smoke test.");
  return {
    ready: grok.available && authOk && stateWritable && modelOk,
    grok_available: grok.available,
    grok_version: grok.available ? grok.detail : null,
    auth_ok: authOk,
    model_ok: modelOk,
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
  inputSchema,
  handler
};

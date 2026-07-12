import process from "node:process";

import { binaryAvailable, runCommand, runProcess } from "./process.mjs";

export const CLI_DEFAULT_MODEL = null;

const READ_ONLY_ALLOWS = [
  "Read"
];

const SENSITIVE_PATH_PATTERNS = [
  ".*",
  ".*/**",
  "**/.*",
  "**/.*/**",
  ".npmrc",
  "**/.npmrc",
  ".netrc",
  "**/.netrc",
  "credentials*",
  "**/credentials*",
  "*credential*",
  "**/*credential*",
  "*secret*",
  "**/*secret*",
  "*token*",
  "**/*token*",
  "*password*",
  "**/*password*",
  "*private*",
  "**/*private*",
  "id_rsa",
  "id_rsa*",
  "**/id_rsa",
  "**/id_rsa*",
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key"
];

const READ_ONLY_SENSITIVE_DENIES = SENSITIVE_PATH_PATTERNS.flatMap((pattern) => [
  `Read(${pattern})`,
  `Grep(${pattern})`
]);

const READ_ONLY_DENIES = [
  "Edit",
  ...READ_ONLY_SENSITIVE_DENIES,
  "Bash(cat)",
  "Bash(cat *)",
  "Bash(env)",
  "Bash(env *)",
  "Bash(printenv)",
  "Bash(printenv *)",
  "Bash(rm *)",
  "Bash(mv *)",
  "Bash(cp *)",
  "Bash(touch *)",
  "Bash(mkdir *)",
  "Bash(git add *)",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git branch *)",
  "Bash(git commit *)",
  "Bash(git reset *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git show)",
  "Bash(git show *)"
];

const WRITE_SENSITIVE_DENIES = SENSITIVE_PATH_PATTERNS.map((pattern) => `Edit(${pattern})`);

const WRITE_DENIES = [
  ...READ_ONLY_DENIES.filter((rule) => rule !== "Edit"),
  ...WRITE_SENSITIVE_DENIES
];

function normalizedModel(value) {
  const model = String(value ?? "").trim();
  return model || null;
}

export function resolveModel(explicitModel, env = process.env) {
  return normalizedModel(explicitModel) ?? normalizedModel(env.CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL) ?? CLI_DEFAULT_MODEL;
}

function normalizedString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function resolveEffort(explicitEffort, env = process.env) {
  return normalizedString(explicitEffort) ?? normalizedString(env.CLAUDE_PLUGIN_OPTION_DEFAULT_EFFORT) ?? null;
}

function parsePositiveInteger(value) {
  const trimmed = normalizedString(value);
  if (trimmed === null) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveMaxTurns(explicitMaxTurns, env = process.env) {
  if (normalizedString(explicitMaxTurns) !== null) {
    const parsed = parsePositiveInteger(explicitMaxTurns);
    if (parsed === undefined) {
      throw new Error("--max-turns must be a positive integer.");
    }
    return parsed;
  }
  const parsedEnv = parsePositiveInteger(env.CLAUDE_PLUGIN_OPTION_DEFAULT_MAX_TURNS);
  return parsedEnv === undefined ? null : parsedEnv;
}

export function parseGrokOutput(stdout) {
  const rawOutput = String(stdout ?? "").trim();
  if (!rawOutput) {
    return { parsed: null, rawOutput: "", parseError: "Grok produced no stdout.", stopReason: null };
  }
  try {
    const parsed = JSON.parse(rawOutput);
    const stopReason = typeof parsed?.stopReason === "string" && parsed.stopReason.trim() ? parsed.stopReason : null;
    return { parsed, rawOutput, parseError: null, stopReason };
  } catch (error) {
    return {
      parsed: null,
      rawOutput,
      parseError: error instanceof Error ? error.message : "Grok returned malformed JSON.",
      stopReason: null
    };
  }
}

/**
 * Exit code alone is untrustworthy: Grok exits 0 + Cancelled when killed externally and 1 + Cancelled on max-turns, so stopReason is the source of truth.
 */
export function classifyGrokCompletion({ exitStatus, stopReason }) {
  if (typeof stopReason === "string" && stopReason.trim()) {
    // Accept both the observed PascalCase ("EndTurn") and the ACP wire format ("end_turn").
    const isCleanStop = stopReason.toLowerCase().replace(/_/g, "") === "endturn";
    return isCleanStop ? "succeeded" : "incomplete";
  }
  if (exitStatus === 0) {
    return "incomplete";
  }
  return "failed";
}

export function getGrokAvailability(cwd) {
  return binaryAvailable("grok", ["--no-auto-update", "version"], { cwd });
}

const CLEANUP_TIMEOUT_MS = 15000;

/**
 * Deletes a Grok Build headless session left over from a finished companion job.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ ok: boolean, detail: string | null }}
 */
export function deleteGrokSession(cwd, sessionId) {
  try {
    const result = runCommand("grok", ["--no-auto-update", "sessions", "delete", sessionId], {
      cwd,
      timeout: CLEANUP_TIMEOUT_MS
    });
    if (result.error) {
      return { ok: false, detail: result.error.message };
    }
    if (result.signal) {
      return { ok: false, detail: `grok sessions delete timed out (${result.signal}).` };
    }
    if (result.status !== 0) {
      const detail = (result.stderr || "").trim() || (result.stdout || "").trim() || `exit ${result.status}`;
      return { ok: false, detail };
    }
    return { ok: true, detail: null };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function getGrokInspect(cwd, options = {}) {
  return runProcess("grok", ["--cwd", cwd, "--no-auto-update", "inspect", "--json"], {
    cwd,
    env: options.env ?? process.env
  });
}

/**
 * @param {string[]} args
 * @param {{ effort?: string|null, maxTurns?: number|string|null, jsonSchema?: string|null }} [tuning]
 */
function appendCommonTuningArgs(args, { effort, maxTurns, jsonSchema } = {}) {
  const trimmedEffort = normalizedString(effort);
  if (trimmedEffort !== null) {
    args.push("--effort", trimmedEffort);
  }
  const trimmedMaxTurns = normalizedString(maxTurns);
  if (trimmedMaxTurns !== null) {
    args.push("--max-turns", String(maxTurns).trim());
  }
  const trimmedJsonSchema = normalizedString(jsonSchema);
  if (trimmedJsonSchema !== null) {
    args.push("--json-schema", trimmedJsonSchema);
  }
}

export function buildReadOnlyGrokArgs({ cwd, prompt, model, sessionId, resumeSessionId, effort, maxTurns, jsonSchema }) {
  const args = [
    "--cwd",
    cwd,
    "--no-auto-update",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--sandbox",
    "read-only",
    "--permission-mode",
    "dontAsk"
  ];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  for (const rule of READ_ONLY_ALLOWS) {
    args.push("--allow", rule);
  }
  for (const rule of READ_ONLY_DENIES) {
    args.push("--deny", rule);
  }
  if (model) {
    args.push("--model", model);
  }
  appendCommonTuningArgs(args, { effort, maxTurns, jsonSchema });
  return args;
}

export function buildWriteGrokArgs({ cwd, prompt, model, sessionId, resumeSessionId, alwaysApprove = false, effort, maxTurns, jsonSchema }) {
  const args = [
    "--cwd",
    cwd,
    "--no-auto-update",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--sandbox",
    "workspace",
    "--permission-mode",
    "acceptEdits"
  ];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  for (const rule of READ_ONLY_ALLOWS) {
    args.push("--allow", rule);
  }
  for (const rule of WRITE_DENIES) {
    args.push("--deny", rule);
  }
  if (alwaysApprove) {
    args.push("--always-approve");
  }
  if (model) {
    args.push("--model", model);
  }
  appendCommonTuningArgs(args, { effort, maxTurns, jsonSchema });
  return args;
}

export async function runReadOnlyGrok({
  cwd,
  prompt,
  model,
  sessionId,
  resumeSessionId,
  effort,
  maxTurns,
  jsonSchema,
  env = process.env,
  runProcessImpl = runProcess,
  onPid
}) {
  const resolvedModel = resolveModel(model, env);
  const resolvedEffort = resolveEffort(effort, env);
  const resolvedMaxTurns = resolveMaxTurns(maxTurns, env);
  const result = await runProcessImpl(
    "grok",
    buildReadOnlyGrokArgs({
      cwd,
      prompt,
      model: resolvedModel,
      sessionId,
      resumeSessionId,
      effort: resolvedEffort,
      maxTurns: resolvedMaxTurns,
      jsonSchema
    }),
    {
      cwd,
      detached: true,
      onPid,
      env: {
        ...env,
        GROK_BUILD_COMPANION_ACTIVE: "1"
      }
    }
  );
  return {
    ...result,
    model: resolvedModel,
    output: parseGrokOutput(result.stdout)
  };
}

export async function runWriteGrok({
  cwd,
  prompt,
  model,
  sessionId,
  resumeSessionId,
  alwaysApprove = false,
  effort,
  maxTurns,
  jsonSchema,
  env = process.env,
  runProcessImpl = runProcess,
  onPid
}) {
  const resolvedModel = resolveModel(model, env);
  const resolvedEffort = resolveEffort(effort, env);
  const resolvedMaxTurns = resolveMaxTurns(maxTurns, env);
  const result = await runProcessImpl(
    "grok",
    buildWriteGrokArgs({
      cwd,
      prompt,
      model: resolvedModel,
      sessionId,
      resumeSessionId,
      alwaysApprove,
      effort: resolvedEffort,
      maxTurns: resolvedMaxTurns,
      jsonSchema
    }),
    {
      cwd,
      detached: true,
      onPid,
      env: {
        ...env,
        GROK_BUILD_COMPANION_ACTIVE: "1"
      }
    }
  );
  return {
    ...result,
    model: resolvedModel,
    output: parseGrokOutput(result.stdout)
  };
}

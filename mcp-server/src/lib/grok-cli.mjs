import process from "node:process";

import { binaryAvailable, runCommand, runProcess } from "./process.mjs";

export const CLI_DEFAULT_MODEL = null;
const DEFAULT_MODEL_CACHE_MS = 60_000;
const defaultModelCache = new Map();
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const READ_ONLY_ALLOWS = [
  "Read"
];
const READ_ONLY_TOOLS = "Read,Grep,Glob";
const WRITE_TOOLS = "Read,Grep,Glob,Edit,Bash";

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
  `Grep(${pattern})`,
  `Glob(${pattern})`
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
  "Bash(git show *)",
  "Bash(git push *)",
  "Bash(git clean *)",
  "Bash(git rebase *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(npm publish *)"
];

const WRITE_SENSITIVE_DENIES = SENSITIVE_PATH_PATTERNS.map((pattern) => `Edit(${pattern})`);

const WRITE_ALLOWS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Bash(npm test)",
  "Bash(npm test *)",
  "Bash(npm run build)",
  "Bash(npm run check-version)",
  "Bash(node --test)",
  "Bash(node --test *)",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git ls-files)",
  "Bash(git ls-files *)",
  "Bash(git rev-parse *)",
  "Bash(git log --oneline *)",
  "Bash(git diff --stat *)",
  "Bash(git diff --name-only *)",
  "Bash(git show --stat *)"
];

// Grok documents these commands as auto-approved even in dontAsk mode. Deny
// their content-reading forms explicitly so protected workspace files cannot be
// disclosed through a shell-tool bypass of Read/Grep/Glob policy.
const WRITE_SAFE_SHELL_DENIES = [
  "Bash(cat)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(sort *)",
  "Bash(uniq *)",
  "Bash(tr *)",
  "Bash(cut *)",
  "Bash(grep *)",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git show)",
  "Bash(git show *)"
];

const WRITE_DENIES = [
  ...READ_ONLY_DENIES.filter((rule) => rule !== "Edit"),
  ...WRITE_SENSITIVE_DENIES,
  ...WRITE_SAFE_SHELL_DENIES
];

function normalizedModel(value) {
  const model = String(value ?? "").trim();
  return model || null;
}

export function resolveModel(explicitModel, env = process.env) {
  return normalizedModel(explicitModel) ?? normalizedModel(env.GROK_BUILD_DEFAULT_MODEL) ?? CLI_DEFAULT_MODEL;
}

export function parseGrokModelsOutput(stdout, stderr = "") {
  const output = `${stdout ?? ""}\n${stderr ?? ""}`.replace(ANSI_ESCAPE, "");
  const defaultMatch = output.match(/Default model:\s*([^\s]+)/i);
  const models = [...output.matchAll(/^\s*(?:\*|-)\s+([^\s]+)\s*(?:\(default\))?\s*$/gim)].map((match) => match[1]);
  return {
    output,
    defaultModel: defaultMatch?.[1] ?? models[0] ?? null,
    models: [...new Set(models)]
  };
}

export function selectEffectiveModel({ explicitModel, envModel, availableModels, defaultModel }) {
  const requested = normalizedModel(explicitModel) ?? normalizedModel(envModel);
  if (requested && availableModels.length > 0 && !availableModels.includes(requested)) {
    throw new Error(`Requested Grok model "${requested}" is unavailable. Available models: ${availableModels.join(", ")}.`);
  }
  return {
    model: requested ?? defaultModel ?? null,
    source: explicitModel ? "requested" : envModel ? "environment" : defaultModel ? "cli_default" : "unresolved_cli_default"
  };
}

function normalizedString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function resolveEffort(explicitEffort, env = process.env) {
  return normalizedString(explicitEffort) ?? normalizedString(env.GROK_BUILD_DEFAULT_EFFORT) ?? null;
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
  const parsedEnv = parsePositiveInteger(env.GROK_BUILD_DEFAULT_MAX_TURNS);
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
  return binaryAvailable("grok", ["--no-auto-update", "version"], { cwd, timeout: PROBE_TIMEOUT_MS });
}

const CLEANUP_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 15000;

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
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS
  });
}

export async function getGrokModels(cwd, options = {}) {
  return runProcess("grok", ["--cwd", cwd, "--no-auto-update", "models"], {
    cwd,
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS
  });
}

async function resolveInvocationModel(explicitModel, cwd, env, runProcessImpl) {
  const envModel = normalizedModel(env.GROK_BUILD_DEFAULT_MODEL);
  const cached = defaultModelCache.get(cwd);
  if (cached && Date.now() - cached.at < DEFAULT_MODEL_CACHE_MS) {
    return selectEffectiveModel({ explicitModel, envModel, availableModels: cached.models, defaultModel: cached.defaultModel });
  }
  let result;
  try {
    result = await runProcessImpl("grok", ["--cwd", cwd, "--no-auto-update", "models"], { cwd, env, timeout: PROBE_TIMEOUT_MS });
  } catch (error) {
    const configured = normalizedModel(explicitModel) ?? envModel;
    if (configured) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to verify requested Grok model "${configured}" because model discovery failed: ${detail}`);
    }
    return { model: configured, source: explicitModel ? "requested" : envModel ? "environment" : "unresolved_cli_default" };
  }
  const parsed = parseGrokModelsOutput(result.stdout, result.stderr);
  if (result.status === 0 && parsed.models.length > 0) {
    defaultModelCache.set(cwd, { ...parsed, at: Date.now() });
    return selectEffectiveModel({ explicitModel, envModel, availableModels: parsed.models, defaultModel: parsed.defaultModel });
  }
  const configured = normalizedModel(explicitModel) ?? envModel;
  if (configured) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Unable to verify requested Grok model "${configured}" because model discovery returned no usable model list: ${detail}`);
  }
  return { model: configured, source: explicitModel ? "requested" : envModel ? "environment" : "unresolved_cli_default" };
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

function appendIsolationArgs(args) {
  args.push(
    "--no-memory",
    "--no-subagents",
    "--disable-web-search",
    "--disallowed-tools",
    "WebSearch,WebFetch,Task"
  );
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
    "strict",
    "--permission-mode",
    "dontAsk"
  ];
  appendIsolationArgs(args);
  args.push("--tools", READ_ONLY_TOOLS);
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
    "strict",
    "--permission-mode",
    "dontAsk"
  ];
  appendIsolationArgs(args);
  args.push("--tools", WRITE_TOOLS);
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  for (const rule of WRITE_ALLOWS) {
    args.push("--allow", rule);
  }
  for (const rule of WRITE_DENIES) {
    args.push("--deny", rule);
  }
  // dontAsk plus the explicit allowlist already approves every permitted
  // capability. Do not forward --always-approve: it would broaden unmatched
  // shell commands beyond this curated policy.
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
  sessionId = null,
  resumeSessionId = null,
  effort = null,
  maxTurns = null,
  jsonSchema = null,
  env = process.env,
  runProcessImpl = runProcess,
  onPid = undefined,
  detached = true,
  timeout = undefined
}) {
  const resolved = await resolveInvocationModel(model, cwd, env, runProcessImpl);
  const resolvedModel = resolved.model;
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
      detached,
      onPid,
      timeout,
      env: {
        ...env,
        GROK_BUILD_COMPANION_ACTIVE: "1"
      }
    }
  );
  return {
    ...result,
    model: resolvedModel,
    modelSource: resolved.source,
    output: parseGrokOutput(result.stdout)
  };
}

export async function runWriteGrok({
  cwd,
  prompt,
  model,
  sessionId = null,
  resumeSessionId = null,
  alwaysApprove = false,
  effort = null,
  maxTurns = null,
  jsonSchema = null,
  env = process.env,
  runProcessImpl = runProcess,
  onPid = undefined,
  detached = true,
  timeout = undefined
}) {
  const resolved = await resolveInvocationModel(model, cwd, env, runProcessImpl);
  const resolvedModel = resolved.model;
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
      detached,
      onPid,
      timeout,
      env: {
        ...env,
        GROK_BUILD_COMPANION_ACTIVE: "1"
      }
    }
  );
  return {
    ...result,
    model: resolvedModel,
    modelSource: resolved.source,
    output: parseGrokOutput(result.stdout)
  };
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { apiFallbackAvailable, runXaiApiFallback } from "../lib/api-fallback.mjs";
import {
  classifyGrokCompletion,
  deleteGrokSession,
  runReadOnlyGrok,
  runWriteGrok
} from "../lib/grok-cli.mjs";
import { runCommand, runProcess, terminateProcessTreesAndWait } from "../lib/process.mjs";
import {
  acquireWriteLock,
  appendJobLog,
  compareAndSwapJobState,
  createJob,
  isActiveJob,
  pruneExpiredJobs,
  patchJobState,
  readJob,
  recordedProcessesGone,
  releaseWriteLock,
  resolveJobLogFile,
  writeJob
} from "../lib/state.mjs";

export const DEFAULT_TIMEOUT_MS = 600000;
export const MAX_LOCAL_TIMEOUT_MS = 3_600_000;
const WORKER_PATH = fileURLToPath(new URL("../worker.mjs", import.meta.url));

/**
 * @typedef {{source: "local_grok_cli"|"xai_api_fallback", text: string, model?: string|null, requested_model?: string|null, configured_model?: string|null, effective_model?: string|null, model_source?: string|null, write_supported?: false, stop_reason?: string|null, session_id?: string|null, error?: string, raw_stdout?: string}} ModelResult
 * @typedef {{status: "succeeded"|"incomplete"|"failed", result: ModelResult, evidence: Record<string, unknown>, pid: number|null}} ModelExecution
 */

/** @param {unknown} value @returns {{content: Array<{type: "text", text: string}>, structuredContent: {result: unknown}, isError?: boolean}} */
export function jsonContent(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value }
  };
}

/** @param {unknown} error @returns {{content: Array<{type: "text", text: string}>, isError: true}} */
export function errorContent(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

/** @param {boolean|undefined} inputAllowed @param {NodeJS.ProcessEnv} [env] */
export function fallbackPermitted(inputAllowed, env = process.env) {
  return (inputAllowed === true || env.GROK_BUILD_API_FALLBACK === "true") && apiFallbackAvailable(env);
}

/** @param {unknown} result */
function localFailureKind(result) {
  const error = result && typeof result === "object" && "error" in result ? result.error : null;
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "ENOENT") {
    return "missing";
  }
  const status = result && typeof result === "object" && "status" in result ? Number(result.status) : 0;
  const stderr = result && typeof result === "object" && "stderr" in result ? String(result.stderr ?? "") : "";
  const stdout = result && typeof result === "object" && "stdout" in result ? String(result.stdout ?? "") : "";
  if (status !== 0 && /(?:not authenticated|authentication|unauthorized|log\s*in|login|api key|credential|\b401\b)/i.test(`${stderr}\n${stdout}`)) {
    return "auth";
  }
  return null;
}

/**
 * @param {{write: boolean, cwd: string, prompt: string, model?: string, sessionId?: string, resumeSessionId?: string, alwaysApprove?: boolean, timeoutMs?: number, allowApiFallback?: boolean, background?: boolean, cleanupSession?: boolean, onPid?: (pid: number) => void}} options
 * @returns {Promise<ModelExecution>}
 */
export async function executeModelRequest(options) {
  let childPid = null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LOCAL_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between 1 and ${MAX_LOCAL_TIMEOUT_MS}.`);
  }
  const common = {
    cwd: options.cwd,
    prompt: options.prompt,
    model: options.model,
    sessionId: options.sessionId,
    resumeSessionId: options.resumeSessionId,
    effort: undefined,
    maxTurns: undefined,
    jsonSchema: undefined,
    detached: options.background !== true,
    timeout: timeoutMs,
    onPid(pid) {
      childPid = pid;
      return options.onPid?.(pid);
    }
  };
  const local = options.write
    ? await runWriteGrok({ ...common, alwaysApprove: options.alwaysApprove === true })
    : await runReadOnlyGrok(common);

  const localErrorCode = local.error && typeof local.error === "object" && "code" in local.error ? local.error.code : null;
  if (localErrorCode === "OUTPUT_LIMIT_EXCEEDED") {
    const termination = local.termination ?? { confirmed: false, remaining: local.pid === null ? [] : [local.pid] };
    return {
      status: "failed",
      result: {
        source: "local_grok_cli",
        model: local.model,
        stop_reason: local.output.stopReason,
        session_id: null,
        text: local.output.rawOutput,
        error: local.error.message
      },
      evidence: {
        exit_status: local.status,
        output_limit_exceeded: true,
        stream: local.error.stream,
        termination_confirmed: termination.confirmed,
        remaining_pids: termination.remaining,
        pid_registration_error: local.pidRegistrationError ?? null
      },
      pid: local.pid ?? childPid
    };
  }

  if (localErrorCode === "ETIMEDOUT") {
    const termination = local.termination ?? { confirmed: false, remaining: local.pid === null ? [] : [local.pid] };
    return {
      status: "failed",
      result: {
        source: "local_grok_cli",
        model: local.model,
        stop_reason: local.output.stopReason,
        session_id: null,
        text: local.output.rawOutput,
        error: `Grok timed out after ${timeoutMs} ms.`
      },
      evidence: {
        exit_status: local.status,
        timeout_ms: timeoutMs,
        termination_confirmed: termination.confirmed,
        remaining_pids: termination.remaining,
        pid_registration_error: local.pidRegistrationError ?? null
      },
      pid: local.pid ?? childPid
    };
  }

  const failureKind = localFailureKind(local);
  if (!options.write && failureKind && fallbackPermitted(options.allowApiFallback)) {
    const fallback = await runXaiApiFallback({ prompt: options.prompt, model: local.model });
    return {
      status: "succeeded",
      result: {
        ...fallback,
        requested_model: options.model ?? null,
        configured_model: process.env.GROK_BUILD_DEFAULT_MODEL ?? null,
        effective_model: fallback.model,
        model_source: options.model ? "requested" : process.env.GROK_BUILD_DEFAULT_MODEL ? "environment" : "api_default"
      },
      evidence: { local_failure: failureKind, exit_status: local.status },
      pid: local.pid ?? null
    };
  }

  const parsed = local.output.parsed;
  const text = parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string"
    ? parsed.text
    : local.output.rawOutput;
  const sessionId = parsed && typeof parsed === "object" && "sessionId" in parsed && typeof parsed.sessionId === "string"
    ? parsed.sessionId
    : null;
  const sessionCleanup = options.cleanupSession === true && sessionId
    ? deleteGrokSession(options.cwd, sessionId)
    : null;
  const classified = classifyGrokCompletion({ exitStatus: local.status, stopReason: local.output.stopReason });
  /** @type {"succeeded"|"incomplete"|"failed"} */
  let status = classified === "succeeded" ? "succeeded" : classified === "incomplete" ? "incomplete" : "failed";
  if (local.output.parseError) status = "failed";
  const errorMessage = local.output.parseError
    ? `Malformed Grok JSON: ${local.output.parseError}`
    : status === "failed"
      ? local.stderr.trim() || `Grok exited with status ${local.status}.`
      : status === "incomplete"
        ? `Grok stopped early (stopReason: ${local.output.stopReason ?? "unknown"}).`
        : null;
  return {
    status,
    result: {
      source: "local_grok_cli",
      model: local.model,
      requested_model: options.model ?? null,
      configured_model: process.env.GROK_BUILD_DEFAULT_MODEL ?? null,
      effective_model: local.model,
      model_source: local.modelSource ?? null,
      stop_reason: local.output.stopReason,
      session_id: sessionId,
      text,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(local.output.parseError ? { raw_stdout: local.output.rawOutput } : {})
    },
    evidence: {
      stop_reason: local.output.stopReason,
      exit_status: local.status,
      stderr: local.stderr,
      parse_error: local.output.parseError,
      session_cleanup: sessionCleanup
      ,pid_registration_error: local.pidRegistrationError ?? null
    },
    pid: local.pid ?? null
  };
}

/** @param {string} cwd */
function captureGitStatus(cwd) {
  const result = runCommand("git", ["status", "--short"], { cwd });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to capture Git status.");
  return result.stdout;
}

const PROTECTED_PATH_NAME = /(?:^\.|\.env(?:\.|$)|credential|secret|token|password|private|id_rsa|\.pem$|\.key$)/i;

function captureProtectedFiles(cwd) {
  const listed = runCommand("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, maxBuffer: 4 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) return {};
  const snapshot = {};
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    if (!relativePath.split(/[\\/]/).some((part) => PROTECTED_PATH_NAME.test(part))) continue;
    const absolutePath = path.join(cwd, relativePath);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const hash = stat.size <= 10 * 1024 * 1024
        ? createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")
        : `metadata:${stat.size}:${stat.mtimeMs}`;
      snapshot[relativePath] = hash;
    } catch { /* vanished during capture */ }
  }
  return snapshot;
}

function changedProtectedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((filePath) => before[filePath] !== after[filePath]);
}

/** @param {string} cwd @param {Record<string, unknown>} job */
export async function runStoredJob(cwd, job) {
  const initialRequest = job.request && typeof job.request === "object" ? job.request : {};
  const started = await compareAndSwapJobState(cwd, String(job.id), "queued", {
    ...job,
    status: "running",
    workerPid: "background" in initialRequest && initialRequest.background === true ? process.pid : null,
    pid: "background" in initialRequest && initialRequest.background === true ? process.pid : null,
    controllerPid: process.pid,
    grokPid: null,
    workerHeartbeatAt: "background" in initialRequest && initialRequest.background === true ? new Date().toISOString() : null,
    startedAt: new Date().toISOString()
  });
  if (!started.success) {
    const queuedRequest = job.request;
    if (queuedRequest && typeof queuedRequest === "object" && "write" in queuedRequest && queuedRequest.write === true) {
      if (started.job && !isActiveJob(started.job) && recordedProcessesGone(started.job)) {
        releaseWriteLock(cwd, String(job.id));
      }
    }
    return started.job ?? job;
  }
  const running = started.job;
  let heartbeatTimer = null;
  heartbeatTimer = setInterval(() => {
    void patchJobState(cwd, running.id, "running", () => ({
      workerHeartbeatAt: new Date().toISOString()
    })).catch(() => {});
  }, 2_000);
  heartbeatTimer.unref?.();
  appendJobLog(cwd, running.id, `Started ${running.kind} job.`);
  const request = running.request;
  try {
    const before = request.write === true ? captureGitStatus(request.cwd) : null;
    const protectedBefore = request.write === true ? captureProtectedFiles(request.cwd) : null;
    const execution = await executeModelRequest({
      write: request.write === true,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? undefined,
      sessionId: request.sessionId ?? undefined,
      resumeSessionId: request.resumeSessionId ?? undefined,
      alwaysApprove: request.alwaysApprove === true,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      allowApiFallback: request.allowApiFallback === true,
      background: request.background === true,
      async onPid(pid) {
        const persisted = await patchJobState(cwd, running.id, ["running", "cancelling"], () => ({ grokPid: pid }));
        if (!persisted.success && isActiveJob(persisted.job)) {
          throw new Error(`Unable to persist Grok PID ${pid} for active job ${running.id}.`);
        }
      }
    });
    let after = null;
    let protectedAfter = null;
    let gitStatusError = null;
    if (before !== null) {
      try {
        after = captureGitStatus(request.cwd);
        protectedAfter = captureProtectedFiles(request.cwd);
      } catch (error) {
        gitStatusError = error instanceof Error ? error.message : String(error);
      }
    }
    const protectedChanges = protectedBefore && protectedAfter ? changedProtectedPaths(protectedBefore, protectedAfter) : [];
    const protectedViolation = protectedChanges.length > 0;
    const finalStatus = protectedViolation ? "failed" : execution.status;
    const finalError = protectedViolation
      ? `Grok changed protected workspace path(s): ${protectedChanges.join(", ")}. Changes were preserved for review.`
      : execution.result.error ?? null;
    const cleanupPending = execution.evidence.termination_confirmed === false;
    const terminal = await patchJobState(cwd, running.id, ["running", "cancelling"], (current) => ({
      status: cleanupPending ? "cancelling" : current.status === "cancelling" ? "cancelled" : finalStatus,
      pid: cleanupPending ? current.pid : null,
      workerPid: cleanupPending ? current.workerPid : null,
      grokPid: execution.pid ?? current.grokPid ?? null,
      stopReason: execution.result.stop_reason ?? null,
      evidence: {
        ...execution.evidence,
        git_status_before: before,
        git_status_after: after,
        git_status_error: gitStatusError,
        protected_path_changes: protectedChanges
      },
      result: execution.result,
      terminalDisposition: current.status === "cancelling" ? "cancel_won" : "completion_won",
      ...(cleanupPending ? { cancellationRequestedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }),
      errorMessage: finalError
    }));
    appendJobLog(cwd, running.id, terminal.success ? `Completed with status ${finalStatus}.` : "Job completion lost a state race.");
    if (request.write === true && terminal.success && !cleanupPending && recordedProcessesGone(terminal.job)) {
      releaseWriteLock(cwd, running.id);
    }
    return terminal.job ?? running;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await patchJobState(cwd, running.id, ["running", "cancelling"], (current) => ({
      status: current.status === "cancelling" ? "cancelled" : "failed",
      pid: null,
      workerPid: null,
      completedAt: new Date().toISOString(),
      errorMessage: message,
      result: { source: "local_grok_cli", text: "", error: message }
    }));
    appendJobLog(cwd, running.id, failed.success ? "Failed before completion." : "Job was cancelled before completion.");
    if (request.write === true && failed.success && recordedProcessesGone(failed.job)) {
      releaseWriteLock(cwd, running.id);
    }
    return failed.job ?? running;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

/**
 * @param {string} cwd
 * @param {"ask"|"review"|"task"} kind
 * @param {Record<string, unknown>} request
 */
function prepareJob(cwd, kind, request) {
  pruneExpiredJobs(cwd);
  const initial = createJob(kind, cwd, { summary: request.summary ?? null, request });
  return { ...initial, logFile: resolveJobLogFile(cwd, initial.id) };
}

/** @param {string} cwd @param {"ask"|"review"|"task"} kind @param {Record<string, unknown>} request */
export async function runForegroundJob(cwd, kind, request) {
  const job = prepareJob(cwd, kind, { ...request, background: false });
  if (request.write === true) acquireWriteLock(cwd, job.id);
  try {
    writeJob(cwd, job);
  } catch (error) {
    if (request.write === true) releaseWriteLock(cwd, job.id);
    throw error;
  }
  return runStoredJob(cwd, job);
}

/** @param {string} cwd @param {"ask"|"review"|"task"} kind @param {Record<string, unknown>} request @param {{spawnImpl?: (command: string, args: string[], options: import("node:child_process").SpawnOptions) => import("node:child_process").ChildProcess}} [options] */
export async function enqueueBackgroundJob(cwd, kind, request, options = {}) {
  const job = prepareJob(cwd, kind, { ...request, background: true });
  if (request.write === true) acquireWriteLock(cwd, job.id);
  try {
    writeJob(cwd, job);
    appendJobLog(cwd, job.id, "Queued for detached background execution.");
    const env = { ...process.env };
    delete env.GROK_BUILD_COMPANION_ACTIVE;
    const child = (options.spawnImpl ?? spawn)(process.execPath, [WORKER_PATH, "--job-id", job.id, "--cwd", cwd], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    if (!child || typeof child.once !== "function") throw new Error("Background worker did not return a ChildProcess.");
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        child.removeListener?.("spawn", onSpawn);
        child.removeListener?.("error", onError);
        callback(value);
      };
      const onSpawn = () => finish(resolve);
      const onError = (error) => finish(reject, error);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      // Native ChildProcess assigns pid synchronously on successful spawn.
      // Custom test doubles may omit the spawn event, so resolve on the next
      // microtask only when a valid pid is already present.
      if (typeof child.pid === "number") queueMicrotask(onSpawn);
    });
    if (typeof child.pid !== "number") throw new Error("Background worker did not provide a process id.");
    const queued = readJob(cwd, job.id);
    if (queued?.status === "queued") {
      await compareAndSwapJobState(cwd, job.id, "queued", { ...queued, workerPid: child.pid, pid: child.pid });
    }
    child.unref();
    return { job_id: job.id, status: "queued" };
  } catch (error) {
    const current = readJob(cwd, job.id);
    if (current?.status === "queued") {
      await compareAndSwapJobState(cwd, job.id, "queued", {
        ...current,
        status: "failed",
        pid: null,
        workerPid: null,
        completedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : String(error),
        result: { source: "local_grok_cli", text: "", error: error instanceof Error ? error.message : String(error) }
      });
    }
    if (request.write === true) releaseWriteLock(cwd, job.id);
    throw error;
  }
}

/** @param {Record<string, unknown>} job */
export function publicJobResult(job) {
  return {
    job_id: job.id,
    status: job.status,
    stop_reason: job.stopReason ?? null,
    evidence: job.evidence ?? null,
    result: job.result ?? null,
    error: job.errorMessage ?? null
  };
}

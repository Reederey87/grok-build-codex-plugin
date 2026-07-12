import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { apiFallbackAvailable, runXaiApiFallback } from "../lib/api-fallback.mjs";
import {
  classifyGrokCompletion,
  runReadOnlyGrok,
  runWriteGrok
} from "../lib/grok-cli.mjs";
import { runCommand, runProcess, terminateProcessTree } from "../lib/process.mjs";
import {
  acquireWriteLock,
  appendJobLog,
  compareAndSwapJobState,
  createJob,
  readJob,
  releaseWriteLock,
  resolveJobLogFile,
  writeJob
} from "../lib/state.mjs";

export const DEFAULT_TIMEOUT_MS = 600000;
const WORKER_PATH = fileURLToPath(new URL("../worker.mjs", import.meta.url));

/**
 * @typedef {{source: "local_grok_cli"|"xai_api_fallback", text: string, model?: string|null, write_supported?: false, stop_reason?: string|null, session_id?: string|null, error?: string, raw_stdout?: string}} ModelResult
 * @typedef {{status: "succeeded"|"incomplete"|"failed", result: ModelResult, evidence: Record<string, unknown>, pid: number|null}} ModelExecution
 */

/** @param {unknown} value @returns {{content: Array<{type: "text", text: string}>, isError?: boolean}} */
export function jsonContent(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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
 * @param {{write: boolean, cwd: string, prompt: string, model?: string, sessionId?: string, resumeSessionId?: string, alwaysApprove?: boolean, timeoutMs?: number, allowApiFallback?: boolean, onPid?: (pid: number) => void}} options
 * @returns {Promise<ModelExecution>}
 */
export async function executeModelRequest(options) {
  let timedOut = false;
  let childPid = null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** @type {typeof runProcess} */
  const timedRunProcess = async (command, args, processOptions = {}) => {
    const originalOnPid = processOptions.onPid;
    const promise = runProcess(command, args, {
      ...processOptions,
      onPid(pid) {
        childPid = pid;
        if (typeof originalOnPid === "function") originalOnPid(pid);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (childPid !== null) terminateProcessTree(childPid, { cwd: options.cwd });
    }, timeoutMs);
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  };

  const common = {
    cwd: options.cwd,
    prompt: options.prompt,
    model: options.model,
    sessionId: options.sessionId,
    resumeSessionId: options.resumeSessionId,
    effort: undefined,
    maxTurns: undefined,
    jsonSchema: undefined,
    onPid: options.onPid,
    runProcessImpl: timedRunProcess
  };
  const local = options.write
    ? await runWriteGrok({ ...common, alwaysApprove: options.alwaysApprove === true })
    : await runReadOnlyGrok(common);

  if (timedOut) {
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
      evidence: { exit_status: local.status, timeout_ms: timeoutMs },
      pid: local.pid ?? childPid
    };
  }

  const failureKind = localFailureKind(local);
  if (!options.write && failureKind && fallbackPermitted(options.allowApiFallback)) {
    const fallback = await runXaiApiFallback({ prompt: options.prompt, model: local.model });
    return {
      status: "succeeded",
      result: fallback,
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
      parse_error: local.output.parseError
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

/** @param {string} cwd @param {Record<string, unknown>} job */
export async function runStoredJob(cwd, job) {
  const started = compareAndSwapJobState(cwd, String(job.id), "queued", {
    ...job,
    status: "running",
    pid: process.pid,
    grokPid: null,
    startedAt: new Date().toISOString()
  });
  if (!started.success) {
    const queuedRequest = job.request;
    if (queuedRequest && typeof queuedRequest === "object" && "write" in queuedRequest && queuedRequest.write === true) {
      releaseWriteLock(cwd, String(job.id));
    }
    return started.job ?? job;
  }
  const running = started.job;
  appendJobLog(cwd, running.id, `Started ${running.kind} job.`);
  const request = running.request;
  try {
    const before = request.write === true ? captureGitStatus(request.cwd) : null;
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
      onPid(pid) {
        const current = readJob(cwd, running.id);
        if (current?.status === "running") compareAndSwapJobState(cwd, running.id, "running", { ...current, grokPid: pid });
      }
    });
    const after = before === null ? null : captureGitStatus(request.cwd);
    const terminal = compareAndSwapJobState(cwd, running.id, "running", {
      ...running,
      status: execution.status,
      pid: null,
      grokPid: execution.pid,
      stopReason: execution.result.stop_reason ?? null,
      evidence: {
        ...execution.evidence,
        git_status_before: before,
        git_status_after: after
      },
      result: execution.result,
      completedAt: new Date().toISOString(),
      errorMessage: execution.result.error ?? null
    });
    appendJobLog(cwd, running.id, terminal.success ? `Completed with status ${execution.status}.` : "Job completion lost a state race.");
    return terminal.job ?? running;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = compareAndSwapJobState(cwd, running.id, "running", {
      ...running,
      status: "failed",
      pid: null,
      completedAt: new Date().toISOString(),
      errorMessage: message,
      result: { source: "local_grok_cli", text: "", error: message }
    });
    appendJobLog(cwd, running.id, failed.success ? "Failed before completion." : "Job was cancelled before completion.");
    return failed.job ?? running;
  } finally {
    if (request.write === true) releaseWriteLock(cwd, running.id);
  }
}

/**
 * @param {string} cwd
 * @param {"ask"|"review"|"task"} kind
 * @param {Record<string, unknown>} request
 */
function prepareJob(cwd, kind, request) {
  const initial = createJob(kind, cwd, { summary: request.summary ?? null, request });
  return { ...initial, logFile: resolveJobLogFile(cwd, initial.id) };
}

/** @param {string} cwd @param {"ask"|"review"|"task"} kind @param {Record<string, unknown>} request */
export async function runForegroundJob(cwd, kind, request) {
  const job = prepareJob(cwd, kind, request);
  if (request.write === true) acquireWriteLock(cwd, job.id);
  try {
    writeJob(cwd, job);
  } catch (error) {
    if (request.write === true) releaseWriteLock(cwd, job.id);
    throw error;
  }
  return runStoredJob(cwd, job);
}

/** @param {string} cwd @param {"ask"|"review"|"task"} kind @param {Record<string, unknown>} request */
export function enqueueBackgroundJob(cwd, kind, request) {
  const job = prepareJob(cwd, kind, request);
  if (request.write === true) acquireWriteLock(cwd, job.id);
  try {
    writeJob(cwd, job);
    appendJobLog(cwd, job.id, "Queued for detached background execution.");
    const env = { ...process.env };
    delete env.GROK_BUILD_COMPANION_ACTIVE;
    const child = spawn(process.execPath, [WORKER_PATH, "--job-id", job.id, "--cwd", cwd], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return { job_id: job.id, status: "queued" };
  } catch (error) {
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

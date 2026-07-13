import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    shell: false,
    stdio: "pipe",
    timeout: options.timeout,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function binaryAvailable(command, args = ["--version"], options = {}) {
  const result = runCommand(command, args, options);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { available: false, detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}` };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "available" };
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let processError = null;
    let escalationTimer = null;
    let forceSettleTimer = null;
    let timeoutTimer = null;
    let termination = null;
    let pidRegistrationError = null;
    let pidRegistration = Promise.resolve();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: options.detached ?? false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const settle = (status, error, closeConfirmed = false) => {
      if (settled) return;
      settled = true;
      if (escalationTimer) clearTimeout(escalationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (termination) {
        termination = {
          ...termination,
          confirmed: closeConfirmed,
          remaining: closeConfirmed || typeof child.pid !== "number" ? [] : [child.pid]
        };
      }
      void pidRegistration.finally(() => {
        resolve({
          command,
          args,
          pid: child.pid ?? null,
          status: status ?? 1,
          stdout,
          stderr,
          error,
          termination,
          pidRegistrationError
        });
      });
    };

    const beginTermination = (reason) => {
      if (termination) return;
      if (typeof child.pid !== "number") {
        termination = { reason, terminations: [], escalations: [], remaining: [], confirmed: false };
        settle(1, processError, false);
        return;
      }
      const first = tryTerminateProcessTree(child.pid, { signal: "SIGTERM" });
      termination = { reason, terminations: [first], escalations: [], remaining: [child.pid], confirmed: false };
      escalationTimer = setTimeout(() => {
        const escalation = tryTerminateProcessTree(child.pid, { signal: "SIGKILL" });
        termination = { ...termination, escalations: [escalation] };
      }, 1000);
      escalationTimer.unref?.();
      forceSettleTimer = setTimeout(() => settle(1, processError, false), 3500);
      forceSettleTimer.unref?.();
    };

    const capture = (stream, chunk) => {
      if (processError && "code" in processError && processError.code === "OUTPUT_LIMIT_EXCEEDED") return;
      const text = String(chunk);
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const incoming = Buffer.byteLength(text);
      if (used + incoming <= maxOutputBytes) {
        if (stream === "stdout") {
          stdout += text;
          stdoutBytes += incoming;
        } else {
          stderr += text;
          stderrBytes += incoming;
        }
        return;
      }
      const remaining = Math.max(0, maxOutputBytes - used);
      if (remaining > 0) {
        const truncated = Buffer.from(text).subarray(0, remaining).toString("utf8");
        if (stream === "stdout") {
          stdout += truncated;
          stdoutBytes = maxOutputBytes;
        } else {
          stderr += truncated;
          stderrBytes = maxOutputBytes;
        }
      }
      if (!processError) {
        processError = Object.assign(new Error(`${stream} exceeded the ${maxOutputBytes}-byte output limit.`), {
          code: "OUTPUT_LIMIT_EXCEEDED",
          stream,
          maxOutputBytes
        });
        beginTermination("output_limit");
      }
    };

    if (typeof options.onPid === "function" && typeof child.pid === "number") {
      try {
        pidRegistration = Promise.resolve(options.onPid(child.pid)).catch((error) => {
          pidRegistrationError = error instanceof Error ? error.message : String(error);
        });
      } catch (error) {
        pidRegistrationError = error instanceof Error ? error.message : String(error);
      }
    }

    if (Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled || processError) return;
        processError = Object.assign(new Error(`${command} timed out after ${options.timeout} ms.`), {
          code: "ETIMEDOUT",
          timeoutMs: options.timeout
        });
        beginTermination("timeout");
      }, options.timeout);
      timeoutTimer.unref?.();
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      capture("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      capture("stderr", chunk);
    });

    child.on("error", (error) => {
      settle(1, error, typeof child.pid !== "number");
    });
    child.on("close", (status) => {
      settle(status, processError, true);
    });
  });
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    // EPERM means the process exists but we cannot signal it; treat as alive.
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const signal = options.signal ?? "SIGTERM";
  const killImpl = options.killImpl ?? process.kill.bind(process);
  if (platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    return {
      attempted: true,
      delivered: !result.error && result.status === 0,
      method: "taskkill"
    };
  }

  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    try {
      killImpl(pid, signal);
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }
}

export function tryTerminateProcessTree(pid, options = {}) {
  try {
    return { pid, ...terminateProcessTree(pid, options), error: null };
  } catch (error) {
    return {
      pid,
      attempted: true,
      delivered: false,
      method: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** @param {number[]} pids @param {{cwd?: string, graceMs?: number, pollMs?: number}} [options] */
export async function terminateProcessTreesAndWait(pids, options = {}) {
  const unique = [...new Set(pids.filter((pid) => Number.isFinite(pid)))];
  const graceMs = options.graceMs ?? 2500;
  const pollMs = options.pollMs ?? 25;
  const waitUntilGone = async (deadline) => {
    for (;;) {
      const alive = unique.filter((pid) => isProcessAlive(pid));
      if (alive.length === 0 || Date.now() >= deadline) return alive;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  const terminations = unique.map((pid) => tryTerminateProcessTree(pid, { cwd: options.cwd, signal: "SIGTERM" }));
  let alive = await waitUntilGone(Date.now() + graceMs);
  const escalations = alive.map((pid) => tryTerminateProcessTree(pid, { cwd: options.cwd, signal: "SIGKILL" }));
  alive = await waitUntilGone(Date.now() + graceMs);
  return { terminations, escalations, remaining: alive, confirmed: alive.length === 0 };
}

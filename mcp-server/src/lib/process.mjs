import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

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

    if (typeof options.onPid === "function" && typeof child.pid === "number") {
      try {
        options.onPid(child.pid);
      } catch {
        // Callback errors must not abort the spawned process.
      }
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ command, args, pid: child.pid ?? null, status: 1, stdout, stderr, error });
    });
    child.on("close", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ command, args, pid: child.pid ?? null, status: status ?? 1, stdout, stderr, error: null });
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
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";

const LAUNCHER_PATH = path.resolve("mcp-server/bin/grok-build-mcp");
const RESTRICTED_PATH = "/usr/bin:/bin";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "grok-build-launcher-tests", version: "1.0.0" }
  }
};

/**
 * Spawns the launcher via /bin/sh with the given env, sends one initialize
 * request on stdin, and resolves with { code, signal, stdout, stderr,
 * response } once either a JSON-RPC response line arrives or the process
 * exits.
 * @param {NodeJS.ProcessEnv} env
 */
function runLauncher(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [LAUNCHER_PATH], {
      cwd: path.resolve("."),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let response = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for launcher. stdout: ${stdout} stderr: ${stderr}`));
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (response) return;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const line = stdout.slice(0, newline).trim();
      if (!line) return;
      try {
        response = JSON.parse(line);
        clearTimeout(timer);
        child.kill("SIGTERM");
      } catch {
        // Not a full JSON line yet; keep buffering.
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, response });
    });

    child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
  });
}

test("restricted PATH with GROK_BUILD_NODE set succeeds", { timeout: 10000 }, async () => {
  const result = await runLauncher({
    PATH: RESTRICTED_PATH,
    GROK_BUILD_NODE: process.execPath
  });
  assert.equal(result.response?.result?.serverInfo?.name, "grok-build");
});

test("restricted PATH falls back to `command -v node` discovery", { timeout: 10000 }, async () => {
  const binDir = makeTempDir("grok-build-launcher-node-");
  const nodeLink = path.join(binDir, "node");
  fs.symlinkSync(process.execPath, nodeLink);

  const result = await runLauncher({
    PATH: `${binDir}${path.delimiter}${RESTRICTED_PATH}`
  });
  assert.equal(result.response?.result?.serverInfo?.name, "grok-build");

  fs.rmSync(binDir, { recursive: true, force: true });
});

test("missing node reports exit 127 and mentions GROK_BUILD_NODE", { timeout: 10000 }, async () => {
  const result = await runLauncher({
    PATH: RESTRICTED_PATH,
    GROK_BUILD_NODE: "/nonexistent/node"
  });
  assert.equal(result.code, 127);
  assert.match(result.stderr, /GROK_BUILD_NODE/);
});

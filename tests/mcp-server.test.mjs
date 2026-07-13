import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const SERVER_PATH = path.resolve("mcp-server/src/server.mjs");
const EXPECTED_TOOLS = [
  "grok_build_cancel",
  "grok_build_prompt",
  "grok_build_result",
  "grok_build_review",
  "grok_build_setup",
  "grok_build_status",
  "grok_build_task"
];

function removeTree(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** @param {import("node:test").TestContext} t @param {string} behavior */
async function startMcpServer(t, behavior = "json") {
  const root = makeTempDir("grok-mcp-server-");
  const binDir = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(binDir);
  const fixture = installFakeGrok(binDir, behavior);
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      GROK_BUILD_PLUGIN_DATA: dataDir
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let nextId = 1;
  let stdout = "";
  let stderr = "";
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited (${code ?? signal}). ${stderr}`));
    }
    pending.clear();
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "grok-build-tests", version: "1.0.0" }
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    removeTree(root);
  });
  return { initialized, request, fixture, root };
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

test("initialize identifies the grok-build server", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  assert.equal(client.initialized.serverInfo.name, "grok-build");
});

test("tools/list exposes exactly the seven Grok Build tools", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const result = await client.request("tools/list");
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  const review = result.tools.find((tool) => tool.name === "grok_build_review");
  assert.equal(review.annotations.openWorldHint, true);
  const status = result.tools.find((tool) => tool.name === "grok_build_status");
  assert.equal(status.annotations.readOnlyHint, true);
});

test("grok_build_setup reports a ready authenticated fake CLI", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const result = await client.request("tools/call", {
    name: "grok_build_setup",
    arguments: { cwd: repo }
  });
  assert.deepEqual(
    { ready: parseToolResult(result).ready, grok_available: parseToolResult(result).grok_available, auth_ok: parseToolResult(result).auth_ok },
    { ready: true, grok_available: true, auth_ok: true }
  );
});

test("grok_build_setup accepts a clean non-exact smoke response", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const result = await client.request("tools/call", {
    name: "grok_build_setup",
    arguments: { cwd: repo, check_model: "grok-4.5", run_smoke_test: true }
  });
  const body = parseToolResult(result);
  assert.equal(body.ready, true);
  assert.equal(body.model_available, true);
  assert.equal(body.smoke_status, "succeeded");
  assert.equal(body.source, "local_grok_cli");
});

test("check_model validates discovery without forcing a smoke call", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const result = await client.request("tools/call", {
    name: "grok_build_setup",
    arguments: { cwd: repo, check_model: "grok-4.5", run_smoke_test: false }
  });
  const body = parseToolResult(result);
  assert.equal(body.model_available, true);
  assert.equal(body.smoke_status, "not_requested");
  assert.deepEqual(body.model_results, []);
  assert.equal(client.fixture.readState().calls.some((call) => call.args.includes("-p")), false);
});

test("grok_build_setup can smoke every discovered model", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const result = await client.request("tools/call", {
    name: "grok_build_setup",
    arguments: { cwd: repo, smoke_models: "all" }
  });
  const body = parseToolResult(result);
  assert.equal(body.smoke_status, "succeeded");
  assert.deepEqual(body.model_results.map((entry) => entry.model), ["grok-4.5", "grok-composer-2.5-fast"]);
  assert.equal(body.model_results.every((entry) => entry.stop_reason === "EndTurn"), true);
});

test("grok_build_review previews disclosure without invoking Grok", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "safe.txt"), "safe\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=value\n");
  const before = client.fixture.readState().calls.length;
  const result = await client.request("tools/call", {
    name: "grok_build_review",
    arguments: { cwd: repo, preview_only: true }
  });
  const body = parseToolResult(result);
  assert.equal(body.preview, true);
  assert.equal(body.would_send_repository_content, true);
  assert.equal(body.omitted_sensitive_paths, 1);
  assert.deepEqual(body.path_filtered_changed_files, ["safe.txt"]);
  assert.equal(body.coverage.content_redaction_applied, true);
  assert.equal(JSON.stringify(body).includes(".env"), false);
  assert.equal(client.fixture.readState().calls.length, before);
});

test("grok_build_review requires disclosure acknowledgement", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const result = await client.request("tools/call", {
    name: "grok_build_review",
    arguments: { cwd: repo }
  });
  assert.equal(result.isError, true);
  assert.match(parseToolResult(result).error, /external_disclosure_acknowledged/);
});

test("grok_build_prompt runs the fake CLI read-only", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  const result = await client.request("tools/call", {
    name: "grok_build_prompt",
    arguments: { cwd: repo, prompt: "Explain this repository" }
  });
  const body = parseToolResult(result);
  assert.equal(body.source, "local_grok_cli");
  assert.equal(body.stop_reason, "EndTurn");
  assert.equal(body.text, "fake response");
  const call = client.fixture.readState().calls.at(-1);
  assert.equal(call.args.includes("-p"), true);
  assert.deepEqual(call.args.slice(call.args.indexOf("--sandbox"), call.args.indexOf("--sandbox") + 2), ["--sandbox", "strict"]);
});

test("grok_build_review uses a read-only prompt for uncommitted changes", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "example.txt"), "before\n");
  run("git", ["add", "example.txt"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "example.txt"), "after\n");

  const result = await client.request("tools/call", {
    name: "grok_build_review",
    arguments: { cwd: repo, model: "grok-composer-2.5-fast", external_disclosure_acknowledged: true }
  });
  assert.equal(result.isError, undefined);
  const body = parseToolResult(result);
  assert.equal(body.requested_model, "grok-composer-2.5-fast");
  assert.equal(body.result_model, "grok-composer-2.5-fast");
  const call = client.fixture.readState().calls.at(-1);
  assert.deepEqual(call.args.slice(call.args.indexOf("--sandbox"), call.args.indexOf("--sandbox") + 2), ["--sandbox", "strict"]);
  assert.deepEqual(call.args.slice(call.args.indexOf("--model"), call.args.indexOf("--model") + 2), ["--model", "grok-composer-2.5-fast"]);
  assert.match(call.args[call.args.indexOf("-p") + 1], /Do not modify files/);
});

test("file-backed review input is deleted after the model call", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "large.txt"), "before\n");
  run("git", ["add", "large.txt"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "large.txt"), `${"changed line\n".repeat(7000)}`);
  const preview = parseToolResult(await client.request("tools/call", {
    name: "grok_build_review",
    arguments: { cwd: repo, preview_only: true }
  }));
  assert.equal(preview.uses_review_input_file, true);
  const result = await client.request("tools/call", {
    name: "grok_build_review",
    arguments: { cwd: repo, external_disclosure_acknowledged: true }
  });
  assert.equal(result.isError, undefined);
  const reviewDir = path.join(client.root, "data", "review-inputs");
  assert.deepEqual(fs.readdirSync(reviewDir), []);
  const call = client.fixture.readState().calls.at(-1);
  assert.equal(call.cwd.startsWith(`${fs.realpathSync.native(reviewDir)}${path.sep}`), true);
});

test("reviews delete their non-resumable Grok session", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t, "session-json");
  const repo = path.join(client.root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "example.txt"), "changed\n");
  const result = await client.request("tools/call", {
    name: "grok_build_review",
    arguments: { cwd: repo, external_disclosure_acknowledged: true }
  });
  assert.equal(result.isError, undefined);
  const deleteCall = client.fixture.readState().calls.find((call) => call.args.includes("sessions"));
  assert.deepEqual(deleteCall.args.slice(-3), ["sessions", "delete", "019f5958-0af0-7822-be86-dc675dec62b0"]);
});

test("tools/call reports invalid tool input as an error", { timeout: 10000 }, async (t) => {
  const client = await startMcpServer(t);
  const result = await client.request("tools/call", {
    name: "grok_build_prompt",
    arguments: { prompt: "missing cwd" }
  });
  assert.equal(result.isError, true);
});

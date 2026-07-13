import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  buildReadOnlyGrokArgs,
  buildWriteGrokArgs,
  classifyGrokCompletion,
  parseGrokModelsOutput,
  runReadOnlyGrok,
  selectEffectiveModel
} from "../mcp-server/src/lib/grok-cli.mjs";
import { runProcess } from "../mcp-server/src/lib/process.mjs";
import { redactReviewContent } from "../mcp-server/src/lib/git-context.mjs";
import {
  acquireWriteLock,
  appendJobLog,
  createJob,
  listJobs,
  patchJobState,
  pruneExpiredJobs,
  recordedProcessesGone,
  releaseWriteLock,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateRoot,
  resolveWriteLockDir,
  writeJob
} from "../mcp-server/src/lib/state.mjs";
import { handler as status } from "../mcp-server/src/tools/status.mjs";
import { handler as cancel } from "../mcp-server/src/tools/cancel.mjs";
import { enqueueBackgroundJob } from "../mcp-server/src/tools/shared.mjs";
import { inputSchema as promptInputSchema } from "../mcp-server/src/tools/prompt.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

function parseContent(response) {
  return JSON.parse(response.content[0].text);
}

function withPluginData(pluginData, callback) {
  const previous = process.env.GROK_BUILD_PLUGIN_DATA;
  process.env.GROK_BUILD_PLUGIN_DATA = pluginData;
  const restore = () => {
    if (previous === undefined) delete process.env.GROK_BUILD_PLUGIN_DATA;
    else process.env.GROK_BUILD_PLUGIN_DATA = previous;
  };
  try {
    const result = callback();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("completion classification treats only EndTurn variants as success", () => {
  assert.equal(classifyGrokCompletion({ exitStatus: 0, stopReason: "EndTurn" }), "succeeded");
  assert.equal(classifyGrokCompletion({ exitStatus: 0, stopReason: "end_turn" }), "succeeded");
  assert.equal(classifyGrokCompletion({ exitStatus: 0, stopReason: "Cancelled" }), "incomplete");
  assert.equal(classifyGrokCompletion({ exitStatus: 0, stopReason: null }), "incomplete");
  assert.equal(classifyGrokCompletion({ exitStatus: 1, stopReason: null }), "failed");
});

test("model selection uses discovered IDs and never applies a hidden alias", async () => {
  const parsed = parseGrokModelsOutput("Default model: grok-build\n\nAvailable models:\n  * grok-build (default)");
  assert.deepEqual(parsed.models, ["grok-build"]);
  assert.equal(selectEffectiveModel({ explicitModel: null, envModel: null, availableModels: parsed.models, defaultModel: parsed.defaultModel }).model, "grok-build");
  assert.throws(
    () => selectEffectiveModel({ explicitModel: "grok-4.5", envModel: null, availableModels: parsed.models, defaultModel: parsed.defaultModel }),
    /unavailable.*grok-build/i
  );

  const calls = [];
  await assert.rejects(
    runReadOnlyGrok({
      cwd: "/tmp/model-selection",
      prompt: "inspect",
      model: "grok-4.5",
      runProcessImpl: async (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "Default model: grok-build\n  * grok-build (default)", stderr: "", error: null, pid: 123 };
      }
    }),
    /unavailable.*grok-build/i
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes("models"), true);

  await assert.rejects(
    runReadOnlyGrok({
      cwd: "/tmp/model-probe-failure",
      prompt: "inspect",
      model: "unverified-model",
      runProcessImpl: async () => ({ status: 1, stdout: "", stderr: "probe failed", error: null, pid: 123 })
    }),
    /Unable to verify requested Grok model.*probe failed/
  );
});

test("review content redacts embedded credentials in ordinary files", () => {
  const input = "const apiKey = 'xai-secret-value-123456789';\nAuthorization: Bearer abcdefghijklmnop";
  const result = redactReviewContent(input);
  assert.equal(result.redactedMatches, 2);
  assert.doesNotMatch(result.content, /secret-value|abcdefghijklmnop/);
});

test("local tool timeouts are capped at one hour", () => {
  assert.equal(promptInputSchema.safeParse({ cwd: "/tmp", prompt: "ok", timeout_ms: 3_600_000 }).success, true);
  assert.equal(promptInputSchema.safeParse({ cwd: "/tmp", prompt: "too long", timeout_ms: 3_600_001 }).success, false);
});

test("Grok argv disables ambient features and constrains each execution mode", () => {
  const common = {
    cwd: "/tmp/repo",
    prompt: "inspect",
    model: null,
    sessionId: null,
    resumeSessionId: null,
    effort: null,
    maxTurns: null,
    jsonSchema: null
  };
  const readArgs = buildReadOnlyGrokArgs(common);
  const writeArgs = buildWriteGrokArgs(common);
  for (const args of [readArgs, writeArgs]) {
    assert.equal(args.includes("--no-memory"), true);
    assert.equal(args.includes("--no-subagents"), true);
    assert.equal(args.includes("--disable-web-search"), true);
    assert.deepEqual(args.slice(args.indexOf("--disallowed-tools"), args.indexOf("--disallowed-tools") + 2), [
      "--disallowed-tools",
      "WebSearch,WebFetch,Task"
    ]);
    assert.equal(args.includes("Bash(git push *)"), true);
    assert.equal(args.includes("Bash(curl *)"), true);
  }
  assert.deepEqual(readArgs.slice(readArgs.indexOf("--tools"), readArgs.indexOf("--tools") + 2), ["--tools", "Read,Grep,Glob"]);
  assert.deepEqual(writeArgs.slice(writeArgs.indexOf("--tools"), writeArgs.indexOf("--tools") + 2), ["--tools", "Read,Grep,Glob,Edit,Bash"]);
  assert.deepEqual(writeArgs.slice(writeArgs.indexOf("--permission-mode"), writeArgs.indexOf("--permission-mode") + 2), ["--permission-mode", "dontAsk"]);
  assert.equal(readArgs.includes("Glob(.*)"), true);
  assert.equal(writeArgs.includes("Read(**/.*)"), true);
  assert.equal(writeArgs.includes("Edit(**/.*)"), true);
  assert.equal(writeArgs.includes("Bash(head *)"), true);
  assert.equal(writeArgs.includes("Bash(node --test *)"), true);
  assert.equal(writeArgs.includes("--always-approve"), false);
});

test("runProcess caps captured output and terminates the child", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
    detached: true,
    maxOutputBytes: 128
  });
  assert.equal(result.error?.code, "OUTPUT_LIMIT_EXCEEDED");
  assert.equal(result.error?.stream, "stdout");
  assert.equal(Buffer.byteLength(result.stdout), 128);
});

test("state defaults are per-user and respect explicit overrides", () => {
  assert.equal(resolveStateRoot({ GROK_BUILD_PLUGIN_DATA: "/custom/state" }, "linux"), "/custom/state");
  assert.equal(resolveStateRoot({ XDG_STATE_HOME: "/xdg" }, "linux"), "/xdg/grok-build-mcp");
  assert.match(resolveStateRoot({}, "darwin"), /Library\/Application Support\/grok-build-mcp$/);
  assert.match(resolveStateRoot({}, "linux"), /\.local\/state\/grok-build-mcp$/);
});

test("active jobs with no recorded child PID fail closed", () => {
  assert.equal(recordedProcessesGone({ status: "running", grokPid: null, workerPid: null, pid: null }), false);
  assert.equal(recordedProcessesGone({ status: "cancelling", grokPid: null, workerPid: null, pid: null }), false);
  assert.equal(recordedProcessesGone({ status: "failed", grokPid: null, workerPid: null, pid: null }), true);
});

test("cancelling an empty-PID writer retains its write lock", async () => {
  const root = makeTempDir("grok-empty-pid-cancel-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "state");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  await withPluginData(data, async () => {
    const job = createJob("task", repo, { request: { write: true } });
    acquireWriteLock(repo, job.id);
    writeJob(repo, {
      ...job,
      status: "running",
      request: { write: true },
      grokPid: null,
      workerPid: null,
      pid: null,
      controllerPid: process.pid
    });
    const response = await cancel({ cwd: repo, job_id: job.id });
    assert.equal(response.isError, true);
    assert.match(parseContent(response).error, /no killable process PID/);
    assert.equal(listJobs(repo).find((entry) => entry.id === job.id)?.status, "cancelling");
    assert.throws(() => acquireWriteLock(repo, "second-writer"), /already active|stale ownership lease/i);
    releaseWriteLock(repo, job.id);
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("job state, logs, and lock owners use private modes", { skip: process.platform === "win32" }, () => {
  const root = makeTempDir("grok-private-state-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    withPluginData(data, () => {
      const job = writeJob(repo, createJob("task", repo, { request: { prompt: "sensitive" } }));
      appendJobLog(repo, job.id, "private log");
      acquireWriteLock(repo, job.id);
      const mode = (filePath) => fs.statSync(filePath).mode & 0o777;
      assert.equal(mode(data), 0o700);
      assert.equal(mode(resolveJobsDir(repo)), 0o700);
      assert.equal(mode(resolveJobFile(repo, job.id)), 0o600);
      assert.equal(mode(resolveJobLogFile(repo, job.id)), 0o600);
      assert.equal(mode(resolveWriteLockDir(repo)), 0o700);
      assert.equal(mode(path.join(resolveWriteLockDir(repo), "owner.json")), 0o600);
      releaseWriteLock(repo, job.id);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dead queued worker lock is reclaimed", () => {
  const root = makeTempDir("grok-stale-lock-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    withPluginData(data, () => {
      const stale = writeJob(repo, createJob("task", repo, { workerPid: 2147483647 }));
      acquireWriteLock(repo, stale.id);
      const replacement = writeJob(repo, createJob("task", repo));
      acquireWriteLock(repo, replacement.id);
      const owner = JSON.parse(fs.readFileSync(path.join(resolveWriteLockDir(repo), "owner.json"), "utf8"));
      assert.equal(owner.jobId, replacement.id);
      releaseWriteLock(repo, replacement.id);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("synchronous background spawn failure records failure and releases the write lock", async () => {
  const root = makeTempDir("grok-spawn-failure-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    await withPluginData(data, async () => {
      await assert.rejects(() => enqueueBackgroundJob(repo, "task", {
        cwd: repo,
        write: true,
        prompt: "bounded write",
        summary: "spawn failure"
      }, {
        spawnImpl() {
          throw new Error("worker spawn failed");
        }
      }), /worker spawn failed/);
      const [job] = listJobs(repo);
      assert.equal(job.status, "failed");
      assert.match(job.errorMessage, /worker spawn failed/);
      assert.equal(fs.existsSync(resolveWriteLockDir(repo)), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asynchronous background spawn failure records failure and releases the write lock", async () => {
  const root = makeTempDir("grok-async-spawn-failure-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    await withPluginData(data, async () => {
      await assert.rejects(() => enqueueBackgroundJob(repo, "task", {
        cwd: repo,
        write: true,
        prompt: "bounded write",
        summary: "async spawn failure"
      }, {
        spawnImpl() {
          const child = /** @type {import("node:child_process").ChildProcess} */ (/** @type {unknown} */ (new EventEmitter()));
          child.unref = () => child;
          queueMicrotask(() => child.emit("error", new Error("async worker spawn failed")));
          return child;
        }
      }), /async worker spawn failed/);
      const [job] = listJobs(repo);
      assert.equal(job.status, "failed");
      assert.equal(fs.existsSync(resolveWriteLockDir(repo)), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completed current-state jobs are pruned only by explicit maintenance", () => {
  const root = makeTempDir("grok-retention-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    withPluginData(data, () => {
      const expired = writeJob(repo, createJob("task", repo, {
        status: "succeeded",
        completedAt: "2020-01-01T00:00:00.000Z"
      }));
      appendJobLog(repo, expired.id, "expired");
      assert.equal(listJobs(repo).some((job) => job.id === expired.id), true);
      pruneExpiredJobs(repo);
      assert.equal(listJobs(repo).some((job) => job.id === expired.id), false);
      assert.equal(fs.existsSync(resolveJobFile(repo, expired.id)), false);
      assert.equal(fs.existsSync(resolveJobLogFile(repo, expired.id)), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status redacts prompts, results, paths, and internal tokens", async () => {
  const root = makeTempDir("grok-redacted-status-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    await withPluginData(data, async () => {
      const job = writeJob(repo, createJob("task", repo, {
        status: "succeeded",
        summary: "safe summary",
        request: { prompt: "secret prompt" },
        result: { text: "secret result" },
        logFile: "/secret/log/path",
        writeToken: "internal-token"
      }));
      const body = parseContent(await status({ cwd: repo, job_id: job.id }));
      const serialized = JSON.stringify(body);
      assert.equal(body.status, "succeeded");
      assert.equal(body.summary, "safe summary");
      assert.doesNotMatch(serialized, /secret prompt|secret result|secret\/log|internal-token/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the npm binary points at the portable launcher", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../mcp-server/package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.bin["grok-build-mcp"], "bin/grok-build-mcp");
});

test("invalid or filename-mismatched state records are ignored", () => {
  const root = makeTempDir("grok-invalid-state-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    withPluginData(data, () => {
      const valid = writeJob(repo, createJob("task", repo));
      fs.writeFileSync(
        path.join(resolveJobsDir(repo), "grok-task-mismatch-record.json"),
        JSON.stringify({ ...valid, id: "../../outside", status: "succeeded", completedAt: "2020-01-01T00:00:00.000Z" })
      );
      fs.writeFileSync(path.join(resolveJobsDir(repo), "unrelated.json"), "not json");
      assert.deepEqual(listJobs(repo).map((job) => job.id), [valid.id]);
      pruneExpiredJobs(repo);
      assert.equal(fs.existsSync(path.join(resolveJobsDir(repo), "grok-task-mismatch-record.json")), true);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation marks an expired worker lease orphaned after its recorded pid is gone", async () => {
  const root = makeTempDir("grok-expired-lease-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    await withPluginData(data, async () => {
      const job = writeJob(repo, createJob("task", repo, {
        status: "running",
        request: { background: true, write: false },
        workerPid: 2147483647,
        pid: 2147483647,
        workerHeartbeatAt: "2020-01-01T00:00:00.000Z"
      }));
      const body = parseContent(await cancel({ cwd: repo, job_id: job.id }));
      assert.equal(body.status, "orphaned");
      assert.equal(listJobs(repo).find((entry) => entry.id === job.id)?.status, "orphaned");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale lease with a live process cannot be reclaimed by another writer", () => {
  const root = makeTempDir("grok-stale-live-lock-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    withPluginData(data, () => {
      const stale = writeJob(repo, createJob("task", repo, {
        status: "running",
        request: { background: true, write: true },
        workerPid: process.pid,
        workerHeartbeatAt: "2020-01-01T00:00:00.000Z"
      }));
      acquireWriteLock(repo, stale.id);
      const replacement = writeJob(repo, createJob("task", repo));
      assert.throws(() => acquireWriteLock(repo, replacement.id), /stale ownership lease but a live process/);
      releaseWriteLock(repo, stale.id);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent field patches preserve both heartbeat and Grok pid", async () => {
  const root = makeTempDir("grok-state-merge-");
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  try {
    await withPluginData(data, async () => {
      const job = writeJob(repo, createJob("task", repo, { status: "running" }));
      await Promise.all([
        patchJobState(repo, job.id, "running", () => ({ grokPid: 424242 })),
        patchJobState(repo, job.id, "running", () => ({ workerHeartbeatAt: "2026-01-01T00:00:00.000Z" }))
      ]);
      const current = listJobs(repo).find((entry) => entry.id === job.id);
      assert.equal(current.grokPid, 424242);
      assert.equal(current.workerHeartbeatAt, "2026-01-01T00:00:00.000Z");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

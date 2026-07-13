import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { isProcessAlive } from "../mcp-server/src/lib/process.mjs";
import { acquireWriteLock, createJob, releaseWriteLock, writeJob } from "../mcp-server/src/lib/state.mjs";
import { handler as cancel } from "../mcp-server/src/tools/cancel.mjs";
import { handler as result } from "../mcp-server/src/tools/result.mjs";
import { handler as status } from "../mcp-server/src/tools/status.mjs";
import { handler as task } from "../mcp-server/src/tools/task.mjs";

function parseContent(response) {
  return JSON.parse(response.content[0].text);
}

async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withEnvironment(changes, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeContext(behavior = "delayed") {
  const root = makeTempDir("grok-job-lifecycle-");
  const cwd = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(cwd);
  fs.mkdirSync(binDir);
  initGitRepo(cwd);
  installFakeGrok(binDir, behavior);
  return { root, cwd, env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, GROK_BUILD_PLUGIN_DATA: dataDir } };
}

test("a background task can be polled and its stored result retrieved", { timeout: 10000 }, async () => {
  const context = makeContext();
  try {
    await withEnvironment(context.env, async () => {
      const queued = parseContent(await task({ cwd: context.cwd, task: "Inspect the workspace", background: true }));
      assert.equal(queued.status, "queued");
      assert.match(queued.job_id, /^grok-task-/);
      const running = await waitFor(async () => {
        const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
        return current.status === "running" && typeof current.pid === "number" ? current : null;
      }, "background worker start");
      const terminal = await waitFor(async () => {
        const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
        return current.status === "succeeded" ? current : null;
      }, "background task completion");
      assert.equal(terminal.stopReason, "EndTurn");
      const stored = parseContent(await result({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(stored.status, "succeeded");
      assert.equal(stored.result.stop_reason, "EndTurn");
      await waitFor(() => !isProcessAlive(running.pid), "background worker exit");
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("cancelling a running background task stores cancellation and ends its process", { timeout: 10000 }, async () => {
  const context = makeContext("slow-delayed");
  try {
    await withEnvironment(context.env, async () => {
      const queued = parseContent(await task({ cwd: context.cwd, task: "Wait for cancellation", background: true }));
      const running = await waitFor(async () => {
        const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
        return current.status === "running" && typeof current.grokPid === "number" ? current : null;
      }, "running Grok process");
      const cancelled = parseContent(await cancel({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
      await waitFor(() => !isProcessAlive(running.grokPid), "cancelled process exit");
      await waitFor(() => !isProcessAlive(running.pid), "cancelled worker exit");
      const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(current.status, "cancelled");
      const stored = parseContent(await result({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(stored.status, "cancelled");
      assert.match(stored.error, /Cancelled by user/);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("immediate cancellation uses the persisted worker pid before grokPid is required", { timeout: 10000 }, async () => {
  const context = makeContext("slow-delayed");
  try {
    await withEnvironment(context.env, async () => {
      const queued = parseContent(await task({ cwd: context.cwd, task: "Cancel immediately", background: true }));
      const initial = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(typeof initial.pid, "number");
      const cancelled = parseContent(await cancel({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(cancelled.status, "cancelled");
      await waitFor(() => !isProcessAlive(initial.pid), "immediately cancelled worker exit");
      const stored = parseContent(await result({ cwd: context.cwd, job_id: queued.job_id }));
      assert.equal(stored.status, "cancelled");
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("requesting the result of a running job returns guidance", { timeout: 10000 }, async () => {
  const context = makeContext("slow-delayed");
  try {
    await withEnvironment(context.env, async () => {
      const queued = parseContent(await task({ cwd: context.cwd, task: "Remain active", background: true }));
      const running = await waitFor(async () => {
        const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
        return current.status === "running" && typeof current.pid === "number" ? current : null;
      }, "running status");
      const response = await result({ cwd: context.cwd, job_id: queued.job_id });
      assert.equal(response.isError, true);
      assert.match(parseContent(response).error, /still running; check grok_build_status/);
      await cancel({ cwd: context.cwd, job_id: queued.job_id });
      await waitFor(() => !isProcessAlive(running.pid), "cancelled worker exit");
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("status listing includes a running job with liveness", { timeout: 10000 }, async () => {
  const context = makeContext("slow-delayed");
  try {
    await withEnvironment(context.env, async () => {
      const queued = parseContent(await task({ cwd: context.cwd, task: "List this job", background: true }));
      const listedJob = await waitFor(async () => {
        const jobs = parseContent(await status({ cwd: context.cwd }));
        return jobs.find((job) => job.id === queued.job_id && job.status === "running" && job.liveness === "alive") ?? null;
      }, "listed running job with liveness");
      assert.equal(listedJob.liveness, "alive");
      await cancel({ cwd: context.cwd, job_id: queued.job_id });
      await waitFor(() => !isProcessAlive(listedJob.pid), "cancelled worker exit");
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("a cancelling writer retains its lock until stubborn processes are dead", { timeout: 15000 }, async () => {
  const context = makeContext("ignore-term-write");
  try {
    await withEnvironment({ ...context.env, GROK_BUILD_ALLOW_WRITE: "true" }, async () => {
      const queued = parseContent(await task({ cwd: context.cwd, task: "Hold the write lock", write: true, background: true }));
      await waitFor(async () => {
        const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
        return current.status === "running" && typeof current.grokPid === "number" ? current : null;
      }, "running stubborn writer");
      const cancellingPromise = cancel({ cwd: context.cwd, job_id: queued.job_id });
      await waitFor(async () => {
        const current = parseContent(await status({ cwd: context.cwd, job_id: queued.job_id }));
        return current.status === "cancelling" ? current : null;
      }, "cancelling writer");
      const overlapping = await task({ cwd: context.cwd, task: "Do not overlap", write: true });
      assert.equal(overlapping.isError, true);
      assert.match(parseContent(overlapping).error, /write task is already active/);
      const cancelled = parseContent(await cancellingPromise);
      assert.equal(cancelled.status, "cancelled");
      const replacement = writeJob(context.cwd, createJob("task", context.cwd));
      acquireWriteLock(context.cwd, replacement.id);
      releaseWriteLock(context.cwd, replacement.id);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

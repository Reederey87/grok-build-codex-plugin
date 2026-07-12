import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  acquireWriteLock,
  createJob,
  listJobs as listGrokJobs,
  releaseWriteLock,
  resolveJobsDir,
  resolveWriteLockDir,
  writeJob
} from "../mcp-server/src/lib/state.mjs";
import { resolveWorkspace } from "../mcp-server/src/lib/workspace.mjs";

delete process.env.GROK_BUILD_PLUGIN_DATA;

function realpath(p) {
  return fs.realpathSync.native(p);
}

function makeLinkedWorktreePair() {
  const main = makeTempDir("state-main-");
  initGitRepo(main);
  fs.writeFileSync(path.join(main, "README.md"), "main\n");
  run("git", ["add", "README.md"], { cwd: main });
  run("git", ["commit", "-m", "init"], { cwd: main });
  const worktree = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  const add = run("git", ["worktree", "add", worktree, "HEAD"], { cwd: main });
  assert.equal(add.status, 0, add.stderr + add.stdout);
  return {
    main: realpath(main),
    worktree: realpath(worktree),
    dispose() {
      run("git", ["worktree", "remove", "--force", worktree], { cwd: main });
    }
  };
}

test("grok jobs created in a linked worktree are visible from the main checkout and vice versa", () => {
  const pluginData = makeTempDir("grok-plugin-data-");
  const previous = process.env.GROK_BUILD_PLUGIN_DATA;
  process.env.GROK_BUILD_PLUGIN_DATA = pluginData;
  const pair = makeLinkedWorktreePair();
  try {
    const fromWorktree = writeJob(pair.worktree, createJob("task", pair.worktree, { summary: "from-wt" }));
    const fromMain = writeJob(pair.main, createJob("ask", pair.main, { summary: "from-main" }));

    const listedFromMain = listGrokJobs(pair.main);
    const listedFromWorktree = listGrokJobs(pair.worktree);
    const idsFromMain = listedFromMain.map((job) => job.id).sort();
    const idsFromWorktree = listedFromWorktree.map((job) => job.id).sort();

    assert.deepEqual(idsFromMain, [fromMain.id, fromWorktree.id].sort());
    assert.deepEqual(idsFromWorktree, idsFromMain);
    assert.equal(resolveJobsDir(pair.main), resolveJobsDir(pair.worktree));
    assert.equal(fromWorktree.workspaceRoot, fromMain.workspaceRoot);
    assert.equal(realpath(fromWorktree.worktreeRoot), pair.worktree);
    assert.equal(realpath(fromMain.worktreeRoot), pair.main);
  } finally {
    pair.dispose();
    if (previous == null) {
      delete process.env.GROK_BUILD_PLUGIN_DATA;
    } else {
      process.env.GROK_BUILD_PLUGIN_DATA = previous;
    }
  }
});

test("grok write locks are distinct across linked worktrees", () => {
  const pluginData = makeTempDir("grok-lock-data-");
  const previous = process.env.GROK_BUILD_PLUGIN_DATA;
  process.env.GROK_BUILD_PLUGIN_DATA = pluginData;
  const pair = makeLinkedWorktreePair();
  try {
    const mainJob = writeJob(pair.main, createJob("task", pair.main));
    const wtJob = writeJob(pair.worktree, createJob("task", pair.worktree));

    const mainLock = resolveWriteLockDir(pair.main);
    const wtLock = resolveWriteLockDir(pair.worktree);
    assert.notEqual(mainLock, wtLock);
    assert.equal(path.dirname(mainLock), resolveJobsDir(pair.main));
    assert.equal(path.dirname(wtLock), resolveJobsDir(pair.worktree));

    acquireWriteLock(pair.main, mainJob.id);
    acquireWriteLock(pair.worktree, wtJob.id);
    assert.equal(fs.existsSync(mainLock), true);
    assert.equal(fs.existsSync(wtLock), true);

    releaseWriteLock(pair.main, mainJob.id);
    releaseWriteLock(pair.worktree, wtJob.id);
  } finally {
    pair.dispose();
    if (previous == null) {
      delete process.env.GROK_BUILD_PLUGIN_DATA;
    } else {
      process.env.GROK_BUILD_PLUGIN_DATA = previous;
    }
  }
});

test("grok listJobs merges legacy worktree-keyed job files without modifying them", () => {
  const pluginData = makeTempDir("grok-legacy-data-");
  const previous = process.env.GROK_BUILD_PLUGIN_DATA;
  process.env.GROK_BUILD_PLUGIN_DATA = pluginData;
  const pair = makeLinkedWorktreePair();
  try {
    const legacyHash = createHash("sha256").update(pair.worktree).digest("hex").slice(0, 32);
    const legacyDir = path.join(pluginData, "jobs", legacyHash);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyJob = {
      id: "grok-task-legacy01-aaaaaaaa",
      kind: "task",
      workspaceRoot: pair.worktree,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: "legacy-only"
    };
    const legacyFile = path.join(legacyDir, `${legacyJob.id}.json`);
    fs.writeFileSync(legacyFile, `${JSON.stringify(legacyJob, null, 2)}\n`, "utf8");
    const before = fs.readFileSync(legacyFile, "utf8");
    const mtimeBefore = fs.statSync(legacyFile).mtimeMs;

    // Shared-root write from main; listing from the worktree must merge legacy (worktree-keyed) files.
    const sharedJob = writeJob(pair.main, createJob("ask", pair.main, { summary: "shared" }));
    const listed = listGrokJobs(pair.worktree);
    const ids = listed.map((job) => job.id).sort();
    assert.deepEqual(ids, [legacyJob.id, sharedJob.id].sort());
    // Shared jobs dir differs from legacy for a linked worktree.
    assert.notEqual(resolveJobsDir(pair.worktree), legacyDir);

    assert.equal(fs.readFileSync(legacyFile, "utf8"), before);
    assert.equal(fs.statSync(legacyFile).mtimeMs, mtimeBefore);
    assert.equal(fs.existsSync(legacyFile), true);
  } finally {
    pair.dispose();
    if (previous == null) {
      delete process.env.GROK_BUILD_PLUGIN_DATA;
    } else {
      process.env.GROK_BUILD_PLUGIN_DATA = previous;
    }
  }
});

test("non-worktree repos keep the same grok jobs dir key as before (shared === toplevel)", () => {
  const pluginData = makeTempDir("grok-key-stable-");
  const previous = process.env.GROK_BUILD_PLUGIN_DATA;
  process.env.GROK_BUILD_PLUGIN_DATA = pluginData;
  const cwd = makeTempDir("plain-repo-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "1\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  try {
    const sharedDir = resolveJobsDir(cwd);
    const legacyHash = createHash("sha256").update(resolveWorkspace(cwd)).digest("hex").slice(0, 32);
    const expectedLegacy = path.join(pluginData, "jobs", legacyHash);
    assert.equal(sharedDir, expectedLegacy);
  } finally {
    if (previous == null) {
      delete process.env.GROK_BUILD_PLUGIN_DATA;
    } else {
      process.env.GROK_BUILD_PLUGIN_DATA = previous;
    }
  }
});

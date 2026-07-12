import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  listJobs as listCodexJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  acquireWriteLock,
  createJob,
  listJobs as listGrokJobs,
  releaseWriteLock,
  resolveJobsDir,
  resolveWriteLockDir,
  writeJob
} from "../plugins/grok/scripts/lib/state.mjs";
import { resolveWorkspace } from "../plugins/grok/scripts/lib/workspace.mjs";
import { ensureGitRepository } from "../plugins/codex/scripts/lib/git.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
delete process.env.CODEX_COMPANION_TRANSCRIPT_PATH;

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

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("grok jobs created in a linked worktree are visible from the main checkout and vice versa", () => {
  const pluginData = makeTempDir("grok-plugin-data-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
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
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("grok write locks are distinct across linked worktrees", () => {
  const pluginData = makeTempDir("grok-lock-data-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
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
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("grok listJobs merges legacy worktree-keyed job files without modifying them", () => {
  const pluginData = makeTempDir("grok-legacy-data-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
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
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("codex jobs created in a linked worktree are visible from the main checkout", () => {
  const pluginData = makeTempDir("codex-plugin-data-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  const pair = makeLinkedWorktreePair();
  try {
    upsertJob(pair.worktree, {
      id: "job-from-wt",
      status: "completed",
      kind: "task",
      summary: "worktree job"
    });
    upsertJob(pair.main, {
      id: "job-from-main",
      status: "completed",
      kind: "review",
      summary: "main job"
    });

    assert.equal(resolveStateDir(pair.main), resolveStateDir(pair.worktree));
    const fromMain = listCodexJobs(pair.main).map((job) => job.id).sort();
    const fromWorktree = listCodexJobs(pair.worktree).map((job) => job.id).sort();
    assert.deepEqual(fromMain, ["job-from-main", "job-from-wt"]);
    assert.deepEqual(fromWorktree, fromMain);
  } finally {
    pair.dispose();
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("codex loadState reads legacy show-toplevel-keyed state without modifying it", () => {
  const pluginData = makeTempDir("codex-legacy-data-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  const pair = makeLinkedWorktreePair();
  try {
    const legacyHash = createHash("sha256").update(pair.worktree).digest("hex").slice(0, 16);
    const slug = path.basename(pair.worktree).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
    const legacyDir = path.join(pluginData, "state", `${slug}-${legacyHash}`);
    fs.mkdirSync(path.join(legacyDir, "jobs"), { recursive: true });
    const legacyState = {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "legacy-job-1",
          status: "completed",
          kind: "task",
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    };
    const legacyFile = path.join(legacyDir, "state.json");
    fs.writeFileSync(legacyFile, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
    const before = fs.readFileSync(legacyFile, "utf8");
    const mtimeBefore = fs.statSync(legacyFile).mtimeMs;

    // Shared-root state dir has no state.json; listing from the worktree should surface legacy jobs.
    assert.equal(fs.existsSync(resolveStateFile(pair.worktree)), false);
    const jobs = listCodexJobs(pair.worktree);
    assert.deepEqual(
      jobs.map((job) => job.id),
      ["legacy-job-1"]
    );

    assert.equal(fs.readFileSync(legacyFile, "utf8"), before);
    assert.equal(fs.statSync(legacyFile).mtimeMs, mtimeBefore);
  } finally {
    pair.dispose();
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("non-worktree repos keep the same grok jobs dir key as before (shared === toplevel)", () => {
  const pluginData = makeTempDir("grok-key-stable-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
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
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("non-worktree repos keep the same codex state dir key as before (shared === toplevel)", () => {
  const pluginData = makeTempDir("codex-key-stable-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  const cwd = makeTempDir("plain-repo-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "1\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  try {
    const toplevel = ensureGitRepository(cwd);
    const canonical = fs.realpathSync.native(toplevel);
    const slug = path.basename(toplevel).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const expectedLegacy = path.join(pluginData, "state", `${slug}-${hash}`);
    assert.equal(resolveStateDir(cwd), expectedLegacy);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

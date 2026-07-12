import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { getGitRepositoryRoot, getSharedRepoRoot } from "../mcp-server/src/lib/workspace.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function realpath(p) {
  return fs.realpathSync.native(p);
}

test("getSharedRepoRoot matches show-toplevel on a normal checkout", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const shared = realpath(getSharedRepoRoot(cwd));
  const toplevel = realpath(getGitRepositoryRoot(cwd));

  assert.equal(shared, toplevel);
});

test("getSharedRepoRoot from a linked worktree returns the main root", () => {
  const main = makeTempDir("shared-main-");
  initGitRepo(main);
  fs.writeFileSync(path.join(main, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd: main });
  run("git", ["commit", "-m", "init"], { cwd: main });

  const worktree = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  const add = run("git", ["worktree", "add", worktree, "HEAD"], { cwd: main });
  assert.equal(add.status, 0, add.stderr + add.stdout);

  try {
    const mainRoot = realpath(main);
    assert.equal(realpath(getSharedRepoRoot(worktree)), mainRoot);
    assert.equal(realpath(getGitRepositoryRoot(worktree)), realpath(worktree));
    assert.notEqual(realpath(getGitRepositoryRoot(worktree)), mainRoot);
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], { cwd: main });
  }
});

test("getSharedRepoRoot falls back for bare repositories", () => {
  const bare = makeTempDir("shared-bare-");
  const init = run("git", ["init", "--bare", "-b", "main"], { cwd: bare });
  assert.equal(init.status, 0, init.stderr);

  // Bare repos have no worktree; shared root should not throw and should return a path.
  const root = getSharedRepoRoot(bare);
  assert.equal(typeof root, "string");
  assert.ok(root.length > 0);
});

test("getSharedRepoRoot throws outside a git repository", () => {
  const cwd = makeTempDir("not-git-");
  assert.throws(() => getSharedRepoRoot(cwd), /Git repository/i);
});

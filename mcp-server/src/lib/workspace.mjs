import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

export function canonicalDirectory(cwd) {
  const resolved = path.resolve(cwd);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved}`);
  }
  return fs.realpathSync.native(resolved);
}

export function getGitRepositoryRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return canonicalDirectory(result.stdout.trim());
}

/**
 * Shared repo root across linked worktrees (dirname of git-common-dir).
 * For a normal checkout this matches getGitRepositoryRoot; for a linked worktree
 * it returns the main worktree root so job state can be shared.
 */
export function getSharedRepoRoot(cwd) {
  const canonicalCwd = canonicalDirectory(cwd);

  const bareResult = runCommand("git", ["rev-parse", "--is-bare-repository"], { cwd: canonicalCwd });
  const bareErrorCode = bareResult.error && "code" in bareResult.error ? bareResult.error.code : null;
  if (bareErrorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (bareResult.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  if (bareResult.stdout.trim() === "true") {
    try {
      return getGitRepositoryRoot(canonicalCwd);
    } catch {
      return canonicalCwd;
    }
  }

  const absoluteCommon = runCommand(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: canonicalCwd }
  );
  if (absoluteCommon.status === 0) {
    return path.dirname(canonicalDirectory(absoluteCommon.stdout.trim()));
  }

  // Older git without --path-format=absolute
  const plainCommon = runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: canonicalCwd });
  if (plainCommon.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return path.dirname(canonicalDirectory(path.resolve(canonicalCwd, plainCommon.stdout.trim())));
}

export function resolveWorkspace(cwd, options = {}) {
  const canonicalCwd = canonicalDirectory(cwd);
  if (options.requireGit) {
    return getGitRepositoryRoot(canonicalCwd);
  }
  try {
    return getGitRepositoryRoot(canonicalCwd);
  } catch {
    return canonicalCwd;
  }
}

/** Like resolveWorkspace, but keys state by the shared main-repo root across worktrees. */
export function resolveSharedWorkspace(cwd, options = {}) {
  const canonicalCwd = canonicalDirectory(cwd);
  if (options.requireGit) {
    return getSharedRepoRoot(canonicalCwd);
  }
  try {
    return getSharedRepoRoot(canonicalCwd);
  } catch {
    return canonicalCwd;
  }
}

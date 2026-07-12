import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";
import { getGitRepositoryRoot } from "./workspace.mjs";

const MAX_DIFF_BYTES = 128 * 1024;
const SENSITIVE_NAME = /(?:^\.|\.env(?:\.|$)|credential|secret|token|password|private|id_rsa|\.pem$|\.key$)/i;
const DIFF_SAFETY_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-renames"];

function runGit(cwd, args, options = {}) {
  const result = runCommand("git", args, { cwd, maxBuffer: options.maxBuffer });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed.`);
  }
  return result;
}

function splitNullSeparated(output) {
  return output.split("\0").filter(Boolean);
}

function isSafePath(filePath) {
  return !filePath.split(/[\\/]/).some((part) => SENSITIVE_NAME.test(part));
}

function collectFileMetadata(cwd, filePath) {
  if (!isSafePath(filePath)) {
    return `${filePath}: omitted by safety policy`;
  }
  try {
    const stat = fs.lstatSync(path.join(cwd, filePath));
    return `${filePath}: ${stat.isDirectory() ? "directory" : "file"}, ${stat.size} bytes`;
  } catch {
    return `${filePath}: unreadable metadata`;
  }
}

function boundedDiff(cwd, args) {
  const result = runCommand("git", args, { cwd, maxBuffer: MAX_DIFF_BYTES });
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOBUFS" || Buffer.byteLength(result.stdout, "utf8") >= MAX_DIFF_BYTES) {
    return "(diff omitted because it exceeds the safe inline limit; inspect only safe source files with read-only git commands)";
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed.`);
  }
  return result.stdout.trim() || "(no textual diff)";
}

function safeChangedPaths(cwd, diffArgs) {
  const values = splitNullSeparated(
    runGit(cwd, [...diffArgs, ...DIFF_SAFETY_FLAGS, "--name-status", "-z"]).stdout
  );
  const entries = [];
  for (let index = 0; index < values.length; index += 2) {
    entries.push({ status: values[index], filePath: values[index + 1] });
  }
  const hasSensitiveDeletion = entries.some(
    ({ status, filePath }) => status?.startsWith("D") && filePath && !isSafePath(filePath)
  );
  return entries
    .filter(
      ({ status, filePath }) =>
        filePath && isSafePath(filePath) && !(hasSensitiveDeletion && status?.startsWith("A"))
    )
    .map(({ filePath }) => filePath);
}

function diffForPaths(cwd, diffArgs, paths) {
  if (paths.length === 0) {
    return "(no safe changed files; sensitive or dotfile paths are intentionally excluded)";
  }
  return boundedDiff(cwd, [...diffArgs, ...DIFF_SAFETY_FLAGS, "--binary", "--", ...paths]);
}

function assertSafeRef(baseRef) {
  if (typeof baseRef !== "string" || !baseRef || baseRef.startsWith("-") || baseRef.includes("\0")) {
    throw new Error("`--base` must be a valid Git ref that does not start with `-`.");
  }
}

function workingTreeContext(repoRoot) {
  const stagedPaths = safeChangedPaths(repoRoot, ["diff", "--cached"]);
  const unstagedPaths = safeChangedPaths(repoRoot, ["diff"]);
  const untrackedPaths = splitNullSeparated(
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout
  );
  const metadata = untrackedPaths.map((filePath) => collectFileMetadata(repoRoot, filePath));
  const safeUntracked = untrackedPaths.filter(isSafePath);

  return {
    targetLabel: "working tree",
    changedFiles: [...new Set([...stagedPaths, ...unstagedPaths, ...safeUntracked])],
    content: [
      "## Scope",
      "Working tree changes, including staged and unstaged changes.",
      "",
      "## Safe changed files",
      [...new Set([...stagedPaths, ...unstagedPaths])].join("\n") || "(none)",
      "",
      "## Staged diff",
      diffForPaths(repoRoot, ["diff", "--cached"], stagedPaths),
      "",
      "## Unstaged diff",
      diffForPaths(repoRoot, ["diff"], unstagedPaths),
      "",
      "## Untracked file metadata",
      metadata.join("\n") || "(none)"
    ].join("\n")
  };
}

function branchContext(repoRoot, baseRef) {
  assertSafeRef(baseRef);
  runGit(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  runGit(repoRoot, ["merge-base", "HEAD", baseRef]);
  const range = `${baseRef}...HEAD`;
  const changedFiles = safeChangedPaths(repoRoot, ["diff", range]);
  const diffStat =
    changedFiles.length > 0
      ? runGit(repoRoot, ["diff", "--stat", ...DIFF_SAFETY_FLAGS, range, "--", ...changedFiles]).stdout.trim() || "(none)"
      : "(no safe changed files; sensitive or dotfile paths are intentionally excluded)";

  return {
    targetLabel: `branch changes against ${baseRef}`,
    changedFiles,
    content: [
      "## Scope",
      `Branch comparison: ${range}.`,
      "",
      "## Safe changed files",
      changedFiles.join("\n") || "(none)",
      "",
      "## Diff stat",
      diffStat,
      "",
      "## Branch diff",
      diffForPaths(repoRoot, ["diff", range], changedFiles)
    ].join("\n")
  };
}

export function collectReviewContext(cwd, options = {}) {
  const repoRoot = getGitRepositoryRoot(cwd);
  const scope = options.base ? "branch" : options.scope ?? "working-tree";
  if (!["working-tree", "branch", "repo"].includes(scope)) {
    throw new Error("Use --scope working-tree, branch, or repo.");
  }
  if (scope === "branch" && !options.base) {
    throw new Error("`--scope branch` requires `--base <ref>`.");
  }
  if (scope === "repo") {
    return {
      repoRoot,
      targetLabel: "repository architecture",
      changedFiles: [],
      content: "Inspect the repository architecture using only the permitted read-only tools. Do not inspect dotfiles, credentials, or secret material."
    };
  }
  const details = scope === "branch" ? branchContext(repoRoot, options.base) : workingTreeContext(repoRoot);
  return { repoRoot, ...details };
}

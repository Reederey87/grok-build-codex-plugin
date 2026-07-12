#!/usr/bin/env node

import process from "node:process";

import { readJob } from "./lib/state.mjs";
import { canonicalDirectory } from "./lib/workspace.mjs";
import { runStoredJob } from "./tools/shared.mjs";

/** @param {string[]} argv */
function parseWorkerArgs(argv) {
  /** @type {{jobId?: string, cwd?: string}} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--job-id") parsed.jobId = argv[++index];
    else if (value === "--cwd") parsed.cwd = argv[++index];
  }
  return parsed;
}

async function main() {
  const options = parseWorkerArgs(process.argv.slice(2));
  if (!options.jobId) throw new Error("Missing --job-id for background worker.");
  if (!options.cwd) throw new Error("Missing --cwd for background worker.");
  const cwd = canonicalDirectory(options.cwd);
  const job = readJob(cwd, options.jobId);
  if (!job?.request) throw new Error(`No queued Grok job found for ${options.jobId}.`);
  await runStoredJob(cwd, job);
}

main().catch((error) => {
  process.stderr.write(`grok-build worker failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

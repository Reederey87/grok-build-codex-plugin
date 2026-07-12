#!/usr/bin/env node

import process from "node:process";

import { handler as cancel } from "./tools/cancel.mjs";
import { handler as prompt } from "./tools/prompt.mjs";
import { handler as result } from "./tools/result.mjs";
import { handler as review } from "./tools/review.mjs";
import { handler as setup } from "./tools/setup.mjs";
import { handler as status } from "./tools/status.mjs";

const BOOLEAN_FLAGS = new Set([
  "all",
  "adversarial",
  "allow_api_fallback",
  "resume",
  "run_smoke_test"
]);
const NUMBER_FLAGS = new Set(["timeout_ms"]);

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string|number|boolean>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).replace(/-/g, "_");
    if (BOOLEAN_FLAGS.has(key)) {
      values[key] = true;
      continue;
    }
    const next = argv[++index];
    if (next === undefined) throw new Error(`Missing value for ${token}.`);
    values[key] = NUMBER_FLAGS.has(key) ? Number(next) : next;
  }
  return { values, positionals };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || !["setup", "prompt", "review", "status", "result", "cancel"].includes(command)) {
    throw new Error("Usage: node dev-runner.mjs setup|prompt|review|status|result|cancel [--cwd <dir>] [flags]");
  }
  const { values, positionals } = parseArgs(argv);
  if (!values.cwd) values.cwd = process.cwd();
  if (command === "prompt" && !values.prompt && positionals.length > 0) values.prompt = positionals.join(" ");
  if ((command === "result" || command === "cancel") && !values.job_id && positionals[0]) values.job_id = positionals[0];

  const response = command === "setup"
    ? await setup(values)
    : command === "prompt"
      ? await prompt(values)
      : command === "review"
        ? await review(values)
        : command === "status"
          ? await status(values)
          : command === "result"
            ? await result(values)
            : await cancel(values);
  const text = response.content.find((item) => item.type === "text")?.text ?? JSON.stringify(response);
  process.stdout.write(`${text}\n`);
  if (response.isError) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { handler as task } from "../mcp-server/src/tools/task.mjs";

function parseContent(response) {
  return JSON.parse(response.content[0].text);
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

function makeContext(behavior = "write") {
  const root = makeTempDir("grok-write-gate-");
  const cwd = path.join(root, "repo");
  const binDir = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(cwd);
  fs.mkdirSync(binDir);
  initGitRepo(cwd);
  const fixture = installFakeGrok(binDir, behavior);
  return {
    root,
    cwd,
    fixture,
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, GROK_BUILD_PLUGIN_DATA: dataDir }
  };
}

test("write mode is rejected before invoking Grok when the gate is disabled", async () => {
  const context = makeContext();
  try {
    await withEnvironment({ ...context.env, GROK_BUILD_ALLOW_WRITE: undefined }, async () => {
      const response = await task({ cwd: context.cwd, task: "Make a change", write: true });
      assert.equal(response.isError, true);
      assert.match(parseContent(response).error, /GROK_BUILD_ALLOW_WRITE/);
      assert.deepEqual(context.fixture.readState().calls, []);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("enabled write mode uses workspace sandbox and only opts into always-approve explicitly", { timeout: 10000 }, async () => {
  const context = makeContext();
  try {
    await withEnvironment({ ...context.env, GROK_BUILD_ALLOW_WRITE: "true" }, async () => {
      const first = await task({ cwd: context.cwd, task: "Make one change", write: true });
      assert.equal(first.isError, undefined);
      let call = context.fixture.readState().calls.at(-1);
      assert.deepEqual(call.args.slice(call.args.indexOf("--sandbox"), call.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace"]);
      assert.equal(call.args.includes("--always-approve"), false);

      const second = await task({ cwd: context.cwd, task: "Make another change", write: true, always_approve: true });
      assert.equal(second.isError, undefined);
      call = context.fixture.readState().calls.at(-1);
      assert.deepEqual(call.args.slice(call.args.indexOf("--sandbox"), call.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace"]);
      assert.equal(call.args.includes("--always-approve"), true);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("write mode requires a Git repository", async () => {
  const context = makeContext();
  const outside = path.join(context.root, "outside");
  fs.mkdirSync(outside);
  try {
    await withEnvironment({ ...context.env, GROK_BUILD_ALLOW_WRITE: "true" }, async () => {
      const response = await task({ cwd: outside, task: "Make a change", write: true });
      assert.equal(response.isError, true);
      assert.match(parseContent(response).error, /inside a Git repository/);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

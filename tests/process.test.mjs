import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../mcp-server/src/lib/process.mjs";

test("terminateProcessTree signals the process group with SIGTERM on non-Windows", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    killImpl(pid, signal) {
      calls.push({ pid, signal });
    }
  });

  assert.deepEqual(calls, [{ pid: -1234, signal: "SIGTERM" }]);
  assert.deepEqual(outcome, { attempted: true, delivered: true, method: "process-group" });
});

test("terminateProcessTree falls back to a single-process SIGTERM when the group kill fails", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push({ pid, signal });
      if (pid < 0) {
        throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
      }
    }
  });

  assert.deepEqual(calls, [
    { pid: -1234, signal: "SIGTERM" },
    { pid: 1234, signal: "SIGTERM" }
  ]);
  assert.deepEqual(outcome, { attempted: true, delivered: true, method: "process" });
});

test("terminateProcessTree reports an already-gone process as not delivered", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl() {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
  });

  assert.deepEqual(outcome, { attempted: true, delivered: false, method: "process" });
});

test("terminateProcessTree short-circuits for a non-finite pid", () => {
  const outcome = terminateProcessTree(Number.NaN);
  assert.deepEqual(outcome, { attempted: false, delivered: false, method: null });
});

test("terminateProcessTree uses taskkill on Windows", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    killImpl() {
      throw new Error("killImpl should not be used on Windows");
    }
  });

  // The Windows branch shells out to `taskkill` directly (no injectable command
  // runner in this port); it isn't installed on this test host, so delivery
  // fails but the attempt and method are still reported correctly.
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.delivered, false);
});

import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakeGrok(binDir, behavior = "json") {
  const statePath = path.join(binDir, "fake-grok-state.json");
  const scriptPath = path.join(binDir, "grok");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const statePath = ${JSON.stringify(statePath)};
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);

if (behavior === "ignore-term-write") {
  process.on("SIGTERM", () => {});
}

function loadState() {
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { calls: [] };
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

if (args.includes("version") || args.includes("--version")) {
  console.log("grok 0.2.93 fake");
  process.exit(0);
}

if (args.includes("inspect")) {
  const inspectState = loadState();
  inspectState.calls.push({
    args,
    cwd: process.cwd(),
    active: process.env.GROK_BUILD_COMPANION_ACTIVE || null
  });
  saveState(inspectState);
  if (behavior === "inspect-fails") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log(JSON.stringify({ authenticated: true }));
  process.exit(0);
}

if (args.includes("models")) {
  if (behavior === "inspect-fails") {
    console.error("not authenticated; run grok login");
    process.exit(1);
  }
  console.log("You are logged in with grok.com.\\n\\nDefault model: grok-4.5\\n\\nAvailable models:\\n  * grok-4.5 (default)\\n  - grok-composer-2.5-fast");
  process.exit(0);
}

const state = loadState();
state.calls.push({
  args,
  cwd: process.cwd(),
  active: process.env.GROK_BUILD_COMPANION_ACTIVE || null
});
saveState(state);

if (behavior === "failure") {
  console.error("fake Grok failure");
  process.exit(3);
}

if (args.includes("sessions")) {
  process.exit(0);
}

if (behavior === "write" || behavior === "write-sensitive" || behavior === "delayed-write" || behavior === "ignore-term-write" || behavior === "cancelled-with-edits") {
  fs.writeFileSync(path.join(process.cwd(), "grok-write.txt"), "changed by fake Grok\\n", "utf8");
}
if (behavior === "write-sensitive") {
  fs.writeFileSync(path.join(process.cwd(), ".env"), "SECRET=changed-by-fake-grok\\n", "utf8");
}

const output = behavior === "malformed-json"
  ? "not valid json"
  : behavior === "cancelled" || behavior === "cancelled-with-edits" || behavior === "max-turns"
    ? JSON.stringify({ text: "", stopReason: "Cancelled" })
    : JSON.stringify({
        text: "fake response",
        stopReason: "EndTurn",
        prompt: args[args.indexOf("-p") + 1] || null,
        ...(behavior === "session-json" ? { sessionId: "019f5958-0af0-7822-be86-dc675dec62b0" } : {})
      });

if (behavior === "max-turns") {
  console.log(output);
  console.error("Error: max turns reached");
  process.exit(1);
}

if (behavior === "delayed" || behavior === "delayed-write" || behavior === "slow-delayed" || behavior === "ignore-term-write") {
  setTimeout(() => {
    console.log(output);
  }, behavior === "ignore-term-write" ? 60_000 : behavior === "slow-delayed" ? 1500 : 250);
} else {
  console.log(output);
}
`;
  writeExecutable(scriptPath, source);
  return {
    statePath,
    readState() {
      return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { calls: [] };
    }
  };
}

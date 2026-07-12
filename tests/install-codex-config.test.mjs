import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "install-codex-config.mjs");
const LAUNCHER_PATH = path.join(ROOT, "mcp-server", "bin", "grok-build-mcp");

function configFixturePath() {
  return path.join(makeTempDir(), "config.toml");
}

function readConfig(configPath) {
  return fs.readFileSync(configPath, "utf8");
}

function install(configPath, extraArgs = []) {
  return run("node", [SCRIPT, "--config", configPath, ...extraArgs], { cwd: ROOT });
}

test("install writes the managed block into a fresh config file", () => {
  const configPath = configFixturePath();

  const result = install(configPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(configPath), true);
  const content = readConfig(configPath);
  assert.match(content, /# >>> grok-build-codex-plugin \(managed; do not edit inside\)/);
  assert.match(content, /\[mcp_servers\.grok-build\]/);
  assert.match(content, new RegExp(`args = \\["${LAUNCHER_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]`));
  assert.match(content, /env = \{ GROK_BUILD_API_FALLBACK = "false" \}/);
  assert.match(content, /# <<< grok-build-codex-plugin/);
  assert.match(result.stdout, /Installed grok-build MCP server entry/);
});

test("install is idempotent: rerunning produces exactly one managed block", () => {
  const configPath = configFixturePath();

  const first = install(configPath);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = readConfig(configPath);

  const second = install(configPath);
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = readConfig(configPath);

  assert.equal(afterSecond, afterFirst);
  const occurrences = afterSecond.match(/# >>> grok-build-codex-plugin/g) ?? [];
  assert.equal(occurrences.length, 1);
  assert.match(second.stdout, /Updated grok-build MCP server entry/);
});

test("install preserves existing unrelated config content and inserts the block after it", () => {
  const configPath = configFixturePath();
  const original = [
    "[mcp_servers.other-server]",
    'command = "/usr/bin/other"',
    ""
  ].join("\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, original);

  const result = install(configPath);

  assert.equal(result.status, 0, result.stderr);
  const content = readConfig(configPath);
  assert.match(content, /\[mcp_servers\.other-server\]/);
  assert.match(content, /command = "\/usr\/bin\/other"/);
  assert.match(content, /\[mcp_servers\.grok-build\]/);
  // Unrelated content comes before the managed block.
  assert.ok(content.indexOf("other-server") < content.indexOf("grok-build-codex-plugin"));
});

test("--remove deletes only the managed block, restoring original content exactly", () => {
  const configPath = configFixturePath();
  const original = [
    "[mcp_servers.other-server]",
    'command = "/usr/bin/other"',
    ""
  ].join("\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, original);

  const installResult = install(configPath);
  assert.equal(installResult.status, 0, installResult.stderr);

  const removeResult = install(configPath, ["--remove"]);
  assert.equal(removeResult.status, 0, removeResult.stderr);

  const content = readConfig(configPath);
  assert.equal(content, original);
  assert.match(removeResult.stdout, /Removed grok-build MCP server entry/);
});

test("--remove on a config with no managed block is a no-op", () => {
  const configPath = configFixturePath();
  const original = '[mcp_servers.other-server]\ncommand = "/usr/bin/other"\n';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, original);

  const result = install(configPath, ["--remove"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readConfig(configPath), original);
  assert.match(result.stdout, /No managed grok-build entry found/);
});

test("refuses to install when an unmanaged [mcp_servers.grok-build] section already exists", () => {
  const configPath = configFixturePath();
  const original = '[mcp_servers.grok-build]\ncommand = "/hand/written"\n';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, original);

  const result = install(configPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to modify/);
  assert.match(result.stderr, /outside the managed block/);
  assert.equal(readConfig(configPath), original, "config must be left untouched");
});

test("--dry-run prints the block and writes nothing", () => {
  const configPath = configFixturePath();
  assert.equal(fs.existsSync(configPath), false);

  const result = install(configPath, ["--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# >>> grok-build-codex-plugin \(managed; do not edit inside\)/);
  assert.match(result.stdout, /\[mcp_servers\.grok-build\]/);
  assert.equal(fs.existsSync(configPath), false, "dry-run must not create the config file");
});

test("creates the parent directory when it does not exist", () => {
  const configPath = path.join(makeTempDir(), "nested", "dir", "config.toml");
  assert.equal(fs.existsSync(path.dirname(configPath)), false);

  const result = install(configPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(configPath), true);
});

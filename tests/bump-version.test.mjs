import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture({ withPluginJson = true } = {}) {
  const root = makeTempDir();

  writeJson(path.join(root, "package.json"), {
    name: "grok-build-codex-plugin",
    version: "1.0.2"
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "grok-build-codex-plugin",
    version: "1.0.2",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "grok-build-codex-plugin",
        version: "1.0.2"
      },
      "mcp-server": {
        name: "grok-build-mcp",
        version: "1.0.2"
      }
    }
  });
  writeJson(path.join(root, "mcp-server", "package.json"), {
    name: "grok-build-mcp",
    version: "1.0.2"
  });

  if (withPluginJson) {
    writeJson(path.join(root, ".codex-plugin", "plugin.json"), {
      name: "grok-build",
      version: "1.0.2"
    });
  }

  return root;
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages["mcp-server"].version, "1.2.3");
  assert.equal(readJson(path.join(root, "mcp-server", "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".codex-plugin", "plugin.json")).version, "1.2.3");
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), {
    name: "grok-build-codex-plugin",
    version: "1.0.3"
  });

  const result = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mcp-server\/package\.json version/);
  assert.match(result.stderr, /\.codex-plugin\/plugin\.json version/);
});

test("bump-version tolerates a missing .codex-plugin/plugin.json on bump", () => {
  const root = makeVersionFixture({ withPluginJson: false });

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Skipping \.codex-plugin\/plugin\.json/);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(fs.existsSync(path.join(root, ".codex-plugin", "plugin.json")), false);
});

test("bump-version check mode passes when .codex-plugin/plugin.json is absent", () => {
  const root = makeVersionFixture({ withPluginJson: false });

  const result = run("node", [SCRIPT, "--root", root, "--check", "1.0.2"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
});

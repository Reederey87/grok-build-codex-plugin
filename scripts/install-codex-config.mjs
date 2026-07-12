#!/usr/bin/env node
// Installs an absolute-path `[mcp_servers.grok-build]` entry into the user's
// `~/.codex/config.toml`. Codex CLI 0.144.1 does not substitute `${PLUGIN_ROOT}`
// in a plugin's `.mcp.json` when the session cwd is outside the plugin checkout
// (openai/codex#22842), so `.mcp.json` alone is not reliable outside this repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const START_MARKER = "# >>> grok-build-codex-plugin (managed; do not edit inside)";
const END_MARKER = "# <<< grok-build-codex-plugin";
const UNMANAGED_HEADER_PATTERN = /^\[mcp_servers\.grok-build\]\s*$/m;

function usage() {
  return [
    "Usage:",
    "  node scripts/install-codex-config.mjs [--config <path>] [--dry-run]",
    "  node scripts/install-codex-config.mjs --remove [--config <path>]",
    "",
    "Options:",
    "  --config <path>  Path to config.toml. Defaults to $CODEX_HOME/config.toml,",
    "                   or ~/.codex/config.toml when CODEX_HOME is unset.",
    "  --remove         Delete the managed block only; leave the rest untouched.",
    "  --dry-run        Print the would-be managed block; write nothing.",
    "  --help           Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = { config: null, remove: false, dryRun: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--config requires a path.");
      }
      options.config = value;
      i += 1;
    } else if (arg === "--remove") {
      options.remove = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function resolveRepoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..");
}

function resolveConfigPath(options) {
  if (options.config) {
    return path.resolve(options.config);
  }
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    return path.join(path.resolve(codexHome), "config.toml");
  }
  return path.join(os.homedir(), ".codex", "config.toml");
}

function buildBlock(repoRoot) {
  const launcher = path.join(repoRoot, "mcp-server", "bin", "grok-build-mcp");
  const lines = [
    START_MARKER,
    "[mcp_servers.grok-build]",
    'command = "/bin/sh"',
    `args = ["${launcher}"]`,
    'env = { GROK_BUILD_API_FALLBACK = "false" }',
    END_MARKER
  ];
  return `${lines.join("\n")}\n`;
}

function readConfig(configPath) {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * Strips the managed block (and the single blank separator line before it, if
 * present) from `content`. Returns the cleaned content and whether a block was
 * found, so install/remove can share the same parsing logic.
 */
function stripManagedBlock(content) {
  if (content.length === 0) {
    return { content, found: false };
  }

  const lines = content.split("\n");
  const startIdx = lines.indexOf(START_MARKER);
  if (startIdx === -1) {
    return { content, found: false };
  }
  const endIdx = lines.indexOf(END_MARKER, startIdx);
  if (endIdx === -1) {
    return { content, found: false };
  }

  const removeStart = startIdx > 0 && lines[startIdx - 1] === "" ? startIdx - 1 : startIdx;
  const newLines = [...lines.slice(0, removeStart), ...lines.slice(endIdx + 1)];
  return { content: newLines.join("\n"), found: true };
}

function insertManagedBlock(content, block) {
  if (content.length === 0) {
    return block;
  }
  const normalized = content.replace(/\n*$/, "\n");
  return `${normalized}\n${block}`;
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

function assertNoUnmanagedSection(cleanedContent, configPath) {
  if (UNMANAGED_HEADER_PATTERN.test(cleanedContent)) {
    throw new Error(
      `Refusing to modify ${configPath}: it already has a [mcp_servers.grok-build] section ` +
        "outside the managed block. Remove or rename it, then rerun this script."
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const repoRoot = resolveRepoRoot();
  const configPath = resolveConfigPath(options);
  const block = buildBlock(repoRoot);

  if (options.dryRun) {
    process.stdout.write(block);
    return;
  }

  const original = readConfig(configPath);

  if (options.remove) {
    const { content: cleaned, found } = stripManagedBlock(original);
    if (!found) {
      console.log(`No managed grok-build entry found in ${configPath}.`);
      return;
    }
    writeAtomic(configPath, cleaned);
    console.log(`Removed grok-build MCP server entry from ${configPath}.`);
    return;
  }

  const { content: cleaned, found: hadManaged } = stripManagedBlock(original);
  assertNoUnmanagedSection(cleaned, configPath);

  const updated = insertManagedBlock(cleaned, block);
  writeAtomic(configPath, updated);
  console.log(
    `${hadManaged ? "Updated" : "Installed"} grok-build MCP server entry in ${configPath} ` +
      `(repo: ${repoRoot}).`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

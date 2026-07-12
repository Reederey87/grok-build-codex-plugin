#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  {
    file: "package.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: "package-lock.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      },
      {
        label: "packages[\"\"].version",
        get: (json) => json.packages?.[""]?.version,
        set: (json, version) => {
          requireObject(json.packages?.[""], "package-lock.json packages[\"\"]");
          json.packages[""].version = version;
        }
      },
      {
        label: "packages[\"mcp-server\"].version",
        get: (json) => json.packages?.["mcp-server"]?.version,
        set: (json, version) => {
          if (json.packages?.["mcp-server"]) {
            json.packages["mcp-server"].version = version;
          }
        }
      }
    ]
  },
  {
    file: "mcp-server/package.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: ".codex-plugin/plugin.json",
    optional: true,
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help       Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: process.cwd(),
    version: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function targetExists(root, target) {
  return fs.existsSync(path.join(root, target.file));
}

function readJson(root, file) {
  const filePath = path.join(root, file);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(root, file, json) {
  const filePath = path.join(root, file);
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readPackageVersion(root) {
  const packageJson = readJson(root, "package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  validateVersion(packageJson.version);
  return packageJson.version;
}

function checkVersions(root, expectedVersion) {
  const mismatches = [];

  for (const target of TARGETS) {
    if (target.optional && !targetExists(root, target)) {
      continue;
    }

    const json = readJson(root, target.file);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expectedVersion) {
        mismatches.push(`${target.file} ${value.label}: expected ${expectedVersion}, found ${actual ?? "<missing>"}`);
      }
    }
  }

  return mismatches;
}

function bumpVersion(root, version) {
  const changedFiles = [];
  const warnings = [];

  for (const target of TARGETS) {
    if (target.optional && !targetExists(root, target)) {
      warnings.push(`Skipping ${target.file}: file does not exist.`);
      continue;
    }

    const json = readJson(root, target.file);
    const before = JSON.stringify(json);

    for (const value of target.values) {
      value.set(json, version);
    }

    if (JSON.stringify(json) !== before) {
      writeJson(root, target.file, json);
      changedFiles.push(target.file);
    }
  }

  return { changedFiles, warnings };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const version = options.version ?? (options.check ? readPackageVersion(options.root) : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  if (options.check) {
    const mismatches = checkVersions(options.root, version);
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    console.log(`All version metadata matches ${version}.`);
    return;
  }

  const { changedFiles, warnings } = bumpVersion(options.root, version);
  for (const warning of warnings) {
    console.warn(warning);
  }
  const touched = changedFiles.length > 0 ? changedFiles.join(", ") : "no files changed";
  console.log(`Set version metadata to ${version}: ${touched}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

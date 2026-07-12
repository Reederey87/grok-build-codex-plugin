# Grok Build Bridge

A Codex CLI plugin that lets you delegate reviews and bounded coding tasks from an OpenAI
Codex session to the local, subscription-authenticated Grok Build CLI (xAI). It ships a
bundled stdio MCP server that wraps the local `grok` binary, plus a skill that tells Codex
when to reach for it. Grok is an explicit second-opinion / review / task channel — not a
model swap for Codex's own work.

```
Codex session → grok-build-delegate skill routes → MCP tools → local `grok` CLI → results back under Codex approvals
```

## Requirements

- Node.js >= 18.18
- The Grok Build CLI, installed and logged in:
  ```
  curl -fsSL https://x.ai/cli/install.sh | bash
  grok login
  ```
- The OpenAI Codex CLI with plugin support.

## Install (local dev)

```
npm install
codex plugin marketplace add /path/to/grok-build-codex-plugin
codex plugin add grok-build@grok-build-dev
```

The repository root doubles as the marketplace (`.agents/plugins/marketplace.json`).
Run `npm install` before adding it — the MCP server needs `@modelcontextprotocol/sdk`
at runtime and the plugin is cached with its `node_modules`.

Verified on codex-cli 0.144.1: `${PLUGIN_ROOT}` in `.mcp.json` resolves correctly. If you
hit the older resolution bugs
([openai/codex#22842](https://github.com/openai/codex/issues/22842),
[openai/codex#22105](https://github.com/openai/codex/issues/22105)), declare the
`grok-build` MCP server with an absolute path directly in `~/.codex/config.toml` instead.
See [`dev/README.md`](dev/README.md).

## Tools

The MCP server exposes seven tools. Each takes a `cwd` (the target repository's absolute
path).

| Tool | Purpose |
| --- | --- |
| `grok_build_setup` | Check the local Grok CLI, authentication, model, fallback, and state storage. |
| `grok_build_prompt` | Run a foreground, strictly read-only Grok prompt in a workspace. |
| `grok_build_review` | Collect safe Git context and run a read-only Grok code review. |
| `grok_build_task` | Run or queue a bounded Grok task, optionally with gated workspace writes. |
| `grok_build_status` | List active or all stored jobs for a repository, with process liveness. |
| `grok_build_result` | Return the stored result and evidence for a finished job. |
| `grok_build_cancel` | Cancel an active job, terminate its process tree, and release its write lock. |

`grok_build_task` runs in the foreground by default; pass `background: true` for long runs,
then poll `grok_build_status` and read `grok_build_result` when the job finishes.

## Configuration

Environment variables read by the MCP server:

| Variable | Purpose |
| --- | --- |
| `GROK_BUILD_DEFAULT_MODEL` | Default Grok model passed to the CLI. Unset uses Grok's own default. |
| `GROK_BUILD_PLUGIN_DATA` | Directory for job state and review inputs. Defaults to a temp dir. |
| `GROK_BUILD_API_FALLBACK` | `true` to permit the read-only xAI API fallback globally. Defaults to `false`. |
| `GROK_BUILD_ALLOW_WRITE` | `true` to allow write-mode tasks. Defaults to off. |
| `XAI_API_KEY` | xAI API key. Required for the API fallback. |
| `GROK_BUILD_XAI_BASE_URL` | xAI API base URL. Defaults to `https://api.x.ai/v1`. |
| `GROK_BUILD_XAI_TIMEOUT_MS` | xAI API request timeout in ms. Defaults to `120000`. |

Codex's own sandbox and approval policy governs applying any patch Grok proposes. A
per-tool approval snippet for `~/.codex/config.toml` lives in
[`dev/config-snippet.toml`](dev/config-snippet.toml) — it sets `grok_build_review` to
`approve` and keeps the write-capable `grok_build_task` on `prompt`.

## API fallback

By default all work runs through your local `grok` CLI. The read-only xAI API fallback
fires only when **all** of these hold:

- it is explicitly allowed — `allow_api_fallback: true` on the call, or `GROK_BUILD_API_FALLBACK=true`;
- `XAI_API_KEY` is set;
- the local `grok` CLI is missing or unauthenticated; and
- the request is read-only.

Fallback results are marked `source: "xai_api_fallback"`. The fallback is never used for
write-mode tasks — it uses your xAI API credits, so it stays an explicit, read-only opt-in.

## Write mode

Write mode is gated in v1 and off by default. Both gates must be satisfied:

1. the server environment has `GROK_BUILD_ALLOW_WRITE=true`, and
2. the call sets `write: true` on `grok_build_task`.

`--always-approve` is never implied; `always_approve` only takes effect for a write task and
only when explicitly requested. Each write job captures `git status` before and after the
run as evidence, so you can see exactly what changed. Applying anything further still goes
through Codex's normal edit/approval flow.

## Try it

Once the plugin is enabled, ask Codex:

- "Use Grok Build to run its setup diagnostics for this repo."
- "Use Grok Build to explain what this repository does (read-only)."
- "Use Grok Build to review my working tree."
- "Ask Grok Build for an adversarial review of this branch against `main`."

## Development

```
npm test            # node --test over tests/*.test.mjs
npm run build       # tsc type-check (JSDoc types, no emit)
```

Drive the tools without Codex using the dev runner or the server self-test:

```
node mcp-server/src/dev-runner.mjs setup --cwd "$PWD"
node mcp-server/src/server.mjs --self-test
```

`npm run bump-version` / `npm run check-version` manage the coupled version strings.

## Status

The Grok Build CLI is early beta — its flags and JSON output may change. Output parsing is
kept deliberately tolerant, and job success is read from Grok's `stopReason`
(`EndTurn` = clean) rather than exit codes. Expect rough edges.

## License

Apache-2.0

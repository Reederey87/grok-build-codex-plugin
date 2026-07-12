# Local dev install

The repository root doubles as a Codex plugin marketplace
(`.agents/plugins/marketplace.json`), so installing the checkout is two commands:

```
codex plugin marketplace add /path/to/grok-build-codex-plugin
codex plugin add grok-build@grok-build-dev
```

Run `npm install` in the checkout first — the plugin is cached with its
`node_modules`, and the MCP server needs `@modelcontextprotocol/sdk` at runtime.

On codex-cli 0.144.1, `${PLUGIN_ROOT}` in `.mcp.json` does not resolve when Codex's
session cwd is outside this checkout (openai/codex#22842), so `.mcp.json` alone leaves
the MCP server unreachable from other repos. Run the installer instead:

```
node scripts/install-codex-config.mjs
```

It writes an absolute-path `[mcp_servers.grok-build]` entry to `~/.codex/config.toml`
(or `$CODEX_HOME/config.toml`, or a path passed via `--config`), inside a managed block
it can safely replace on rerun. `.mcp.json` stays in the repo for when upstream fixes
`${PLUGIN_ROOT}` resolution. Flags:

- `--remove` — delete the managed block only, leaving the rest of the file untouched.
- `--dry-run` — print the block that would be written, without touching the file.
- `--config <path>` — target a specific config.toml instead of the default location.

The installer refuses to run if `~/.codex/config.toml` already has a hand-written
`[mcp_servers.grok-build]` section outside its managed block, so it never clobbers
existing configuration.

A per-tool approval policy for testing lives in [`config-snippet.toml`](config-snippet.toml).

`.mcp.json` runs the server via `mcp-server/bin/grok-build-mcp`, a launcher that finds a
node binary even under a minimal PATH (GUI/launchd Codex launches); set
`GROK_BUILD_NODE=/path/to/node` to override its search.

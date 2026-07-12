# Local dev install

The repository root doubles as a Codex plugin marketplace
(`.agents/plugins/marketplace.json`), so installing the checkout is two commands:

```
codex plugin marketplace add /path/to/grok-build-codex-plugin
codex plugin add grok-build@grok-build-dev
```

Run `npm install` in the checkout first — the plugin is cached with its
`node_modules`, and the MCP server needs `@modelcontextprotocol/sdk` at runtime.

Verified on codex-cli 0.144.1: `${PLUGIN_ROOT}` in `.mcp.json` resolves correctly,
so the bundled MCP server starts without extra configuration. If you hit the older
resolution bugs (openai/codex#22842, #22105), declare the `grok-build` MCP server
with an absolute path directly in `~/.codex/config.toml` instead.

A per-tool approval policy for testing lives in [`config-snippet.toml`](config-snippet.toml).

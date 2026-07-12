# Local dev install

Install for local development with:

```
codex plugin marketplace add /Users/reederey/Developer/plugins/grok-build-codex-plugin/dev/marketplace
```

Then enable the `grok-build` plugin from the marketplace listing.

If `${PLUGIN_ROOT}` fails to resolve in `.mcp.json` (see open upstream bugs
openai/codex#22842 and openai/codex#22105), work around it by declaring the
`grok-build` MCP server with an absolute path directly in `~/.codex/config.toml`
instead of relying on plugin-relative resolution.

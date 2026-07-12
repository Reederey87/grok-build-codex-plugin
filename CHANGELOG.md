# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-07-12

Initial release.

- Bundled stdio MCP server exposing seven tools: `grok_build_setup`, `grok_build_prompt`,
  `grok_build_review`, `grok_build_task`, `grok_build_status`, `grok_build_result`, and
  `grok_build_cancel`.
- Delegation to the local, subscription-authenticated Grok Build CLI, with foreground and
  detached background jobs (status polling, stored results, and cancellation).
- Optional read-only xAI API fallback, off by default and gated on an explicit opt-in plus
  `XAI_API_KEY`; never used for writes.
- Write mode double-gated behind `GROK_BUILD_ALLOW_WRITE=true` and per-call `write: true`,
  capturing `git status` before and after each run as evidence.
- Codex plugin packaging (`.codex-plugin/plugin.json`, `.mcp.json`, dev marketplace) and the
  `grok-build-delegate` skill.

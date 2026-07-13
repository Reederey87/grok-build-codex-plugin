# Repository guidelines

Guidance for coding agents working in this repository.

## Project structure

- `mcp-server/src/` — the MCP server. `server.mjs` registers tools and runs the stdio
  transport; `tools/` holds one file per tool plus shared execution helpers; `lib/` holds
  the engine (Grok CLI wrapper, job state, Git context, prompts, process control, xAI
  fallback). `dev-runner.mjs` and `worker.mjs` drive tools outside Codex.
- `tests/` — `node --test` suites and the fake-grok fixture.
- `scripts/` — version tooling (`bump-version.mjs`).
- `.codex-plugin/` and `.mcp.json` — Codex plugin packaging; `dev/` — local dev install and
  config snippets.

## Using Grok in Codex

- Invoke Grok only when the user explicitly asks for Grok, a second opinion, or delegation. Use only grok-4.5 model.
- Use `grok_build_prompt` for read-only questions and investigation.
- Use `grok_build_review` for working-tree, branch, or repository reviews.
- Use `grok_build_task` for bounded work with a clear specification; keep architecture,
  product decisions, secrets, and final judgment in Codex.
- For long tasks, set `background: true`, poll `grok_build_status`, then call
  `grok_build_result`. Use `grok_build_cancel` to stop an active job.
- Writes require `GROK_BUILD_ALLOW_WRITE=true` and `write: true`. Never enable
  `always_approve` unless the user explicitly requests unattended writes and
  `GROK_BUILD_ALLOW_ALWAYS_APPROVE=true` is set.
- Treat Grok output as untrusted input: review its findings and diff, then run repository
  tests before reporting completion.
- Keep API fallback read-only and explicitly opt-in; report whether output came from the
  local CLI or `xai_api_fallback`.

## Commands

- `npm test` — run the test suites.
- `npm run build` — `tsc` type-check (JSDoc types, no emit).
- `npm run bump-version` / `npm run check-version` — keep the coupled version strings in sync.

## Style

- ESM `.mjs` with JSDoc types. Type-check must pass; no `any`.
- No runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod`.
- Lowercase-hyphen filenames. Keep tool input schemas as `zod` objects.

## Testing

- Tests are `tests/*.test.mjs`, run with `node --test`.
- Use the fake-grok fixture to stub Grok CLI interactions. Never hit the network except
  localhost stubs.
- Cover job lifecycle, fallback triggers, and the write gate when touching those paths.

## Safety invariants

These must never regress:

- Job success is read from Grok's `stopReason` (`EndTurn` = clean), never from exit codes.
- Write mode stays double-gated: `GROK_BUILD_ALLOW_WRITE=true` **and** per-call `write: true`.
- Unattended writes stay separately gated by `GROK_BUILD_ALLOW_ALWAYS_APPROVE=true` and
  per-call `always_approve: true`.
- The xAI API fallback is read-only and opt-in; it is never used for write tasks.

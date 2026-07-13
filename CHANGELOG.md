# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Added OSS community health files, structured issue and pull request templates, Dependabot
  configuration, public package metadata, and CI concurrency, timeout, and production dependency
  auditing.

- Unified Grok timeout and process-reaping evidence, made active empty-PID states fail closed,
  heartbeat foreground jobs, and preserve completion evidence across cancellation races.
- Restricted write tasks to a `strict`/`dontAsk` curated read-edit-test capability policy without
  forwarding Grok's global always-approve bypass.
- Removed hidden model aliases, centralized model-list parsing and selection, and reject explicit
  local models that are absent from `grok models`.
- Added a second trust gate for custom remote xAI fallback hosts, safe URL construction, and
  response-error hygiene that does not echo remote bodies.

- Added path-filtered, content-redacted review snapshots with explicit coverage metadata and
  isolated review working directories.
- Made xAI API fallback requests non-retained with `store: false`, bounded local timeouts to one
  hour, resolved effective CLI defaults, and cleaned up non-resumable review/setup sessions.
- Added a separate unattended-write environment gate, protected-path mutation detection, and
  structured MCP tool results.

- Prevented write-lock release while cancellation, timeout cleanup, or stale live processes still
  own work; job heartbeat and PID updates now merge under the per-job state lock.
- Switched read-only Grok calls to the repository-scoped `strict` sandbox, added sensitive `Glob`
  denials, and delete private file-backed review inputs immediately after completion.
- Added explicit review model/timeout inputs, bounded CLI setup probes, and opt-in per-model smoke
  matrices through `smoke_models`.
- Added deterministic coverage for stubborn-process cancellation, stale-live lock refusal, state
  merge races, process timeouts, strict sandbox arguments, review cleanup, and all-model smoke.

- Added review disclosure previews and explicit acknowledgement before repository context is
  sent to xAI; sensitive filenames are now withheld as aggregate omission counts.
- Restricted read-only Grok invocations to `Read`, `Grep`, and `Glob`, and added conservative
  MCP risk annotations to all tools.
- Reworked setup to use `grok models`, report local/fallback readiness separately, and accept any
  clean `EndTurn` smoke response instead of exact model prose.
- Hardened background spawn, timeout, cancellation, PID ownership leases, state validation,
  retention purity, and asynchronous CAS locking.

- Hardened background cancellation with separate worker/Grok process tracking, a retryable
  `cancelling` state, confirmed process exit, and fail-safe write-lock release.
- Moved default state to private per-user storage, added legacy temporary-state reads, and
  redacted status responses while preserving full result retrieval and applying a 30-day
  retention window to completed current-format job records.
- Disabled ambient Grok memory, subagents, and web search; expanded destructive command
  denials and capped child output at 16 MiB per stream.
- Preserved model completion when post-run Git evidence collection fails and aligned the npm
  binary entry with the portable launcher.
- Added regression coverage for lifecycle races, stale locks, private modes, isolation flags,
  output limits, completion classification, and status redaction.

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

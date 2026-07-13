---
name: grok-build-delegate
description: Use the local Grok Build CLI for second-opinion reviews, adversarial critiques, or delegated read-only investigation from Codex.
---

# Grok Build delegate

Bridge to the local, subscription-authenticated Grok Build CLI (xAI). Use it to get an
independent second opinion, an adversarial review, or a delegated investigation without
leaving the Codex session. This is a separate review/task channel, not a model swap for
your own work.

## When to use

Reach for these tools only when the user explicitly asks for Grok, Grok Build, grok-4.5,
a second opinion, or an external/adversarial review. Do not route ordinary work here.

## Routing

- Setup or health check → `grok_build_setup`. Run it first when anything looks
  misconfigured; it reports CLI availability, auth, model, fallback, and state storage. Use
  `run_smoke_test: true` for one model or `smoke_models: "all"` only when the user asks to
  verify every discovered model.
- Quick question or second opinion → `grok_build_prompt`. Foreground, strictly read-only.
- Code review → `grok_build_review`. Preview with `preview_only: true`, explain that path-filtered,
  best-effort content-redacted repository context will be sent to xAI, and execute only with
  `external_disclosure_acknowledged: true`. Pass `scope` (`working-tree`, `branch`, or `repo`)
  and `base_ref` for `branch`; set `adversarial: true` to challenge assumptions. Pass `model`
  when the user requests a specific Grok model.
- Investigation or a longer task → `grok_build_task`. For long runs set `background: true`,
  then poll `grok_build_status` and read `grok_build_result` when it finishes. Use
  `grok_build_cancel` to stop a running job.

Every tool takes `cwd` — pass the absolute path of the repository being worked on.

## Safety rules

- Default to read-only. `grok_build_prompt` and `grok_build_review` can never write.
  Their local Grok invocations use the `strict` sandbox and expose only `Read`, `Grep`, and
  `Glob`, not Bash.
- Writes go through `grok_build_task` with `write: true`, and only when the user explicitly
  asks Grok to change files. This is double-gated: the server also requires
  `GROK_BUILD_ALLOW_WRITE=true` in its environment. Without it the tool returns
  `write mode disabled — set GROK_BUILD_ALLOW_WRITE=true to enable`. Relay that to the user
  rather than trying to work around it.
- Never set `always_approve` unless the user explicitly says "yolo" or "always approve". It
  only applies to write tasks and requires `GROK_BUILD_ALLOW_ALWAYS_APPROVE=true`; the bridge
  keeps Grok inside its curated capability allowlist rather than forwarding a global CLI bypass.
- Never put secrets, credentials, tokens, or env-file contents in a prompt.
- Grok returns findings and proposed patches. Apply any change through normal Codex edits
  under Codex's own sandbox and approval policy — do not treat a Grok proposal as approved.
- On an auth failure, tell the user to run `grok login` (or `grok login --device-auth`).

## Output handling

- Report whether the result came from `local_grok_cli` or `xai_api_fallback` (the read-only
  xAI API path). The `source` field carries this.
- Summarize briefly, but preserve file paths, severities, and critical findings verbatim.
- For background jobs, treat a finished job's stored result as the record — read it with
  `grok_build_result`, don't re-run.
- Status output is intentionally limited to operational metadata; prompts, result bodies,
  log paths, and internal state stay out of status responses.
- Bridge invocations disable Grok memory, subagents, and web search. Local Grok
  configuration and hooks remain trusted local inputs.
- Explicit local model IDs must be returned by `grok models`; the bridge does not silently alias
  missing model names.

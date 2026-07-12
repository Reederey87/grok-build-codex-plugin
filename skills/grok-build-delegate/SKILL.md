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
  misconfigured; it reports CLI availability, auth, model, fallback, and state storage.
- Quick question or second opinion → `grok_build_prompt`. Foreground, strictly read-only.
- Code review → `grok_build_review`. Pass `scope` (`working-tree`, `branch`, or `repo`)
  and `base_ref` for `branch`/`repo`; set `adversarial: true` to challenge assumptions.
- Investigation or a longer task → `grok_build_task`. For long runs set `background: true`,
  then poll `grok_build_status` and read `grok_build_result` when it finishes. Use
  `grok_build_cancel` to stop a running job.

Every tool takes `cwd` — pass the absolute path of the repository being worked on.

## Safety rules

- Default to read-only. `grok_build_prompt` and `grok_build_review` can never write.
- Writes go through `grok_build_task` with `write: true`, and only when the user explicitly
  asks Grok to change files. This is double-gated: the server also requires
  `GROK_BUILD_ALLOW_WRITE=true` in its environment. Without it the tool returns
  `write mode disabled — set GROK_BUILD_ALLOW_WRITE=true to enable`. Relay that to the user
  rather than trying to work around it.
- Never set `always_approve` unless the user explicitly says "yolo" or "always approve". It
  only applies to write tasks.
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

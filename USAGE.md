# When to use Grok from Codex

Grok Build (grok-4.5) is cheap and fast, but less capable than Codex's own model on
open-ended problems. Delegate work that is **well-defined**; keep judgment calls in Codex.

## Use Grok for

| Task | Tool | Example prompt |
| --- | --- | --- |
| Implementing a **written plan** — spec'd fixes, mechanical/bulk edits, boilerplate | `grok_build_task` (`write: true`, gated) | "Use Grok Build to implement the fix described in a plan prepared by Codex. Write mode allowed." |
| **Code review** / second opinion on a diff or branch | `grok_build_review` | "Use Grok Build to review my working tree." / "…adversarial review of this branch against main." |
| Repo questions, quick investigations, root-cause reading | `grok_build_prompt`, `grok_build_task` (read-only) | "Ask Grok Build why the parser tests fail. Read-only." |

Rule of thumb: if you could hand the task to a junior engineer with a clear spec and
accept the result after a diff review — delegate it to Grok.

Reviews disclose path-filtered, best-effort content-redacted repository context to xAI. Preview first with `preview_only: true`, then
execute only after the user acknowledges external disclosure with
`external_disclosure_acknowledged: true`. Preview mode performs no inference and reports
redaction and coverage metadata without including sensitive path names.

## Activate in Codex CLI

From the plugin checkout:

```bash
npm install
codex plugin marketplace add "$PWD"
codex plugin add grok-build@grok-build-dev
node scripts/install-codex-config.mjs
```

- Add the marketplace only once per checkout location. The repository marketplace is named
  `grok-build-dev`.
- `codex plugin add` installs the plugin metadata and skill into Codex's plugin cache.
- The config installer adds an idempotent, managed `grok-build` MCP entry using the checkout's
  absolute path. Rerunning it updates that block without changing unrelated Codex settings.
- Restart Codex CLI and start a **new thread** after activation so it reloads the MCP config,
  skill, and tool schemas.
- Verify installation with `codex plugin list`, then ask Codex: “Use Grok Build setup for this
  repository.”

If the checkout moves, add the marketplace from its new path and rerun the config installer.
Use `node scripts/install-codex-config.mjs --remove` to remove only its managed MCP block.

## Reload after an update

Codex caches installed plugin contents. The managed MCP entry runs server code directly from
this checkout, so server-only changes need a Codex CLI restart and new thread, but no cachebuster.
Skill or manifest changes require a new plugin version and reinstall.

For a real release, update all coupled version fields and reinstall:

```bash
npm run bump-version -- 0.1.1
npm run check-version
codex plugin add grok-build@grok-build-dev
node scripts/install-codex-config.mjs
```

For local iteration without choosing a new release number, add a timestamp cachebuster, sync it
to the repository's coupled version fields, and reinstall:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" "$PWD"
npm run bump-version -- "$(node -p 'require("./.codex-plugin/plugin.json").version')"
npm run check-version
codex plugin add grok-build@grok-build-dev
node scripts/install-codex-config.mjs
```

The helper replaces an existing `+codex.*` suffix instead of stacking suffixes. After either
update flow, close the old thread and test in a new one; existing threads may retain old skill
instructions or tool schemas. If Codex still shows the old version, confirm that `codex plugin
list` resolves `grok-build` from the local `grok-build-dev` marketplace rather than another
installed marketplace.

## Keep in Codex (don't delegate)

- Fuzzy or underspecified tasks, architecture and design decisions
- User-facing quality work (API design, copy, UX)
- Anything touching secrets, credentials, or env files
- Final judgment: always review Grok's diff/findings before applying or trusting them

## Mechanics

- Long tasks: add `background: true`, then `grok_build_status` → `grok_build_result`.
- Setup only discovers models by default. Use `run_smoke_test: true` for the selected/default
  model or `smoke_models: "all"` to verify every discovered model with per-model results.
- Reviews accept `model` and a `timeout_ms` of up to one hour; responses report requested,
  effective, and result model fields.
- Status is deliberately redacted; retrieve complete output and evidence with `grok_build_result`.
- Writes are double-gated: server env `GROK_BUILD_ALLOW_WRITE=true` **and** `write: true`.
  Unattended writes additionally require `GROK_BUILD_ALLOW_ALWAYS_APPROVE=true` and explicit
  `always_approve: true`; this approves only the bridge's curated read/edit/test/build capability
  set and never forwards a global CLI bypass.
- Success signal is `stop_reason: "EndTurn"`; `source` tells you if the xAI API
  fallback (read-only, opt-in) answered instead of the local CLI.
- Grok memory, subagents, and web search are disabled for bridge invocations. Read-only calls use
  the `strict` sandbox and only expose `Read`, `Grep`, and `Glob`. Treat local
  Grok configuration and hooks as trusted inputs, and never delegate secrets.
- Write calls also use `strict`, run in `dontAsk`, and allow only repository read/edit tools plus
  narrow test, build, and read-only Git metadata commands.
- Explicit local model IDs must be listed by `grok models`; the bridge never applies hidden model
  aliases.
- Custom remote API fallback hosts require `GROK_BUILD_TRUST_CUSTOM_XAI_BASE_URL=true` in addition
  to the normal read-only fallback opt-in.

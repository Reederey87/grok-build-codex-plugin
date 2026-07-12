# When to use Grok from Codex

Grok Build (grok-4.5) is cheap and fast, but less capable than Codex's own model on
open-ended problems. Delegate work that is **well-defined**; keep judgment calls in Codex.

## Use Grok for

| Task | Tool | Example prompt |
| --- | --- | --- |
| Implementing a **written plan** — spec'd fixes, mechanical/bulk edits, boilerplate | `grok_build_task` (`write: true`, gated) | "Use Grok Build to implement the fix described in plan prepeared by Codex. Write mode allowed." |
| **Code review** / second opinion on a diff or branch | `grok_build_review` | "Use Grok Build to review my working tree." / "…adversarial review of this branch against main." |
| Repo questions, quick investigations, root-cause reading | `grok_build_prompt`, `grok_build_task` (read-only) | "Ask Grok Build why the parser tests fail. Read-only." |

Rule of thumb: if you could hand the task to a junior engineer with a clear spec and
accept the result after a diff review — delegate it to Grok.

## Keep in Codex (don't delegate)

- Fuzzy or underspecified tasks, architecture and design decisions
- User-facing quality work (API design, copy, UX)
- Anything touching secrets, credentials, or env files
- Final judgment: always review Grok's diff/findings before applying or trusting them

## Mechanics

- Long tasks: add `background: true`, then `grok_build_status` → `grok_build_result`.
- Writes are double-gated: server env `GROK_BUILD_ALLOW_WRITE=true` **and** `write: true`.
  Never set `always_approve` unless you explicitly want unattended writes.
- Success signal is `stop_reason: "EndTurn"`; `source` tells you if the xAI API
  fallback (read-only, opt-in) answered instead of the local CLI.

# Contributing

Thanks for helping improve Grok Build Bridge. Contributions of all sizes are welcome,
including bug reports, documentation fixes, tests, and focused implementation changes.

## Before you start

- Search existing issues and pull requests to avoid duplicate work.
- Open an issue before a large behavioral or architectural change.
- Never include credentials, tokens, private repository content, or Grok session data in an
  issue, test fixture, commit, or pull request.
- Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Local development

Requirements:

- Node.js 18.18 or newer
- npm
- Git

Install dependencies and run the required checks:

```sh
npm ci
npm test
npm run build
npm run check-version
```

Tests must not call external services. Use the fake Grok fixture or a localhost stub. Add or
update tests for changes to job lifecycle, permissions, model resolution, fallback behavior,
or write gates.

## Pull requests

- Keep each pull request focused and explain the user-visible impact.
- Preserve the safety invariants in [AGENTS.md](AGENTS.md).
- Update documentation and `CHANGELOG.md` for public behavior or configuration changes.
- Use clear commit messages and leave the branch in a state where all required checks pass.
- Expect maintainers to request changes when a proposal broadens Grok access, weakens a gate,
  or makes external disclosure less explicit.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

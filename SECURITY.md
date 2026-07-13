# Security Policy

## Supported versions

Security fixes are made on the `main` branch. Until the project publishes stable releases,
only the latest commit on `main` is supported.

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include secrets, credentials, private code,
or exploit details in public discussions.

Report vulnerabilities through the repository's
[private security advisory form](https://github.com/Reederey87/grok-build-codex-plugin/security/advisories/new).
Include:

- the affected version or commit;
- impact and attack preconditions;
- reproduction steps or a minimal proof of concept;
- any suggested mitigation; and
- whether the issue is already public.

You should receive an acknowledgement within seven days. The maintainer will coordinate a fix
and disclosure timeline based on severity. Please allow a reasonable remediation period before
public disclosure.

## Security-sensitive areas

Changes involving external disclosure, Grok CLI permissions, write gates, process termination,
stored job data, API fallback credentials, or protected paths require regression tests and
explicit security review.

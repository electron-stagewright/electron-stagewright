# Security Policy

## Supported versions

The project is pre-`1.0`. Until `v1.0.0` ships, only the latest minor receives security updates.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately by emailing **johnny.iv.young@gmail.com** with the subject line `[security] electron-stagewright`.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or proof-of-concept code.
- Affected version(s).
- Your suggested remediation, if any.

You'll receive an acknowledgment within 5 business days. We aim to provide a disclosure timeline within 14 days of acknowledgment.

## Disclosure policy

We follow coordinated disclosure:

1. Confirm the vulnerability and assess severity.
2. Develop a fix in a private fork or branch.
3. Coordinate a release date with the reporter.
4. Publish a security advisory via GitHub Security Advisories (with CVE if applicable).
5. Credit the reporter in the advisory unless they prefer to remain anonymous.

## Threat model

The full threat model — assets, trust boundaries, threats and their mitigations, and the residual risks — is published at [`docs/guides/security-model.md`](../docs/guides/security-model.md), and the overall posture is recorded in [ADR-014](../docs/adr/014-security-posture-and-threat-model.md).

In one line: the server is **a privileged local tool, not a sandbox**. It runs with your OS privileges and, under `--allow-eval`, executes arbitrary JavaScript in the app under test, so only a trusted agent host should invoke it — over the default local stdio transport. Key concerns:

- `electron_eval_main` / `electron_eval_renderer` allow arbitrary JS in the app. They are default-deny (unregistered without `--allow-eval`) with a keyword blocklist and a result cap; the blocklist is defence-in-depth, not a complete control.
- The `production` plugin reads signed `.app` bundles and updater feeds. It may return bounded local evidence such as a signing authority in the tool result, but it does not upload that data anywhere.
- The `trace` plugin writes session artifacts to disk, and the `ipc` plugin returns captured channel payloads to the agent; configure `redact` for structured argument/payload fields, and treat screenshots, console output, and tool results as sensitive.

See the threat model for the full analysis and a deployment checklist.

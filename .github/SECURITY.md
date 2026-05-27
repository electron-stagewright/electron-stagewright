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

## Threat model (in progress)

A formal threat model document is planned. High-level concerns currently identified:

- The server's `eval_main` and `eval_renderer` tools allow arbitrary JS execution in the Electron app under test. This is intentional and necessary for the tool's purpose, but means the MCP server should never be exposed to untrusted agent input without sandboxing.
- The `production` plugin reads signed `.app` bundles and inspects updater feeds — must not exfiltrate signing identities.
- The `trace` plugin writes session data to disk. Defaults must not include sensitive payloads (passwords, tokens) unless the user opts in.

Until the threat model is published, treat the MCP server as **a privileged local tool** that should only be invoked by trusted agent hosts.

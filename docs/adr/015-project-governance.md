# ADR-015: Project governance and maintainership

Status: Accepted

## Context

Electron Stagewright is pre-1.0 and, today, maintained by a single lead. The repo
already carries the standard community-health files (CONTRIBUTING, CODE_OF_CONDUCT,
SECURITY, LICENSE, FUNDING), but none of them states how the project is actually
governed: who has final say, how decisions are recorded, and how a regular
contributor can earn commit rights. Heading toward a public launch and inviting
outside contributors, that silence reads as "closed, don't invest here." This ADR
records the governance model as a decision; the public-facing elaboration lives in
[`../../.github/GOVERNANCE.md`](../../.github/GOVERNANCE.md).

## Decision

### 1. A lead-maintainer model, designed to grow into a team

The project runs on a lead-maintainer ("BDFL-lite") model: the lead has final say,
but the intent is explicitly to grow into a small maintainer team as trusted
contributors emerge. This is stated honestly rather than dressed up as a council
that does not yet exist.

### 2. Decisions are made in the open, and architecture is recorded as ADRs

Direction is discussed publicly in GitHub Issues and Discussions before structural
changes land (no private channels until the project grows). **Architectural
decisions are recorded as ADRs** — the canonical mechanism in this repo. "When in
doubt, open a discussion; when a structural choice is made, write the ADR."

### 3. Roles: lead maintainer, maintainers, contributors

- **Lead maintainer** — final say on direction and releases; stewards the ADRs.
- **Maintainers** — commit/review rights; share review and triage load.
- **Contributors** — anyone opening an issue, discussion, or pull request.

### 4. The co-maintainer path is merit-and-trust, by invitation

A contributor becomes a maintainer through sustained, quality contributions and
alignment with the project's direction, by invitation from the lead maintainer.
There is no fixed quota and no time-served rule — it is a trust decision.

### 5. Releases and versioning

Semantic versioning. Pre-1.0, only the latest minor receives fixes (consistent with
`SECURITY.md`); there is no long-term-support line until 1.0. Breaking changes are
expected pre-1.0 and called out in release notes.

### 6. Conduct

Behaviour is governed by `CODE_OF_CONDUCT.md`; enforcement is by the maintainers at
the contact listed in `SECURITY.md`.

## Rationale

A one-person pre-1.0 project should not pretend to a heavyweight steering committee,
but it also should not stay silent — silence reads as an unwelcoming, drive-by repo.
A lightweight, honest model with an explicit growth path and a clear co-maintainer
on-ramp is the credible middle: it tells a prospective contributor exactly how
decisions get made and how they could earn a seat, without inventing structure that
does not exist yet.

## Alternatives considered

- **A formal steering committee / TSC now** — rejected as premature; there is one
  maintainer.
- **No governance document** — rejected; the absence is itself a signal that the
  project is closed to outside investment.
- **A foundation / org-ownership model** — deferred; appropriate only if and when the
  project and its contributor base are much larger.

## Consequences

- `GOVERNANCE.md` is published and completes the community-health file set, so the
  GitHub community profile and a prospective contributor both see how the project is
  run.
- The co-maintainer path is explicit, lowering the barrier for serious contributors.
- The ADR process is named as the decision-record mechanism, reinforcing that
  architecture lands as ADRs.
- As the maintainer team grows, this ADR is amended with a `Status Update` (history
  is never rewritten), and `GOVERNANCE.md` tracks the current reality.

## Related decisions

- ADR-013 (public documentation layout) and ADR-014 (security posture) — the
  precedent that non-code project decisions are recorded as ADRs.
- The community-health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.

## References

- `.github/GOVERNANCE.md` — the public governance document.
- `.github/CONTRIBUTING.md` — how to contribute (workflow, conventions, gates).
- `.github/CODE_OF_CONDUCT.md` — behavioural standards and enforcement.
- `.github/SECURITY.md` — the maintainer contact and reporting policy.

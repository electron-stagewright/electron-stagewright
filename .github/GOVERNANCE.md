# Governance

How Electron Stagewright is run, who decides what, and how you can earn a seat at
the table. The reasoning behind this model is recorded in
[ADR-015](../docs/adr/015-project-governance.md).

## The short version

The project runs on a **lead-maintainer model** today — one person has final say —
but it is explicitly designed to grow into a small maintainer team as trusted
contributors emerge. Decisions are made in the open, and the architectural ones are
written down as ADRs.

## Roles

- **Lead maintainer** — final say on direction and releases; stewards the
  [Architecture Decision Records](../docs/adr/README.md).
- **Maintainers** — commit and review rights; share the review and triage load.
- **Contributors** — anyone who opens an issue, a discussion, or a pull request.
  That includes you.

## Maintainers

| Maintainer                                       | Role            |
| ------------------------------------------------ | --------------- |
| [@johnny4young](https://github.com/johnny4young) | Lead maintainer |

As the team grows, this list and [ADR-015](../docs/adr/015-project-governance.md)
are updated to match reality.

## How decisions are made

- Direction and structural changes are discussed publicly in GitHub Issues and
  Discussions **before** they land. There are no private decision channels until the
  project grows.
- Day-to-day calls are made by maintainer discretion.
- The lead maintainer has the final say when consensus is not reached.

### When we write an ADR

Architectural decisions — anything that changes a public contract, a cross-cutting
design, or a default that is hard to reverse — are recorded as
[Architecture Decision Records](../docs/adr/README.md). The rule of thumb: **when in
doubt, open a discussion; when a structural choice is made, write the ADR** so the
decision (its context, the alternatives, and the consequences) is legible to anyone
who arrives later. An ADR is amended with a `Status Update` rather than rewritten.

## Becoming a co-maintainer

There is no quota and no time-served rule. A contributor is invited to become a
maintainer by the lead maintainer after **sustained, quality contributions** —
well-scoped pull requests that pass CI, thoughtful review and triage, and alignment
with the project's direction. It is a trust decision. If that is a path you want,
the fastest route is to keep shipping good, reviewable work and to engage in the
public discussions.

## Releases and versioning

The project follows semantic versioning. **Pre-1.0**, only the latest minor receives
fixes (see [SECURITY.md](./SECURITY.md)); there is no long-term-support line until
1.0, and breaking changes are expected and called out in the release notes.

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). Reports go
to the maintainers at the contact listed in [SECURITY.md](./SECURITY.md), and are
handled confidentially.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, conventions, and the gates
a pull request must pass.

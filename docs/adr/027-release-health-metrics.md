# ADR-027: Maintainer-side release health metrics without product telemetry

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Launch preparation needs a small set of signals for deciding whether releases, documentation, and
community work are helping: package downloads, repository clones, issue response, and contributor
growth. Calling this work “telemetry” is misleading. Each signal already originates at npm or
GitHub; none requires Electron Stagewright to observe an installation, an MCP session, or an app
under test.

That distinction matters more here than it would for an ordinary library. Stagewright can inspect
sensitive application state, screenshots, traces, storage, IPC, and network traffic under explicit
operator control. Adding an unrelated analytics channel to the runtime would weaken the local-tool
trust model in ADR-014 and create a second destination for data that users reasonably expect to
remain on their machine.

The upstream data also has constraints that affect the design:

- npm download counts are counts of successful tarball responses, including CI systems, mirrors,
  and automated analysis. They are directional package-adoption signals, not unique users.
- npm's download API does not support scoped packages in bulk queries, so each
  `@electron-stagewright/*` package must be requested separately.
- GitHub exposes only the latest 14 days of clone traffic and requires repository
  `Administration` read permission for the traffic endpoint.
- GitHub issues, comments, and pull requests are public, but their bodies and actor identities are
  unnecessary once the required aggregates have been computed.

A dashboard or external analytics provider would add retention, access, credential, and deletion
decisions before the metric semantics are even stable. The collection contract therefore comes
first.

## Decision

### 1. Treat these signals as release-health metrics, not product telemetry

Electron Stagewright will not add analytics emission to any published package, CLI command,
installer, MCP server, tool handler, plugin, demo, example app, trace, or replay runner.

Normal installation and use will make no release-health request and will create no analytics
identifier. In particular, the project will not collect or transmit:

- MCP session identifiers, tool names, arguments, results, errors, timings, or token counts;
- application paths, project names, runtime versions, environment variables, or host details;
- screenshots, snapshots, traces, console output, IPC, network, storage, or production-check data;
- IP addresses, user agents, device identifiers, account identifiers, or installation identifiers;
- feature usage, crash reports, or update checks.

This is a hard boundary, not an initial sampling policy. Crossing it requires a new public
architecture decision and an explicit end-user consent design.

### 2. Define four bounded metric families

All timestamps and date boundaries use UTC. A report labels its source and window; missing data is
`unavailable`, never zero.

| Metric family             | Canonical source                 | Stored aggregate                                                                                                                                     | Interpretation                                                                                                                                            |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package adoption          | npm download range API           | Daily downloads per publishable package; rolling 7-day and 30-day totals                                                                             | Directional package demand. `core` is reported separately; package totals are never summed or called users.                                               |
| Repository discovery      | GitHub repository traffic API    | Daily clone count and daily GitHub-reported unique cloners plus the as-of-date 14-day totals                                                         | Directional repository discovery. It excludes fetches and is not a unique-user count. Daily unique values are never summed into a multi-day unique count. |
| Maintainer responsiveness | GitHub issues and issue comments | Eligible-issue count, response coverage within 7 days, and p50/p90 time to first maintainer response for issues opened in the trailing 90-day cohort | Responsiveness to public, non-pull-request issues opened by non-maintainers.                                                                              |
| Contributor growth        | GitHub merged pull requests      | Non-bot accounts whose first merged pull request falls within 30 or 90 days, plus cumulative non-bot merged-PR authors                               | Growth in contributor accounts with an accepted change. GitHub-classified bots are excluded; maintainers remain contributors.                             |

For responsiveness, “maintainer” means a person listed as a maintainer in
`.github/GOVERNANCE.md` when the relevant event occurred: issue authors are classified at issue
creation and comment authors at comment creation. The collector derives that roster timeline from
the tracked file history; incomplete required history makes this metric family `unavailable`. The
reporting cohort contains eligible issues whose `created_at` is no earlier than 90 days before
`generated_at` and no later than 7 days before it, with both endpoints included. Pull requests,
bot-opened issues, maintainer-opened issues, and private security reports are excluded. The first
qualifying public comment by a maintainer closes the response interval. This cohort prevents a
newly opened issue from counting as a 7-day coverage failure before its window closes.

A response is within 7 days when its delay is at most 604,800 seconds. Response delays are stored as
non-negative integer seconds. Percentiles use the nearest-rank method over sorted delays from the
same cohort for issues with a qualifying response by `generated_at`; p50 is suppressed below five
such responses and p90 below ten. The eligible count, response count, and 7-day coverage remain
explicit.

Contributor growth uses merged-pull-request authors instead of Git commit author emails. An actor
is counted once, on their first merged pull request, unless GitHub classifies the actor as a bot.
Maintainers are included because they are contributors too, and excluding someone after a promotion
would retroactively reduce historical growth. This measures accepted contributor-account growth
without persisting commit email identities or turning ongoing maintainer activity into repeated
growth. It does not claim that every account GitHub leaves unclassified as a bot maps to one human.
An author that lacks a stable actor identity is excluded and increments only an aggregate
unclassified-author count. Cumulative growth is recomputed from complete merged-pull-request
history; incomplete pagination makes this metric family `unavailable`.

### 3. Minimize collection before aggregation

The collector will be maintainer tooling outside every publishable package. It will request only
fields required for the aggregates:

- npm package name, UTC day, and download count;
- GitHub clone UTC day, count, and reported unique count plus the 14-day snapshot totals;
- issue creation time and comment creation time plus the minimum actor fields needed to recognize
  bots and the public maintainer allowlist;
- pull-request author type/identity and merge time.

GitHub GraphQL is preferred for issue and pull-request aggregation because it returns only requested
fields. Queries must not request issue numbers, titles, bodies, labels, URLs, comment bodies,
reactions, or profile data. The traffic REST response is already aggregate-only.

Source responses and actor identities exist only in process memory while computing a report. They
must not be written to logs, fixtures generated from live data, workflow artifacts, caches, traces,
or error messages. Tests use synthetic fixtures.

### 4. Make collection maintainer-opt-in and fail closed on credentials

End-user opt-in is not applicable because the product emits nothing. The opt-in boundary belongs to
the maintainers who enable a collector, a schedule, storage, or a dashboard.

The npm source is public and unauthenticated. Public issue and pull-request metadata may use the
repository workflow token with read-only permissions. Clone traffic is different: GitHub requires
repository `Administration` read permission. A collector must report
`github_clones: unavailable` when that permission is absent. It must not silently:

- broaden the ordinary CI token;
- add a classic or broadly scoped personal access token;
- scrape the Insights UI;
- substitute page views, stars, or another metric and label it clones.

If clone collection is automated later, the preferred credential is a dedicated GitHub App
installed only on this repository with read-only Administration access. Installing that app is an
external maintainer action and requires a separate review of its ownership and rotation.

### 5. Use a provider-neutral aggregate schema and explicit retention

The first implementation will emit a versioned JSON report from an explicit maintainer command. It
will not schedule itself, upload itself, commit generated metrics to `main`, or select a dashboard.
The report contains:

- `schema_version` and `generated_at`;
- source windows and availability status;
- daily npm aggregates, daily clone aggregates, and as-of-date 14-day clone snapshots;
- one trailing-window responsiveness aggregate;
- one contributor-growth aggregate;
- bounded reason codes for unavailable sources.

It contains no free-form source payloads and no per-issue or per-contributor rows.

When persistent storage is selected, daily aggregates are retained for at most 400 days. Monthly
rollups may be retained indefinitely because they contain only project-level counts and
percentiles. Every retained non-additive value keeps its original window label: unique-cloner
values are never summed, and percentiles are never averaged into a new percentile. Raw source
responses have zero retention. Reprocessing must be idempotent by metric, source, and UTC date so
overlapping npm and GitHub windows cannot double count.

The lead maintainer owns collection credentials, access review, retention enforcement, and
quarterly metric review. A future maintainer team shares that ownership according to ADR-015.

### 6. Gate implementation and any future provider

The provider-neutral collector is eligible only if it:

1. derives the npm package list from publishable workspace manifests so additions cannot drift;
2. isolates source clients behind injectable seams and uses no live network in tests;
3. validates every source response and emits `unavailable` on permission, schema, or completeness
   failures;
4. proves scoped npm packages are requested separately;
5. proves forbidden identity/content fields cannot enter the output schema;
6. computes overlapping daily windows idempotently and never sums daily unique-cloner counts;
7. derives and validates the time-indexed maintainer roster from the tracked history of
   `.github/GOVERNANCE.md`;
8. fails the contributor metric when complete merged-pull-request pagination cannot be proven;
9. keeps its command absent from published tarballs and runtime startup paths.

Selecting scheduled execution, durable storage, or a dashboard requires a status update to this ADR
that names the provider, data location, access policy, credential model, deletion path, cost, and
failure ownership. Sending aggregates to a third party without that update is not compatible with
this decision.

## Rationale

The project needs enough evidence to prioritize releases and community work, not a behavioral
analytics system. Platform aggregates answer the stated questions without adding code to the trust
boundary users install.

The metric definitions favor honest, comparable signals over impressive numbers. npm downloads are
kept per package because summing a core package and plugins can count the same installation path
more than once. Issue response includes coverage so a fast median cannot hide unanswered issues.
Contributor growth uses first merged pull requests because that event has a clear project meaning,
counts each human once, and avoids GitHub's email-based contributor grouping.

A standalone, explicit collector keeps provider selection reversible. It can prove source semantics,
schema, data minimization, and failure behavior before the project grants a credential or retains a
historical dataset.

## Alternatives considered

- **Anonymous runtime telemetry with a consent prompt** — rejected. It collects a different class of
  data than the requested release-health signals and introduces product code, identifiers, network
  behavior, and consent state for no demonstrated need.
- **Install a third-party analytics SDK or dashboard immediately** — rejected. Provider convenience
  does not justify choosing retention, access, or data residency before the aggregate contract is
  accepted.
- **Sum all npm package downloads into one adoption number** — rejected. Package dependency paths
  and repeated automated installs make the total easy to mislabel and difficult to interpret.
- **Use GitHub's generic contributor endpoint** — rejected for this metric. It groups by commit
  author email, can surface anonymous contributors, and measures direct commits rather than the
  first merged-contribution event the project wants to measure.
- **Persist complete GitHub/npm responses for later analysis** — rejected. The extra identities,
  content, and source metadata are unnecessary once bounded aggregates exist.
- **Commit generated metrics to the default branch** — rejected. Automated data commits add
  repository and workflow churn, couple storage to source control, and make retention deletion
  harder.
- **Omit clone metrics permanently** — not chosen. Clone trends are useful, but an unavailable value
  is safer than acquiring an unreviewed high-privilege credential.

## Consequences

- Users receive a strong, testable promise: normal Stagewright use emits no analytics.
- Maintainers get four explicitly defined signals without conflating downloads, cloners, or
  contributors with unique users.
- Clone history requires recurring snapshots because GitHub retains only a 14-day API window, but
  automation remains blocked until its read-Administration credential is reviewed.
- Responsiveness and contributor percentiles may remain unavailable or noisy while the project has
  a small sample; reports expose that limitation instead of manufacturing precision.
- The first implementation is intentionally a collector and schema, not a hosted dashboard.
- Feature usage and runtime reliability remain unmeasured. A real need for either requires separate
  evidence and a new consent decision.

## Related decisions

- [ADR-013](./013-public-documentation-layout.md) — public architecture records and generated-doc
  boundaries.
- [ADR-014](./014-security-posture-and-threat-model.md) — privileged local-tool trust boundary and
  sensitive captured data.
- [ADR-015](./015-project-governance.md) — maintainer ownership and public decision-making.

## References

- [npm package download counts](https://github.com/npm/registry/blob/main/docs/download-counts.md) —
  range/point semantics, scoped-package bulk limitation, and data windows.
- [How npm download counts work](https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html) —
  automated traffic and why downloads are directional rather than users.
- [GitHub repository traffic API](https://docs.github.com/en/rest/metrics/traffic) — clone window,
  aggregate shape, and required permission.
- [GitHub GraphQL query model](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql) —
  queries return only requested fields.
- [GitHub Actions token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) —
  least-privilege workflow guidance.

# ADR-001: Naming and License

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: johnny4young

## Context

Before any code is written, the project needs a name that satisfies four criteria:

1. **Available** on npm and GitHub without collision against active projects in the testing / AI-agent automation space.
2. **Trust-signaling** to professional developers evaluating tooling for production use.
3. **Domain-anchored** — the name must communicate what the project does without explanation.
4. **Future-proof** — the name must survive internal architecture pivots (e.g., if the Playwright `_electron` experimental API is deprecated and the transport layer must be rewritten).

The project also needs an open-source license appropriate for an MCP server targeting both individual developers and enterprise adoption.

## Decision: Name

**`Electron Stagewright`** — npm package `electron-stagewright`, GitHub org `electron-stagewright`.

### Rationale

- **`Electron`** prefix anchors the domain unambiguously. Any developer searching "MCP for Electron" finds the project. No confusion with browser-only tools.
- **`Stagewright`** is a coined compound following the same construction as `playwright` (a writer of plays). A "stagewright" is the artisan who builds the stage on which the play is performed. The semantic relationship to Playwright (the testing framework that pioneered this space) is intentional and recognizable to the community, but the name is structurally distinct — no trademark collision, no derivative-by-naming.
- **Cultural lineage without dependency lock-in**: by deliberately _not_ using "Playwright" in the name, the project is free to migrate transports if Microsoft deprecates the `_electron` API. The name commits to a domain (driving Electron apps), not a vendor.
- **Pronunciation**: "STAGE-write". Single syllable + single syllable. Clear in English and Spanish. No diacritics, no homophones.

### Alternatives considered and rejected

| Name                 | Why rejected                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Stagehand`          | Direct collision with [browserbase/stagehand](https://github.com/browserbase/stagehand) — 22.8k stars, _"The SDK For Browser Agents"_. Adjacent domain, active development. Catastrophic confusion. |
| `Maestro`            | Direct collision with [mobile-dev-inc/maestro](https://github.com/mobile-dev-inc/maestro) — 14.2k stars, _"E2E Automation for Mobile and Web"_. Same domain.                                        |
| `Showrunner`         | Collision with active npm package (Feb 2026) for desktop screen recorder.                                                                                                                           |
| `Foreman`            | Active npm package, process manager.                                                                                                                                                                |
| `Electron Conductor` | Considered. Strong double meaning (electrical conductor + orchestra conductor) but more generic; loses semantic precision without the prefix.                                                       |
| `Electron Sentinel`  | Considered. Strong fit for the production-validation capability set, but biases perception toward a single feature rather than the holistic driver.                                                 |
| `Electron Lodestar`  | Considered. Risk of being perceived as pretentious; collision with ChainSafe Lodestar (Ethereum, 1.4k stars) outside our domain.                                                                    |

### Availability verified (2026-05-26)

- npm `electron-stagewright` — free.
- GitHub org `electron-stagewright` — free.
- GitHub user `stagewright` — squatted by inactive 2021 account (0 repos, 0 followers); not a conflict, just an unavailable username for the user-namespace alternative.

## Decision: License

**MIT License.**

### Rationale

- **Ecosystem fit**: the MCP ecosystem (Anthropic SDK, official @modelcontextprotocol/sdk, most MCP servers including mesomya/electron-driver, halilural, laststance) defaults to MIT. Choosing differently creates friction for downstream adopters who already have MIT-compatible policies.
- **Simplicity**: three paragraphs, no patent grant clause, no notice-preservation overhead beyond the standard copyright line. Lower barrier to contribution.
- **Permissiveness**: dual-licensing compatibility (downstream projects can re-license under Apache, GPL, BSL, or any other terms). Maximum flexibility for both community forks and commercial adoption.
- **No vendor mandate**: unlike Apache-2.0, MIT does not require contributors to grant patent rights explicitly. For a project whose core mechanism is documented public protocols (CDP, MCP) and accessibility APIs — none of which are likely patent-encumbered — the explicit patent grant of Apache-2.0 adds words without adding meaningful protection.

### Alternatives considered and rejected

| License                       | Why rejected                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apache-2.0                    | Stronger patent grant, used by Playwright and Electron itself. Considered as the primary alternative. Rejected because MIT is the ecosystem default for MCP and the patent grant's marginal value is low for a protocol-implementation project. Easy to revisit if a future legal review surfaces a concrete need.                               |
| BSL (Business Source License) | Considered for future commercial sustainability (managed cloud session-trace service). Rejected at this stage because (a) the community open-source perception of BSL is mixed, (b) the project has no commercial product to protect, (c) MIT preserves the option to dual-license a future SaaS layer without restricting the current OSS core. |
| GPL-3.0 / AGPL-3.0            | Rejected — would prevent embedding in proprietary downstream tools, which is exactly the adoption path for MCP servers (Claude Code, Cursor, etc. all run third-party MCP servers in proprietary processes).                                                                                                                                     |

## Consequences

- All source files use the MIT license header (or none, since LICENSE at repo root suffices under MIT).
- Contributors retain copyright on their contributions; no CLA required at this stage.
- The decision is revisitable. If a concrete commercial path emerges in the future that requires BSL or dual-licensing, the project may re-license going forward — existing releases remain MIT in perpetuity. Any such change requires a follow-up ADR.
- Brand assets (name, logo if created) are not licensed under MIT — they remain trademark-style protections of the project itself. This is standard practice (see Linux, Python, Node.js).

## References

- [Playwright MCP PR #1291 — Microsoft declining to maintain Electron support](https://github.com/microsoft/playwright-mcp/pull/1291)
- [Browserbase Stagehand](https://github.com/browserbase/stagehand) — name we explicitly avoid colliding with
- [SPDX License List](https://spdx.org/licenses/) for license identifier reference

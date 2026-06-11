# ADR-002: Runtime and Language Choice

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: johnny4young

## Context

Electron Stagewright is an MCP server that drives Electron desktop applications. Before any tool, transport, or plugin can be designed, the project needs a settled answer to four foundational questions:

1. **Which runtime** executes the server process? The choices are JavaScript runtimes that can host an MCP SDK and speak to Electron's developer-facing surfaces (the Chrome DevTools Protocol, the Node Inspector protocol, and Playwright's experimental `_electron` API).
2. **Which language** the source is written in. TypeScript vs plain JavaScript is the binary choice; the strictness profile is a second-order choice that materially affects refactor cost.
3. **Which module system** the codebase commits to. ESM vs CommonJS is decided once at the root and is expensive to reverse downstream.
4. **Which tooling** — package manager, test runner, linter, formatter — the contributor experience is built on. These choices look cosmetic but compound: every contributor pays the cost of every tool in install time and cognitive overhead.

The runtime decision is also entangled with the agent-native UX commitments captured in [ADR-007](./007-agent-native-ux-principles.md): the principles assume a JavaScript-typed schema layer (Zod), a tested MCP SDK, and a Playwright-style developer surface — all of which are tested-against-Node first. ADR-002 records the runtime + language choice; ADR-007 records the UX shape that runs on top of it.

Closely related is [ADR-003](./003-transport-abstraction.md): Microsoft's Playwright team has signalled that Playwright's `_electron` API is experimental and may be deprecated (see [Playwright MCP PR #1291](https://github.com/microsoft/playwright-mcp/pull/1291)). Choosing the runtime that aligns most closely with the MCP SDK and `_electron`'s own testing matrix reduces the blast radius if/when that deprecation lands.

## Decision

### Runtime

**Node.js** as the only supported runtime. **Minimum version: Node 24**. CI exercises both **Node 24 and Node 26** so forward-compatibility issues surface before Node 26 becomes the next LTS line.

### Language

**TypeScript 6+** for all source files. The strict-plus profile committed in [`tsconfig.base.json`](../../tsconfig.base.json) enables every relevant safety flag the compiler exposes:

| Compiler option                      | Value  |
| ------------------------------------ | ------ |
| `strict`                             | `true` |
| `noUncheckedIndexedAccess`           | `true` |
| `exactOptionalPropertyTypes`         | `true` |
| `noImplicitOverride`                 | `true` |
| `noFallthroughCasesInSwitch`         | `true` |
| `noPropertyAccessFromIndexSignature` | `true` |
| `verbatimModuleSyntax`               | `true` |
| `isolatedModules`                    | `true` |

Compilation target is `ES2023`; module resolution is `NodeNext`.

`@types/node` tracks the Node 24 major so the type surface matches the runtime floor.

### Module system

**ESM only.** No CommonJS source files, no `.cjs` entry points, no dual-package shipping. `package.json` declares `"type": "module"`, every workspace inherits `"module": "NodeNext"`, and path resolution uses `import.meta.url` rather than `__dirname`/`__filename`.

### Package manager

**pnpm 11+** with workspaces. The lockfile is committed. Contributors enable the version pinned in `package.json`'s `packageManager` field via `corepack enable`. The `engines.pnpm` floor is `>=11.0.0` to keep the manifest and this decision in agreement.

### Test runner

**Vitest 4+** for unit, integration, and example-app tests. Vitest's ESM-first design and vite-bench harness fit the project's module system and the eventual benchmark suite without parallel test runners.

### Linter

**ESLint 10+** with the flat config format and `@typescript-eslint`. No legacy `.eslintrc` files.

### Formatter

**Prettier 3.8+.** Format is decoupled from lint; `pnpm format` writes, `pnpm format:check` verifies. No Biome, no dprint at this stage.

### Platform matrix

CI exercises the runtime decision on the full cross-platform grid:

| Job              | OS                                          | Node   |
| ---------------- | ------------------------------------------- | ------ |
| Lint + Typecheck | ubuntu-latest                               | 24     |
| Test             | ubuntu-latest, macos-latest, windows-latest | 24, 26 |
| Build            | ubuntu-latest                               | 24     |
| Example smoke    | ubuntu-latest                               | 24     |

The Test job runs the six-cell matrix on every push and PR; Lint, Typecheck, Build, and example smoke are single-cell. The platform commitment is "Linux + macOS + Windows, Node 24 and 26" and is encoded in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). Any change to that matrix is a deliberate amendment to this ADR.

### Anti-goals

ADR-002 deliberately does **not** decide the following — those are out-of-scope and tracked elsewhere:

- **Bundler / build orchestration beyond `tsc`.** The current per-package build is `tsc` against `tsconfig.json`. Whether to introduce Vite, Rollup, esbuild, or tsup at the package level is a future decision driven by package-specific needs (e.g. browser-loadable trace viewer in `plugin-trace`). Not blocked by ADR-002.
- **CI provider commitment beyond "GitHub Actions for now".** GitHub Actions is the chosen CI today; nothing here forecloses moving (or duplicating) to a different provider if the project grows. Workflow files are isolated to `.github/workflows/`.
- **Documentation site stack.** Whether the docs site (planned for the next public release) runs on VitePress, Astro, Docusaurus, or plain GitHub Pages is decided when that ticket lands. The ADR for that decision will reference this one as the runtime baseline.
- **Database / persistence layer.** The MCP server is stateless across sessions; this ADR is not where session-trace storage formats are decided.

## Rationale

### Why Node, not Bun or Deno

- **MCP SDK alignment.** [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) ships as ESM TypeScript and is tested against Node first. Bun and Deno are best-effort downstream — using them shifts the compatibility-debugging burden onto this project.
- **Electron-driving toolchain alignment.** Playwright's `_electron` (today's primary transport) and the Chrome DevTools Protocol clients (`chrome-remote-interface`, the CDP transport, see [ADR-003](./003-transport-abstraction.md)) are tested-against-Node first. Choosing Node removes one variable from every transport-related bug.
- **Playwright `_electron` deprecation watch.** Microsoft has signalled the `_electron` API may be deprecated (Playwright MCP PR #1291). When that lands, this project pivots to raw CDP via ADR-003's `CDPTransport`. The pivot is much cheaper if the runtime hasn't introduced its own ESM/CommonJS or Node-API mismatch on top.
- **Boring + well-trodden.** A foundational design decision should not be the place to take a runtime gamble.

### Why Node 24 floor

- Node 24 is the current floor encoded in `.nvmrc`, root `package.json`, and `packages/core/package.json`.
- Node 26 runs in the test matrix as the forward-compatibility line.
- Both versions support native ESM in all the configurations this project uses, native `fetch`, `--watch` mode, and `node --test` (the latter is irrelevant — we use vitest — but it indicates a mature runtime).

### Why TypeScript 6 with strict-plus

- TypeScript 6 is the current major, released early 2026. The plugin model in [ADR-004](./004-plugin-model.md) leans on stable decorator semantics, `verbatimModuleSyntax`, and `exactOptionalPropertyTypes` — all of which are well-supported in 6.0+.
- Every strict-plus flag is on for the same reason: this project's tools handle untrusted runtime input (Electron app state, accessibility trees, IPC payloads). The compiler can catch entire classes of bugs (missing array bounds checks, `undefined` field access, implicit `any` flowing through generics) at edit time. Turning the flags off later is easy; turning them on later requires churn through every file.

### Why ESM only

- **No dual-package hazard.** Shipping CommonJS + ESM doubles the type-resolution surface and creates incompatible instance identities for the same class (the canonical `instanceof` failure). For a library that's loaded as a sub-process MCP server, dual packaging buys nothing.
- **Electron itself ships ESM** in the main process from Electron 28+. The runtime we automate is itself ESM-native; the automator should match.
- **The MCP SDK is ESM.** Choosing ESM here removes one transpilation step.

### Why pnpm 11

- **No phantom dependencies.** pnpm's node_modules layout prevents the "I imported it but never declared it" bug class that npm and yarn allow.
- **Hardlinked store** keeps repeat installs fast across a workspace with many packages — the plugin architecture will produce ~8-10 packages by the time the MVP ships.
- **`allowBuilds` opt-in** (pnpm 11+) makes supply-chain compromise via post-install scripts an explicit allowlist rather than a default-trust posture.
- **Workspaces** are first-class — `pnpm -F <package> ...` is the daily ergonomic that makes multi-package work tolerable.

### Why vitest, eslint flat config, prettier

- **Vitest** is ESM-native, supports `node:` imports without configuration, and shares ground truth with Vite if the docs site or any plugin ever needs a browser-side bundler. Jest's CommonJS bias and slower startup don't fit.
- **ESLint flat config** is the supported configuration format from ESLint 9 onward; starting on the legacy `.eslintrc` would mean an avoidable migration before the first release.
- **Prettier** is the boring, well-trodden choice. Biome is promising but younger; the small dependency surface added by Prettier is not a real cost.

## Alternatives considered

| Alternative                       | Why rejected                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun runtime**                   | Faster cold-start and an integrated test runner, but the MCP SDK and Playwright's `_electron` are tested-against-Node first. Bun's ESM/CommonJS resolver still has known divergences from Node's. Revisit when Bun is the primary upstream runtime for at least one of the two SDKs.                                |
| **Deno runtime**                  | Strong security posture (default-deny capabilities), but requires adapters for the npm ecosystem this project depends on (pnpm workspaces, the MCP SDK, Playwright). The friction is not worth the security upside for a tool whose users will run it from Node-based MCP hosts (Claude Desktop, Cursor, Continue). |
| **Node 20 LTS**                   | EOL April 2026 — choosing it now would force a migration within twelve months. Not worth the cost.                                                                                                                                                                                                                  |
| **TypeScript 5.x**                | Stable, but `verbatimModuleSyntax` and the latest decorator semantics matter for the plugin model. 6.0+ is mature enough that pinning earlier creates an avoidable upgrade later.                                                                                                                                   |
| **Mixed CJS/ESM**                 | Maintenance overhead, dual-package hazard, type-resolution edge cases, and `instanceof` traps. ESM-only is strictly cleaner.                                                                                                                                                                                        |
| **Jest**                          | Slower startup, CommonJS-first, awkward ESM support, and no shared ground with Vite. Vitest dominates on every relevant axis.                                                                                                                                                                                       |
| **Biome (lint+format combined)**  | Promising single-binary tool, but younger than ESLint+Prettier and has fewer rules covering `@typescript-eslint`-style concerns. Revisit when Biome reaches v2+ stable, or during the next major dependency-refresh window.                                                                                         |
| **npm or yarn (instead of pnpm)** | Both allow phantom deps. yarn 4 is competitive on speed but lacks pnpm's `allowBuilds` model. The marginal contributor friction of pnpm is dwarfed by the avoided bug class.                                                                                                                                        |

## Consequences

- The runtime / language baseline is now the load-bearing assumption for every downstream ADR. Future ADRs cite ADR-002 rather than re-justifying these decisions.
- Contributors are expected to run **Node 24 or Node 26** locally. Node 22 and below will be rejected at install time by `engines.node`.
- The `pnpm install` step requires **pnpm 11+**. Corepack handles this transparently when contributors run `corepack enable` once.
- Source files use ESM imports exclusively. Any `require()`, `module.exports`, or `.cjs` source file is a lint error.
- The CI matrix is the contract: any change to "Linux + macOS + Windows × Node 24 + 26" is an amendment to this ADR.
- The decision is revisitable. If Bun reaches feature parity with Node for the MCP SDK and Playwright `_electron`, a future ADR may add it as an additional supported runtime (not a replacement). Adding Deno would require a similar follow-up.
- **No retroactive enforcement.** Existing examples or scripts that already comply do not need changes; the ADR documents the locked baseline going forward.

## Status Update (2026-05-28) — Node 24 LTS floor

The original decision floored the runtime at Node 22 because, at the time of
drafting, Node 24 had not yet entered LTS. Node 24 is now the **Active LTS** line
(Node 22 has moved to Maintenance LTS), so the baseline moves up to match the
current LTS:

- **`engines.node` raised `>=22.0.0` → `>=24.0.0`** (root + `packages/core`). Node
  24 is a superset of the Node 22 API surface, so no source changes are required.
- **`.nvmrc` → `24`.**
- **`@types/node` realigned `^25.x` → `^24.x`.** The earlier "track the latest
  major" posture pointed the types at Node 25 — an odd, non-LTS, now-EOL line
  _ahead_ of the runtime. Pinning the types to the LTS major makes the type
  surface match the runtime: code can only reach for APIs that actually exist in
  the supported runtime.
- **CI matrix shifted `Node 22 + 24` → `Node 24 + 26`.** Single-cell jobs
  (lint/typecheck/build) run on the LTS (24); the test matrix adds the next even
  release (26, the upcoming LTS) for the same forward-compatibility window the
  original ADR sought with 24. The matrix remains the contract.

Supersedes note: earlier revisions of this ADR framed Node 22 as the floor and
Node 24 as the forward-compat line. The current decision is Node 24 as the floor
and Node 26 as the forward-compat test line.

## Related decisions

- [ADR-001](./001-naming-and-license.md) — Naming and License. ADR-002 inherits the MIT license posture: tooling choices avoid copyleft constraints that would conflict with downstream MIT users.
- [ADR-007](./007-agent-native-ux-principles.md) — Agent-native UX principles. The principles assume the Node/TypeScript ecosystem: Zod schemas for tool inputs, the MCP SDK's response envelope shape, and the Playwright-style developer surface. ADR-007 is downstream of ADR-002 in this sense — when ADR-007 was drafted, ADR-002's runtime choice was already implicit in the toolchain. This ADR makes that dependency explicit.
- [ADR-003](./003-transport-abstraction.md) — Transport abstraction. Defines how `PlaywrightElectronTransport`, `CDPTransport`, and `InjectorTransport` are structured on top of the Node runtime committed here.

## References

- [Node.js Release Schedule](https://github.com/nodejs/release#release-schedule) — Node LTS dates.
- [TypeScript 6.0 release notes](https://www.typescriptlang.org/) — language and compiler flags.
- [`@modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP SDK runtime expectations.
- [pnpm workspaces documentation](https://pnpm.io/workspaces) and [`allowBuilds`](https://pnpm.io/package_json#pnpmallowbuilds) supply-chain posture.
- [Vitest 4.x documentation](https://vitest.dev/).
- [Playwright MCP PR #1291](https://github.com/microsoft/playwright-mcp/pull/1291) — the `_electron` deprecation signal that informs the runtime / transport pairing.
- [ESLint flat config migration guide](https://eslint.org/docs/latest/use/configure/migration-guide).

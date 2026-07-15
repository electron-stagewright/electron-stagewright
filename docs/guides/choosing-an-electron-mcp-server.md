# Choose an Electron MCP server

Electron automation servers overlap in the basics: launch an app, inspect its UI, and send input.
The useful choice is therefore about the workflow you need to prove, the trust boundary you can
accept, and the recovery information your agent needs when a run does not go as planned — not a
single tool-count or latency score.

This guide compares the public surfaces that were reviewed on **2026-07-15**. Projects change;
follow the linked primary documentation before making a production decision.

## The practical choices

| If your primary need is…                                                     | Start by evaluating…                                                                | Why                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A compact, single-session Playwright driver for a built Electron entry point | [electron-driver](https://github.com/mesomya/electron-driver)                       | Its public v0.3.0 README describes a 38-tool, Playwright `_electron` server with one owned session, selector-oriented interaction, screenshots, console capture, and main/renderer eval.   |
| CDP-oriented automation and a configurable security-level model              | [laststance/electron-mcp-server](https://github.com/laststance/electron-mcp-server) | Its v2 README describes CDP integration, approximately 40 granular `electron_*` tools, and `STRICT` through `DEVELOPMENT` security profiles.                                               |
| Agentic UX testing that must inspect, assert, recover, and leave evidence    | Electron Stagewright                                                                | It combines stable snapshot refs, retrying `electron_expect_*` assertions, structured recovery envelopes, multi-session lifecycle control, trace/replay, and explicit first-party plugins. |

None of these rows is a claim that one project is universally better. The right answer depends on
your Electron app, the host agent, and the workflow you need to make repeatable.

## Choose Electron Stagewright when

- **An agent must verify an outcome, not merely send input.** The `electron_expect_*` family keeps
  polling, comparison, and the final expected/actual evidence in one server-side call. See
  [Assert UI state](./assert-ui-state.md).
- **Your app needs a resilient inspection loop.** Snapshots use accessible roles, names, state, and
  stable refs; errors carry codes, recovery hints, and similar-ref candidates instead of leaving
  the host to parse prose. [Concepts](./concepts.md) explains that model.
- **You need more than a fresh launch.** A session can launch, attach through CDP, or inject into a
  compatible running process. Apps with a project-owned Electron runtime can opt into
  `runtime: "project"` so native modules are tested against the runtime that will load them. See
  [Launch, attach, or inject](./launch-or-attach.md).
- **The workflow needs specialized, explicit capabilities.** First-party plugins add trace/replay,
  IPC observation, network capture and stubbing, virtual time, storage, native UI, production
  validation, accessibility audits, and visual baselines without making every server expose every
  tool. See [Load, configure, and diagnose plugins](./plugins.md).

## Evaluate alternatives on their strengths

It is healthy to keep the surrounding ecosystem in the evaluation set.

- Start with **electron-driver** when a small Playwright-powered surface and a known main-process
  entry are enough for the task. Its README is also the source of the mechanical mapping in our
  [migration guide](./migrate-from-electron-driver.md).
- Start with **laststance** when its CDP-centric workflow and its environment-configured security
  levels match your operating model. Read its current security documentation before assuming a
  profile gives the same guarantees as this project's explicit eval and plugin gates.

Use a disposable test app and the same host configuration for every candidate. A successful
installation is not evidence that the server can prove your real workflow.

## Compare workflows, not a leaderboard

Tool counts, raw request bytes, and a local latency number measure different things. A server that
returns a richer recovery envelope or keeps a retry loop on the server may transfer more data for a
single primitive action while reducing the number of agent turns needed to finish a workflow.

Electron Stagewright keeps a reproducible, shared-task benchmark harness in
[`packages/bench`](../../packages/bench/README.md). It records protocol facts and uses pinned
adapters, but it is deliberately **not** a universal public ranking: one machine, one host, and a
small fixture cannot predict your app's startup, renderer complexity, security policy, or agent
behavior.

For a decision you can defend, run the same three workflows against each candidate:

1. **Inspect:** launch or attach, find an accessible control, and obtain the state needed for the
   next action.
2. **Change and assert:** mutate the app, then prove the expected result with a bounded wait and
   useful failure evidence.
3. **Recover:** deliberately invalidate a ref, reload a renderer, close a window, or introduce a
   slow response. Check whether the host gets a stable error, an actionable next step, and enough
   context to continue safely.

Keep the artifacts, versions, app fixture, host configuration, and hardware facts beside the
result. That evidence is more useful than a copied benchmark number.

## A short selection checklist

Before committing to a server, answer these questions with a real app:

1. Can it reach the app in the mode you need: launch, CDP attach, or process injection?
2. Can an agent identify controls through the accessibility semantics your app actually exposes?
3. Does a failed assertion report a machine-readable cause and a safe recovery path?
4. Are powerful capabilities — eval, network mutation, storage reads, or native instrumentation —
   explicit opt-ins with an understandable operator boundary?
5. Can you save a reproducible artifact or test specification when a workflow fails?

If the answer is consistently yes, the server is a good fit for your workflow — regardless of
which name appears first in a comparison table.

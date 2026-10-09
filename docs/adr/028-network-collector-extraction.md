# ADR-028: Defer extracting the Playwright transport's network collector

- **Status:** Accepted (extraction deferred)
- **Date:** 2026-10-05

## Context

`packages/core/src/transports/playwright-electron.ts` is the largest transport module. A candidate
seam would move network capture and stubbing into an internal collaborator. That seam owns network
buffers and overflow, the active capture-filter identity, in-flight response/body reads, stub
ordering and finite uses, and route attachment to current and late windows. Page/window identity,
listener deduplication, session disposal and active-surface ownership are shared with other
transport behavior, so a file split would have to preserve those ownership edges.

Reviewed source: `6598c945a126eaf7cff40c9e816897ba044eaaac`, the transport and its contract tests.
The available Git history shows no changes to this transport between 13 July 2026 and that commit.
The last listed change is dependency maintenance (`30b41ac`); adjacent substantive changes concern
surface targeting (`59bc74a`) and window/detach handling (`5667ddd`).
Network-specific capture/stubbing/body work clustered in June (`2fc9d60`, `309f413`, `63bd0f5`),
not in sustained recent churn. This is bounded historical evidence for that checkout, not a
prediction of future work.

There is no current review-coupling cost, defect, or measured performance benefit that would
justify taking lifecycle risk now. As of the reviewed commit, exact-head real-Electron network
qualification for the current dependency tuple had not been recorded. The
[compatibility guide](../guides/compatibility.md) now records subsequent exact-tree qualification;
that evidence does not by itself justify a collector extraction.

## Decision

Defer the extraction. Keep transport behavior and the public session API unchanged. This is an
evidence-dependent maintenance decision, not a response to a demonstrated behavior defect.

## Revisit trigger and acceptance criteria

Reconsider during substantial network-feature work, or once repeated collector-only changes show a
costly review coupling. If extracted, move only network capture/stub state into one internal
collaborator; keep session methods, page/window ownership and public packages unchanged.

Before accepting an extraction, require the existing network/stub/multi-window test groups and the
real network smoke on all maintained native lanes. Specifically preserve:

- the armed-filter identity re-check after both awaits (`request.response()` and the body read);
- event ordering, buffer caps and overflow;
- stop/start/clear semantics;
- first-match stub ordering, finite expiry, delay behavior and fallback continuation;
- route detachment, late windows and disposal.

A cosmetic file split alone does not satisfy these criteria.

## Alternatives considered

- **Extract the collector now** — rejected for now. It takes lifecycle risk (shared page/window
  ownership, listener deduplication, disposal) without a measured review, defect or performance
  benefit.
- **Cosmetic file split** — rejected. Moving code without a single owner for capture/stub state
  adds a module boundary without reducing the shared ownership edges described above.

## Consequences

- No code changes; this record makes no speed, correctness or compatibility claim.
- Compatibility qualification work proceeds independently of this decision.

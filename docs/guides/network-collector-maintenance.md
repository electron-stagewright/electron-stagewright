# Network collector extraction disposition

Decision on 5 October 2026: defer the extraction. Keep transport behavior and the public session
API unchanged. This finding is evidence-dependent maintenance, not a demonstrated behavior defect.

## Reviewed evidence

Source: `6598c945a126eaf7cff40c9e816897ba044eaaac`,
`packages/core/src/transports/playwright-electron.ts` and its transport contract tests.
The candidate seam owns network buffers/overflow, the active capture-filter identity, in-flight
response/body reads, stub ordering/finite uses, and route attachment to current and late windows.
Page/window identity, listener deduplication, session disposal and active surface ownership are
shared with other transport behavior. A file split would need to preserve those ownership edges.

The available full Git history has no changes to this transport after 13 July 2026 and no changes
in August through this source's latest commit. The last listed change is dependency maintenance
(`30b41ac`); adjacent substantive changes concern surface targeting (`59bc74a`) and window/detach
handling (`5667ddd`). The network-specific history shows capture/stubbing/body work clustered in
June (`2fc9d60`, `309f413`, `63bd0f5`), rather than current sustained network-feature churn.
This is bounded historical evidence for this reviewed checkout, not a prediction of future work.

The maintenance batch changes qualification and source documentation, not network behavior.
No current review-coupling cost, defect or measured performance benefit justifies taking lifecycle
risk now. Exact-head real-Electron/network qualification is also unavailable in the current cloud
workstation; hosted dependency and real-runtime qualification must be established before any
extraction is promoted.

## Revisit trigger and bounded acceptance

Reconsider during substantial network-feature work or after documented repeated collector-only
changes demonstrate costly review coupling. Extract only network capture/stub state into one
internal collaborator. Keep session methods, page/window ownership and public packages unchanged.

Before accepting an extraction, require the existing network/stub/multi-window groups and real
network smoke on all maintained native lanes. Specifically preserve filter-generation guards
across both response awaits, event ordering, buffer caps/overflow, stop/start/clear semantics,
first-match stub ordering, finite expiry, delay behavior, fallback continuation, route detachment,
late windows and disposal. A cosmetic split alone does not satisfy this finding's condition.

The present disposition adds documentation only. It makes no speed, correctness or compatibility
claim and should not delay the qualification work.

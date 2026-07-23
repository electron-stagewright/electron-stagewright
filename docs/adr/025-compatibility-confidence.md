# ADR-025: Compatibility confidence

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Electron Stagewright crosses several independently versioned boundaries: Node, Electron, Playwright,
the host operating system, and one of three transport implementations. A package range or a passing
unit test does not prove that a real desktop process launches and remains controllable on every
combination. In particular, Windows previously had unit coverage but no hosted real-Electron proof.

An unqualified “cross-platform” claim would therefore hide meaningful differences. The production
plugin is intentionally macOS-specific today, Injector has narrower capability coverage than
Playwright and CDP, and native-addon ABI recovery has only been exercised on Linux and macOS.

## Decision

Compatibility claims are evidence-based and split into three levels:

1. **Supported and real-runtime verified** — a required hosted job launches Electron and runs the
   gated integration suite on that operating system.
2. **Supported and unit verified** — the ordinary OS/Node matrix passes, but no real runtime is
   exercised for that exact combination.
3. **Not verified or intentionally unsupported** — the documentation names the limitation rather
   than implying support.

Required real-Electron lanes run on Ubuntu, macOS, and Windows with the Node floor. The ordinary test
matrix continues to cover Node 24 and 26 on all three operating systems. The public compatibility
guide records the exact version policy, transport evidence, platform-specific plugin boundaries, and
the difference between current CI evidence and broad ecosystem compatibility.

Compatibility documentation must change with the workflow or supported-version policy. It may claim
only combinations that a required check or a named, reproducible manual validation actually proves.

## Consequences

- Windows regressions in launch, renderer integration, plugin loading, or packed CLI behavior block
  pull requests instead of surfacing after publication.
- CI cost increases by one serialized real-Electron job.
- The matrix is deliberately conservative: a compatible package range is not represented as tested
  across every version in that range.
- Platform-specific capabilities remain explicit, so adding a new CI lane does not accidentally
  imply that macOS signing or native UI behavior exists on Windows or Linux.

# vanilla fixture

The framework-agnostic **baseline**: the shared UI contract (a "Your name" input, a
"Greet" button, a `#status` line) implemented with plain DOM and a single event
listener — no framework, no build step.

It exercises the harness's happy path with zero framework indirection, so any failure
here is a harness or core problem, not a framework-interaction one. The framework
fixtures are judged against this baseline: they must be driveable by the **same**
scenario.

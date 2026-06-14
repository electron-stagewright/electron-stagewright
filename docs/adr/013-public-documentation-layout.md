# ADR-013: Public documentation layout

Status: Accepted.

## Context

The repository's `docs/` directory began life as a private workspace and is gitignored as a whole
(`docs/*`). When the Architecture Decision Records became public, `docs/adr/` was re-included via a
gitignore negation rather than moved, keeping the conventional path. The generated tool reference
predates that exception: it was placed at the repository root (`TOOL-REFERENCE.md`) precisely
because nothing under `docs/` could be tracked at the time.

User-facing guides (a getting-started tutorial, task-oriented how-tos, a migration guide) now need
a public home. Three layouts were on the table: more root-level files, a new top-level directory,
or further re-includes under `docs/`.

## Decision

Public documentation lives under `docs/`, re-included directory by directory through explicit
gitignore negations:

- `!docs/adr/` — the Architecture Decision Records (the "why").
- `!docs/guides/` — the user guides (the "how"): tutorial, how-tos, migration.

Two rules keep this layout safe and legible:

1. **Each re-included directory is wholly public.** Nothing private may be placed inside a
   re-included directory, and a tracked file must never link to a path outside the re-included
   set (the rest of `docs/` is local-only and would 404 for everyone else). A repository test
   enforces the link rule mechanically.
2. **The repository root keeps exactly two documentation artifacts**: `README.md` (the landing
   page) and the generated `TOOL-REFERENCE.md`. The tool reference stays at the root rather than
   moving under `docs/` — it is the most linked-to artifact and link stability outweighs tidiness.

## Alternatives considered

- **A top-level `guides/` directory** — avoids gitignore negations, but splits the public docs
  across two roots (`guides/` + `docs/adr/`) and breaks the convention that documentation lives
  under `docs/`.
- **More root-level files** (`GETTING-STARTED.md`, …) — the root stops scaling past a couple of
  documents and every addition pollutes the first screen of the repository.
- **Moving the ADRs and guides to a separate docs repository or site generator** — premature; a
  static-site pipeline can consume `docs/adr/` + `docs/guides/` later without moving anything.

## Consequences

- Adding a new public docs directory is a one-line gitignore negation plus an entry in the guides
  index — and implicitly a commitment that everything inside it is public.
- The local-only planning documents continue to live untracked directly under `docs/`, so a
  contributor cloning the repository sees only the public set.
- `TOOL-REFERENCE.md` stays a root-level generated artifact (regenerated via `pnpm docs:tools`,
  drift-guarded by a sync test); guides reference it relatively.

## Related decisions

- ADR-001 (naming and license) — the public-repo posture this layout serves.
- ADR-007 (agent-native UX principles) — the design language the guides document.

## Status Update — 2026-06-14

The guides directory is now organized internally by the four
[Diátaxis](https://diataxis.fr) modes, so each page has one job and a reader can tell which from its
type:

- **Tutorial** — `getting-started.md`.
- **How-to** — `launch-or-attach.md`, `assert-ui-state.md`, `capture-diagnostics.md`,
  `migrate-from-electron-driver.md`.
- **Explanation** — `security-model.md` and the new **`concepts.md`**, which fills the previously
  missing quadrant: a single page explaining the agent-native model (the response envelope, refs
  versus selectors, snapshots and diffs, retrying assertions, sessions and transports, and the
  eval/plugin trust model) and linking each concept to the ADR that decided it rather than
  restating the decision.
- **Reference** — the root `TOOL-REFERENCE.md` and `docs/adr/`.

The guides index (`docs/guides/README.md`) labels these four modes explicitly, and each how-to
closes with a pointer up to `concepts.md`. This refines how the `docs/guides/` directory is
organized; the layout decision above — public docs re-included directory by directory, the root
holding only `README.md` and `TOOL-REFERENCE.md` — is unchanged.

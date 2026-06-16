# Releasing

How a maintainer publishes the `@electron-stagewright/*` packages to npm. The project is
pre-1.0; this is the checklist that turns a green `main` into a published release. The
governance and semver policy behind it is [ADR-015](../docs/adr/015-project-governance.md);
the package shape these steps assume is verified in CI by `packages/core/tests/packaging.test.ts`.

## What publishes

The publishable packages are every `packages/*` that is **not** `private: true`:

- `@electron-stagewright/core` (ships the `electron-stagewright` CLI)
- `@electron-stagewright/plugin-trace`
- `@electron-stagewright/plugin-ipc`
- `@electron-stagewright/plugin-production`

Everything under `examples/` and `packages/bench` is `private: true` and never publishes. Each
publishable package sets `publishConfig.access: "public"` (scoped packages default to restricted)
and an `engines.node` floor matching [ADR-002](../docs/adr/002-runtime-and-language.md).

## Versioning

Semver, with pre-1.0 support for the latest minor only (ADR-015). Packages version
**independently** — a change to the IPC plugin bumps only that package. The license is MIT
([ADR-001](../docs/adr/001-naming-and-license.md)).

**The `workspace:*` gotcha.** First-party packages depend on the core via `"@electron-stagewright/core":
"workspace:*"`. On publish, pnpm rewrites `workspace:*` to the **exact core version in the local
manifest**. For the first release, publish the whole set together. After that, if a plugin changes
but core does not, confirm the local core version already exists on npm before publishing the plugin.
If core changes too, publish core first (or in the same recursive publish) so the plugin never pins
an unpublished core version.

## Prerequisites

- npm account with publish rights on the `@electron-stagewright` scope, with 2FA enabled.
- `corepack enable` so the pinned pnpm version is used.
- A clean, up-to-date `main` checkout.

## Checklist

1. **Green main.** `pnpm install && pnpm verify` — lint, typecheck, test (including the packaging
   gate), build, and format check must all pass.
2. **Set versions.** Bump the `version` of each package being released (and confirm the local core
   version is already published, or is being published now, per the `workspace:*` note above). Update
   each package's notable changes if a changelog is kept.
3. **Build fresh.** `pnpm build` — the published tarball ships only `dist/` (plus `README.md` and
   `LICENSE`), so the build must be current.
4. **Dry-run.** `pnpm -r publish --dry-run` for a whole-set release, or put each selector before
   `publish` for a filtered release (for example,
   `pnpm -r --filter @electron-stagewright/plugin-ipc publish --dry-run`). Inspect the reported
   tarball contents: each package includes its `dist/`, `README.md`, and `LICENSE`, and excludes
   `src/` and tests.
5. **Publish.** `pnpm -r publish --access public` for a whole-set release, or the same filtered
   command used in the dry-run with `--access public`. The `--access public` flag is also set
   per-package via `publishConfig`, so it is belt-and-suspenders. Enter the npm 2FA OTP when prompted.
6. **Tag and release.** Tag the release commit (e.g. `git tag core-vX.Y.Z`) and push the tag; cut a
   GitHub release with the notable changes.
7. **Verify the install.** From a scratch directory, confirm `npx @electron-stagewright/core` resolves
   and the server starts over stdio.

## If something is wrong post-publish

npm publishes are immutable. Do **not** force a fix by republishing the same version — bump a patch
and publish again. Use `npm deprecate` to steer users off a broken version; reserve `npm unpublish`
for the 72-hour window and genuine mistakes only.

See also [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and
[GOVERNANCE.md](./GOVERNANCE.md) for who can cut a release.

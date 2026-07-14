# Releasing

How a maintainer publishes the `@electron-stagewright/*` packages to npm. The project is
pre-1.0; this is the checklist that turns a green `main` into a published release. The
governance and semver policy behind it is [ADR-015](../docs/adr/015-project-governance.md);
the package shape these steps assume — and that this list names exactly the packages that publish — is verified in CI by `packages/core/tests/packaging.test.ts`.

## What publishes

The publishable packages are every `packages/*` that is **not** `private: true`:

- `@electron-stagewright/core` (ships the `electron-stagewright` CLI)
- `@electron-stagewright/demo` (local-only Electron connection-verification app)
- `@electron-stagewright/plugin-a11y` (surface-scoped automated accessibility audits)
- `@electron-stagewright/plugin-clock` (virtual-time control)
- `@electron-stagewright/plugin-ipc` (IPC capture, invoke, and stub)
- `@electron-stagewright/plugin-native-ui` (app menus, notifications, and system tray)
- `@electron-stagewright/plugin-network` (request/response capture and stub)
- `@electron-stagewright/plugin-production` (packaged-app validation)
- `@electron-stagewright/plugin-storage` (cookies, web storage, and IndexedDB)
- `@electron-stagewright/plugin-trace` (session trace, token budget, and replay)
- `@electron-stagewright/plugin-visual` (safe visual baseline capture and comparison)

Everything under `examples/`, `packages/bench`, and `packages/testkit` is `private: true` and never
publishes. Each publishable package sets `publishConfig.access: "public"` (scoped packages default to
restricted) and an `engines.node` floor matching [ADR-002](../docs/adr/002-runtime-and-language.md).

## Versioning

Semver, with pre-1.0 support for the latest minor only (ADR-015). Packages version
**independently** — a change to the IPC plugin bumps only that package. The license is MIT
([ADR-001](../docs/adr/001-naming-and-license.md)).

**The `workspace:*` gotcha.** First-party packages depend on the core via `"@electron-stagewright/core":
"workspace:*"`. On publish, pnpm rewrites `workspace:*` to the **exact core version in the local
manifest**. When introducing a new shared core version, publish the whole set together. After that, if a plugin changes
but core does not, confirm the local core version already exists on npm before publishing the plugin.
If core changes too, publish core first (or in the same recursive publish) so the plugin never pins
an unpublished core version.

## Manual publish from a maintainer machine (current default)

A maintainer publishes from their own machine with an interactive npm login and 2FA. This needs no
npm-side trusted-publisher configuration and no token in CI. The OIDC workflow further below is an
optional automation layer for later.

Prerequisites: a clean, up-to-date `main`; `npm whoami` shows you logged in with a 2FA-capable
session (run `npm login --auth-type=web` if not); and an account with publish rights on the
`@electron-stagewright` scope.

1. **Set versions and validate.** Bump each package's `version`, then run
   `pnpm install && pnpm verify && pnpm release:validate` — the last packs every tarball and asks npm
   to validate it without publishing.
2. **Build.** `pnpm build` — `dist/` is the only published content, so it must be current.
3. **Publish.** `pnpm -r publish --no-git-checks --otp <code>`, where `<code>` is a fresh six-digit
   2FA code. pnpm publishes in dependency order (so the core version a plugin pins via `workspace:*`
   exists first), rewrites `workspace:*` to the exact version, and skips both private packages and any
   version already on npm. A brand-new package publishes its first version here too. `--no-git-checks`
   lets the publish proceed with unrelated uncommitted files present (e.g. local notes).
4. **Re-run on an expired code.** Accounts on `auth-and-writes` 2FA require a code per write, so a
   long run can outlast one code. Just run the same command again with a new code — pnpm skips
   everything already on npm and finishes the rest.
5. **Tag and record.** Tag the release commit `vX.Y.Z` matching the core version, push it, and cut a
   GitHub release with the notable changes.
6. **Verify.** Confirm each package page shows the new version, then from a scratch directory run
   `npx --package @electron-stagewright/core --package playwright --package electron electron-stagewright --version`.

The **Publish packages** workflow (`.github/workflows/release.yml`) still fires on a published GitHub
release. Until trusted publishers are configured (below), that run fails at the publish step and is
safe to ignore — the packages are already on npm from the manual publish. To stop it firing on every
release, remove the `release: published` trigger and keep only `workflow_dispatch`.

## Trusted publishing setup (optional automated alternative)

The steps below wire up OIDC so the workflow publishes without a maintainer running commands locally.
It is optional; the manual flow above is the current default. Publishing through it is performed only
by `.github/workflows/release.yml` on a GitHub-hosted runner. Its
`npm-publish` environment must be protected with the maintainers who may
approve a release. The job has `id-token: write` and uses npm 11.5.1; it deliberately receives no
long-lived publishing credential. pnpm creates workspace-correct tarballs, then npm publishes those
tarballs through its OIDC trusted-publisher exchange. npm automatically attaches provenance for this
public repository and public packages.

Before a package is published from Actions, a maintainer with npm access must configure the same
trusted publisher for that existing public package. In npm package settings, select GitHub Actions
and enter exactly:

- Organization: `electron-stagewright`
- Repository: `electron-stagewright`
- Workflow filename: `release.yml`
- Environment: `npm-publish`
- Allowed action: `npm publish`

The equivalent authenticated npm command (for a package that already exists in npm) is:

```bash
for package in $(node -e "for (const p of require('fs').readdirSync('packages')) { const m=require('./packages/'+p+'/package.json'); if (m.private) continue; console.log(m.name) }"); do
  npm trust github "$package" --file release.yml --repo electron-stagewright/electron-stagewright \
    --env npm-publish --yes
done
```

The loop only enumerates package names — the `node -e` payload uses `if (m.private) continue` rather
than `if (!m.private)` because an interactive `zsh` treats a bare `!` as a history expansion. Run it
against a package that already exists in npm; a never-published package must go through the bootstrap
below first, or `npm trust github` returns a not-found error for it.

Each npm package accepts one trusted publisher at a time, and the values above are case-sensitive.
Validate one protected OIDC release before restricting token-based publishing in npm and revoking
obsolete write credentials. Do not configure an npm publish token as a GitHub secret.

### Recognizing an unconfigured trusted publisher

This one-time configuration is required for every publishable package — including ones previously
published by hand — before its first OIDC release. Until it is in place, the workflow's publish step
fails on that package with a masked authorization error even though every earlier validation step
passed and the package already exists: `npm error code E404` and `404 ... could not be found or you
do not have permission to access it` on the `PUT` to the package URL. Register the trusted publisher
(and complete the bootstrap below for a package that has never been published), then re-run the
workflow as described under _If something is wrong post-publish_.

### First publication bootstrap

npm can add a trusted publisher only after the package already exists in the registry. For a new
package, publish its first version manually from a maintainer machine using interactive npm login and
2FA — never by adding a write credential to Actions. Then run the trusted-publisher command above for
that package. At the time of this guide, the initial bootstrap is still needed for
`@electron-stagewright/demo`, `@electron-stagewright/plugin-a11y`, and
`@electron-stagewright/plugin-visual`; their core dependency version already exists on npm.

After each bootstrap, start the **Publish packages** workflow with `publish` false to validate the
protected path. The next version change must be released through OIDC, with a maintainer approving
the environment; only after that first successful OIDC publish should token-based publishing be
restricted or revoked.

## Prerequisites

- npm account with publish rights on the `@electron-stagewright` scope, with 2FA enabled, used only
  to configure trusted publishers and administer package settings.
- `corepack enable` so the pinned pnpm version is used for local package validation.
- A clean, up-to-date `main` checkout and a GitHub release/tag for an actual publish.

## Checklist

1. **Set versions.** Bump the `version` of each package being released (and confirm the local core
   version is already published, or is being published now, per the `workspace:*` note above). Update
   each package's notable changes if a changelog is kept.
2. **Validate locally.** `pnpm install && pnpm verify && pnpm release:validate` — this rebuilds the
   package tarballs and asks npm to validate them without publishing. The release workflow repeats
   `pnpm verify`, the isolated Electron package smoke, and a dry-run for only versions not yet on npm.
3. **Tag and release.** Tag the release commit with `vX.Y.Z` matching the core version — a
   lightweight tag on the release commit (e.g. `git tag v0.2.0`) — and push it; cut a GitHub
   release with the notable changes. Publishing the release invokes the protected OIDC workflow;
   approve the environment only after reviewing its green validation steps. Packages version
   independently, so the workflow skips versions already present in npm and publishes remaining
   packages in dependency order.
4. **Verify the result.** Download the workflow's `npm-release-summary` artifact. It records each
   package as already published, dry-run validated, published with its npm integrity, or failed.
   Confirm the npm package page shows provenance, then from a scratch directory verify that
   `npx @electron-stagewright/core` resolves and starts over stdio.

For a scoped rehearsal from the Actions UI, run **Publish packages** manually with `publish` left
false. For an intentional manual publish, select the packages, set `publish` true, and approve the
same protected `npm-publish` environment.

## Publish to the official MCP Registry

The [MCP Registry](https://registry.modelcontextprotocol.io/) lists `@electron-stagewright/core` under
the namespace `io.github.electron-stagewright/core`. The registry hosts only metadata, so the npm
package must already be published. Ownership is proven two ways that must agree: the published
`packages/core/package.json` carries an `mcpName` field equal to the server name, and the publish
runs from a GitHub OIDC token minted inside the `electron-stagewright` org's own repository (the
workflow below).

1. Ensure `packages/core/package.json` has `"mcpName": "io.github.electron-stagewright/core"`, and that
   `server.json` (repo root) and the `mcpName`/npm package are all on the same version.
2. Publish that version to npm first (the steps above).
3. Run the **Publish to MCP Registry** workflow (`.github/workflows/mcp-registry.yml`) from the
   Actions tab, or `gh workflow run mcp-registry.yml`. It installs `mcp-publisher`, authenticates
   with `mcp-publisher login github-oidc`, validates, and publishes `server.json`.

The org namespace `io.github.electron-stagewright/*` is authorized **only** by a GitHub OIDC token
minted inside this org's repository, so the publish must run from Actions. A local `mcp-publisher
login github` device flow authenticates a maintainer as themselves and grants only their personal
`io.github.<user>/*` namespace — it cannot publish the org server. (A GitHub PAT with `read:org` and
`read:user` passed to `mcp-publisher login github --token` is the only local alternative; the OIDC
workflow is preferred and needs no secret.)

Bumping core re-runs this: update `server.json` and the `mcpName` package version, republish npm,
then run the workflow again.

## If something is wrong post-publish

npm publishes are immutable. Do **not** force a fix by republishing the same version — bump a patch
and create a new GitHub release when source changes are required. The release summary artifact
identifies any package that completed before a later package failed; leave those versions intact.
If the failed package never reached npm and the failure was only external configuration, correct it
and rerun the existing workflow: a `release` event does not re-fire on its own and the release's
versions are immutable, so start **Publish packages** from the Actions UI (or `gh workflow run
release.yml -f packages=all -f publish=true`) and approve the `npm-publish` environment. The workflow
skips versions already on npm and publishes the remainder in dependency order. If the package contents
need repair, bump its version and publish only that new version through the workflow. Use `npm deprecate` to steer users off a broken version;
reserve `npm unpublish` for the 72-hour window and genuine mistakes only.

See also [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and
[GOVERNANCE.md](./GOVERNANCE.md) for who can cut a release.

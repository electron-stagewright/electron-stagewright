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

## Trusted publishing setup

Publishing is performed only by `.github/workflows/release.yml` on a GitHub-hosted runner. Its
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
for package in $(node -e "for (const p of require('fs').readdirSync('packages')) { const m=require('./packages/'+p+'/package.json'); if (!m.private) console.log(m.name) }"); do
  npm trust github "$package" --file release.yml --repo electron-stagewright/electron-stagewright \
    --env npm-publish --allow-publish --yes
done
```

Each npm package accepts one trusted publisher at a time, and the values above are case-sensitive.
Validate one protected OIDC release before restricting token-based publishing in npm and revoking
obsolete write credentials. Do not configure an npm publish token as a GitHub secret.

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
`packages/core/package.json` carries an `mcpName` field equal to the server name, and the publisher
authenticates as a member of the `electron-stagewright` GitHub org.

1. Ensure `packages/core/package.json` has `"mcpName": "io.github.electron-stagewright/core"`, and that
   `server.json` (repo root) and the `mcpName`/npm package are all on the same version.
2. Publish that version to npm first (the steps above).
3. Install the publisher CLI (`brew install mcp-publisher`, or a release binary from
   `modelcontextprotocol/registry`).
4. From the repo root: `mcp-publisher login github` (GitHub OAuth — must be an org member), then
   `mcp-publisher publish --dry-run` to validate, then `mcp-publisher publish`.

Bumping core re-runs this (update `server.json` + the `mcpName` package version, republish npm, then
`mcp-publisher publish`).

## If something is wrong post-publish

npm publishes are immutable. Do **not** force a fix by republishing the same version — bump a patch
and create a new GitHub release when source changes are required. The release summary artifact
identifies any package that completed before a later package failed; leave those versions intact.
If the failed package never reached npm and the failure was only external configuration, correct it
and rerun the existing workflow. If the package contents need repair, bump its version and publish
only that new version through the workflow. Use `npm deprecate` to steer users off a broken version;
reserve `npm unpublish` for the 72-hour window and genuine mistakes only.

See also [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and
[GOVERNANCE.md](./GOVERNANCE.md) for who can cut a release.

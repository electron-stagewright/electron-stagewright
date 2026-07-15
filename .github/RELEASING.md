# Releasing

How a maintainer ships a release of the `@electron-stagewright/*` packages. The default path is a
**manual npm publish from a maintainer machine** plus an **OIDC workflow for the MCP Registry** —
neither needs a long-lived token in a GitHub secret. The project is pre-1.0; governance and semver
policy are in [ADR-015](../docs/adr/015-project-governance.md). The set of packages that publish is
verified in CI by `packages/core/tests/packaging.test.ts`, and the shape of the release workflow by
`packages/core/tests/release-workflow.test.ts`.

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

## Do a release

Follow this top to bottom. It publishes to npm by hand and to the MCP Registry from Actions.

**Prerequisites**

- A clean, up-to-date `main`, and `pnpm verify` green.
- `npm whoami` shows you logged in with a 2FA session — run `npm login --auth-type=web` if not.
- Publish rights on the `@electron-stagewright` npm scope, and public membership of the
  `electron-stagewright` GitHub org (for the MCP Registry step).

**Steps**

1. **Bump versions.** Raise the `version` of each package being released. If `core` changes, also
   bump `server.json` (repo root) to the same core version; `packages/core/package.json`'s `mcpName`,
   `server.json`, and the npm `core` version must all match. Independent versioning applies — a
   plugin-only change bumps just that plugin (see the `workspace:*` note below).
2. **Validate.** `pnpm install && pnpm verify && pnpm release:validate`. The last packs every tarball
   and asks npm to validate it without publishing.
3. **Build.** `pnpm build` — `dist/` is the only published content, so it must be current.
4. **Publish to npm.** `pnpm -r publish --no-git-checks --otp <code>`, where `<code>` is a fresh
   six-digit 2FA code (the bare number, no angle brackets). pnpm publishes in dependency order (so a
   plugin's pinned core version exists first), rewrites `workspace:*` to the exact version, and skips
   private packages and any version already on npm. **A brand-new package publishes its first version
   here too — no special setup.** If a code expires mid-run (an `auth-and-writes` account needs a code
   per write), just re-run the same command with a new code; already-published versions are skipped.
5. **Tag and cut the GitHub release.** `git tag vX.Y.Z && git push origin vX.Y.Z` matching the core
   version, then `gh release create vX.Y.Z --generate-notes` (or the Actions/UI equivalent).
6. **Publish to the MCP Registry.** Once the npm version is live, `gh workflow run mcp-registry.yml`,
   then follow it with `gh run watch <run-id>`. It authenticates from Actions via OIDC and publishes
   `server.json`. Only an in-org Actions run can publish the `io.github.electron-stagewright/*`
   namespace — see [MCP Registry details](#mcp-registry-details).
7. **Verify.**
   - npm: each package page shows the new version, then run `pnpm published:npx:smoke` from the
     release checkout. It uses a fresh temporary npm and Electron cache, absorbs the first Electron
     install's stdout outside MCP, and then asserts what the published package owns: the warmed
     pinned `npx` command emits **exactly one valid `doctor --json` document** on stdout (an MCP host
     could not parse a polluted stream) and passes the `node`, `playwright`, `electron`, and
     `eval_policy` checks — proving the documented quickstart provisions a launchable runtime. The
     `Published npx smoke` workflow repeats this whenever a GitHub release is published.
   - Registry: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=electron-stagewright"`
     lists the new `core` version.

Manual publishes do **not** attach npm provenance (that comes only from the optional OIDC npm path
below). That is the sole difference and does not affect use.

## Versioning and the `workspace:*` gotcha

Semver, with pre-1.0 support for the latest minor only (ADR-015). Packages version **independently**.
The license is MIT ([ADR-001](../docs/adr/001-naming-and-license.md)).

First-party packages depend on core via `"@electron-stagewright/core": "workspace:*"`. On publish,
pnpm rewrites `workspace:*` to the **exact core version in the local manifest**. So when core changes,
publish the whole set together (step 4 does this in one command). If a plugin changes but core does
not, confirm the local core version already exists on npm before publishing the plugin.

## MCP Registry details

The [MCP Registry](https://registry.modelcontextprotocol.io/) lists `core` under the namespace
`io.github.electron-stagewright/core`. It hosts only metadata, so the npm package for that version
must already be live. Ownership is proven two ways that must agree: `packages/core/package.json`
carries an `mcpName` equal to the server name, and the publish runs from a GitHub OIDC token minted
inside the `electron-stagewright` org's own repository.

- **The publish must run from Actions** (`.github/workflows/mcp-registry.yml`, `workflow_dispatch`).
  The workflow installs `mcp-publisher`, runs `mcp-publisher login github-oidc`, validates, and
  publishes. No secret is required.
- **A local publish cannot do the org namespace.** `mcp-publisher login github` (device flow)
  authenticates a maintainer as themselves and grants only their personal `io.github.<user>/*`
  namespace, so it returns `403` for the org server. The only local alternative is a GitHub PAT with
  `read:org` and `read:user` passed to `mcp-publisher login github --token`; the OIDC workflow is
  preferred.
- **Bumping core** re-runs this: update `server.json` + the `core` `mcpName` version, republish npm,
  then dispatch the workflow again.

## Troubleshooting

| Symptom                                                                     | Cause                                                                                                                                                                                            | Fix                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm publish` asks for an OTP / `EOTP`                                      | the account is on `auth-and-writes` 2FA                                                                                                                                                          | pass `--otp <fresh code>`; on a long run, re-run the same command with a new code — skipped packages are already published                                             |
| `pnpm publish` refuses (working tree not clean / not on the publish branch) | pnpm's default git checks                                                                                                                                                                        | add `--no-git-checks`                                                                                                                                                  |
| `git push` rejected; a `release-workflow` test failed first                 | the pre-push hook runs `pnpm verify`, and a guard pins the release-workflow shape                                                                                                                | update the guard test to match the intended workflow change, then push                                                                                                 |
| MCP Registry `403 ... permission to publish: io.github.<you>/*`             | you authenticated as yourself (personal namespace), not the org                                                                                                                                  | publish from Actions: `gh workflow run mcp-registry.yml`. A local device-flow login can never publish the org namespace                                                |
| A shell command with `!` errors `zsh: event not found`                      | zsh history-expands a bare `!`                                                                                                                                                                   | avoid `!` (e.g. `if (x) continue` instead of `if (!x)`), or `set +H` first                                                                                             |
| `npm trust github` returns `E400`                                           | the trust write needs an upfront OTP the command does not accept                                                                                                                                 | not needed for the default flow; configure trusted publishers in the npm web UI instead (only relevant to the optional OIDC npm path)                                  |
| `electron_doctor` reports a failing `electron` check on a working setup     | fixed in core 0.4.1. Earlier versions required Electron's `path.txt`, which its install script writes but an install may skip, even though the binary is present under `dist/` and launches fine | upgrade core, or ignore the check and confirm with an actual `electron_launch`. The documented `npx --package electron` quickstart does provision a launchable runtime |

## If something is wrong post-publish

npm publishes are immutable. Do **not** republish the same version — bump a patch and release again
when source changes are needed. If a run published some packages before a later one failed, leave the
published versions intact and re-run step 4 (it skips what is already on npm). Use `npm deprecate` to
steer users off a broken version; reserve `npm unpublish` for the 72-hour window and genuine mistakes
only. The MCP Registry step is safe to re-dispatch; it only adds the server version once npm has it.

## Optional: automate npm publishing with OIDC trusted publishing

This is **not** the default — it exists for when CI should publish npm without a maintainer running
commands locally. Publishing then runs through `.github/workflows/release.yml` (dispatch-only), whose
protected `npm-publish` environment gates who may approve a run. The job has `id-token: write`, uses a
recent npm, receives no long-lived credential, and npm attaches provenance automatically.

Before a package can publish this way, a maintainer configures a trusted publisher for it in the npm
web UI (package **Settings → Trusted Publisher → GitHub Actions**), with exactly:

- Organization: `electron-stagewright`
- Repository: `electron-stagewright`
- Workflow filename: `release.yml`
- Environment: `npm-publish`

The equivalent CLI (for a package that already exists on npm, from an `npm login --auth-type=web`
session) is:

```bash
for package in $(node -e "for (const p of require('fs').readdirSync('packages')) { const m=require('./packages/'+p+'/package.json'); if (m.private) continue; console.log(m.name) }"); do
  npm trust github "$package" --file release.yml --repo electron-stagewright/electron-stagewright \
    --env npm-publish --yes
done
```

The `node -e` payload uses `if (m.private) continue` rather than `if (!m.private)` because zsh
history-expands a bare `!`. A never-published package cannot get a trusted publisher until it exists,
so publish its first version manually (step 4 above) and then configure trust. Until a package's
trusted publisher is in place, the workflow's publish step fails on it with a masked `npm error code
E404` (`could not be found or you do not have permission`) on the `PUT` — configure it, then dispatch
`release.yml` with `packages=all` and `publish=true` from the Actions tab and approve the environment.

See also [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and
[GOVERNANCE.md](./GOVERNANCE.md) for who can cut a release.

# Reproduce doctor peer hints across separate installations

When the server cannot resolve an optional launch peer but the current project has a copy,
`doctor` must describe that resolution boundary without claiming how the server was started.
The project copy alone cannot prove that npx skipped an installation. The npx workaround remains
useful, so the hint offers it conditionally.

The default peer check still fails: CLI exit **1**, report `ok:false`, peer status `fail`, and
`details.project_copy` naming the detected copy. A separate project runtime or explicit executable
can still work; a failed default-peer check does not establish a failure of either launch mode.

## Base and related changes

- Base: `e929220c219af39c35ab0f7d79ae9afaddfc94f9` (`main`, core **0.7.0**).
- Reproduction tools: Node **24.21.0**, pnpm **11.3.0**, npm/npx **11.19.0**, Playwright **1.63.0**.
- [PR 109](https://github.com/electron-stagewright/electron-stagewright/pull/109) fixed a real
  npx peer omission and introduced the unconditional hint. Its install workaround is retained.
- [PR 107](https://github.com/electron-stagewright/electron-stagewright/pull/107) documented local
  installs; [PR 110](https://github.com/electron-stagewright/electron-stagewright/pull/110) released
  the documentation correction. This change does not repeat those installation fixes.

## Run the synthetic CLI reproduction

From a fresh checkout of this change, with Node 24+ and the pinned pnpm:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node scripts/doctor-peer-repro.mjs
pnpm exec vitest run --project unit packages/core/tests/doctor.test.ts packages/core/tests/default-electron.test.ts packages/core/tests/lifecycle-launch.test.ts packages/core/tests/transports.test.ts
pnpm verify
```

`doctor-peer-repro.mjs` is a POSIX-only, offline CLI reproduction. It creates and removes its own
temporary server and project directories. It copies built core and Playwright, links core's
already-installed dependencies, and deliberately omits Electron beside the server. The synthetic
project Electron is only a `package.json` declaring **44.3.0**, with no executable or install script.
No app is launched or project dependency entry point imported. Child environments exclude provider
credentials and use empty npm configuration plus a temporary npm cache.

The script executes these four cases and prints portable JSON summaries without temporary paths:

| Launcher                                                             | Project Electron copy | Expected result                                             |
| -------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| Direct `node <isolated-core>/dist/cli.js`                            | Absent                | Exit 1, `ok:false`, Electron fails, no `project_copy`       |
| `npx --offline --no --prefix <isolated-server> electron-stagewright` | Absent                | Same                                                        |
| Direct Node CLI                                                      | Present               | Same failure, `project_copy` retained, conditional npx hint |
| Offline npx CLI                                                      | Present               | Same                                                        |

Both forms append `doctor --json --tool-profile essential --app-root <synthetic-project>` and run
with the project as cwd. Playwright must pass in every case. Offline npx executes the prepared local
bin; this checks npx-launched diagnostic output, not npm registry/cache installation behavior from
PR 109. The fixture does not claim a real Electron 44.3.0 binary is installed.

## Compare with the original behavior

Keep the fixed checkout intact. In a second, fresh clone, check out the base above, install with
the same command and build. Copy `scripts/doctor-peer-repro.mjs` from the fixed checkout into that
clone's `scripts/`, then run:

```sh
node scripts/doctor-peer-repro.mjs --expect-original
```

All four cases retain the correct failure result, but both project-copy cases say `npx reused
electron`, including the direct Node invocation. Running without `--expect-original` fails on that
unconditional wording. Copying the fixed `packages/core/tests/doctor.test.ts` into the base clone and
running its targeted Vitest command produces **2 failed / 12 passed**; both peer regressions pass
with the fix. The flag selects the expected wording only; it never changes the doctor invocation.

## Runtime controls and limits

The targeted unit command also runs existing project-runtime resolution and launch-routing tests
(`lifecycle-launch.test.ts`). `transports.test.ts` verifies that an explicit executable reaches a
successful fake Playwright application even when the default Electron package or binary is missing;
the default-runtime inspection is bypassed. These are synthetic routing controls, not native app
smokes. The normal real-Electron CI suite supplies separate native coverage.

Only hint wording and its explanation change. Package resolution, exit statuses, launch selection,
installation commands, peer requirements, and public report fields keep their existing behavior.
This does not provision Electron, infer the launcher from environment heuristics, or change npx's
installation behavior. A draft PR still requires review and the normal CI gates before merge.

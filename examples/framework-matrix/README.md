# framework-matrix — proving the tools are framework-agnostic

A set of minimal Electron renderer fixtures — one per UI framework — that **all
implement the same UI contract**, driven by **one shared real-MCP harness**. If a
button rendered by React is found and clicked by exactly the same scenario as a vanilla
one, the snapshot walker and tool layer are framework-agnostic. That is the claim this
matrix exists to keep honest.

This is a separate axis from the business-vertical examples (`minimal-app`,
`vscode-extension-shape`, …): those vary the _app shape_; this varies the _renderer
framework_ while holding the shape fixed.

## The UI contract

Every fixture renders the same three things:

- a text input with the accessible name **"Your name"** (`#name`)
- a button with the accessible name **"Greet"**
- a `#status` line that becomes **"Hello, &lt;name&gt;!"** after the click, logging
  `greeted &lt;name&gt;` to the console

The shared scenario (in `harness.ts`) drives that contract with the same tool calls for
every framework: wait for mount, snapshot, `expect_count` the button by role, type real
keystrokes into the input, `find` the button by role + name and click it by ref,
`expect_text` the status, screenshot, and read the console back.

## Fixtures

| Framework                        | What it exercises                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| [`vanilla`](./fixtures/vanilla/) | Baseline — direct DOM, no framework or build step.                                    |
| [`react`](./fixtures/react/)     | Controlled input + synthetic events through React's virtual DOM (esbuild JSX bundle). |

More frameworks (Vue, Angular) are added by dropping a `fixtures/<name>/` directory that
implements the contract and adding a row to the runner's fixture list.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the harness spawns
pnpm matrix       # builds the bundled fixtures, then runs every fixture's scenario
```

or scoped: `pnpm --filter @electron-stagewright/framework-matrix matrix`.

The runner prints a PASS/FAIL summary table and **exits non-zero if any fixture fails**,
so one broken framework fails the command without hiding the others. You need a desktop
session (a display): each fixture launches a real Electron window.

## Known limitations

The matrix documents what it does **not** yet cover, rather than hiding it:

- **Frameworks covered**: vanilla and React. Vue and Angular fixtures are not in this
  slice; the harness is structured to add them without changes.
- **Single renderer document**: fixtures render in one document. Content inside a real
  `<webview>` or cross-document `<iframe>` is out of scope (the walker does not yet
  traverse frame boundaries).
- **Open DOM only**: elements inside a closed shadow root are not walked.
- **Not in CI**: like the other real-Electron smokes, this runs locally on demand. CI
  integration (downloading the Electron binary reliably in a runner) is tracked
  separately and intentionally deferred.
- **No visual diffing**: the screenshot is captured but not pixel-compared; the matrix
  asserts behavior and DOM state, not appearance.

# @electron-stagewright/origin-migration

Moving an Electron renderer from `file://` to a custom scheme changes its storage origin, so the
first launch on the new scheme starts with empty storage. This package copies the old data across
once, from your app's main process.

**v0 copies `localStorage` and the origin private file system (OPFS) only.** IndexedDB, cookies,
`sessionStorage` and Cache Storage are not copied. If your app keeps data there, this package does
not move it yet.

## Guarantees

- A `localStorage` key the new origin already holds is never overwritten.
- The `file://` copy is never modified, so an older build still opens with its data.
- OPFS files are copied in 1 MiB chunks to staging files, and moved into place only after every
  file is staged. A copied file replaces a file of the same path on the new origin.
- A database and its `.wal` move together, database first. A `.wal` without its database is
  skipped.
- A marker in `userData` makes the copy run once. A failed attempt is retried on the next launch,
  three attempts in all. A crash mid-copy counts as an attempt.
- Data the user deletes on the new origin after it was copied is never restored by a retry.

## Use

```ts
import { app, BrowserWindow, protocol, session } from 'electron'
import { blankDocumentResponse, migrateOrigin } from '@electron-stagewright/origin-migration'

const BLANK_URL = 'app://example/.origin-migration/blank.html'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    if (request.url === BLANK_URL) return blankDocumentResponse()
    return serveRenderer(request) // your handler
  })

  // Create the window first: closing the migration's pages must not close the app.
  const window = new BrowserWindow({ show: false })
  const result = await migrateOrigin({
    userDataDir: app.getPath('userData'),
    BrowserWindow,
    session: session.defaultSession,
    targetUrl: BLANK_URL,
    onProgress: (done, total) => window.setProgressBar(total > 0 ? done / total : -1),
  })
  window.setProgressBar(-1)
  if (result.status === 'failed' && result.final) {
    // Tell the user their old data could not be copied.
  }
  await window.loadURL('app://example/index.html')
  window.show()
})
```

`migrateOrigin` resolves with one of:

| `status`   | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `skipped`  | Already done, or out of attempts. Nothing was opened.                        |
| `empty`    | Nothing was left to copy on the `file://` origin.                            |
| `migrated` | Data was copied. `marker` has key, file and byte counts.                     |
| `failed`   | This attempt failed. `marker.error` names the error; `final` means no retry. |

Options:

| Option          | Default                 | Notes                                                       |
| --------------- | ----------------------- | ----------------------------------------------------------- |
| `targetUrl`     | required                | An empty document on the new origin. Must not be `file://`. |
| `session`       | required                | The session whose storage moves; partitions work.           |
| `stores`        | both                    | `['localStorage']`, `['opfs']` or both.                     |
| `markerFile`    | `origin-migration.json` | A file name in `userDataDir`. Keep an existing marker name. |
| `stepTimeoutMs` | 30000                   | Bounds each page load and each page step.                   |
| `signal`        |                         | Aborts the attempt; moves already started still finish.     |

## Requirements

- Electron 42 or later.
- The release that migrates must keep the `GrantFileProtocolExtraPrivileges` fuse on. Without it a
  `file://` page cannot read `localStorage`; the marker then records `localStorageUnreadable` and
  only OPFS files move.
- Call it before the renderer loads from the new origin, so the app never boots on empty settings.

## Lower-level API

`runOriginMigration` takes a `LegacyOriginReader` and a `TargetOriginWriter` instead of windows,
for apps that reach the origins another way. `openLegacyOriginPage` and `openTargetOriginPage`
build the page-backed ones `migrateOrigin` uses.

See [ADR-031](../../docs/adr/031-origin-migration-library.md) for the design.

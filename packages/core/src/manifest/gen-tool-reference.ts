#!/usr/bin/env node
/**
 * Writer for `TOOL-REFERENCE.md`. Builds the full tool manifest — with
 * `allowEval: true` so eval-gated tools are included and marked — and writes the rendered Markdown
 * to the path given as `argv[2]` (default `TOOL-REFERENCE.md`, resolved against the current working
 * directory). Run via `pnpm docs:tools` (tsx, no build step); the companion sync test fails CI if
 * the committed file drifts from the live manifest.
 *
 * Status goes to stderr (stdout is reserved for protocol elsewhere; this keeps the habit).
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createServer, NOOP_LOGGER } from '../server/index.js'
import { renderToolReference } from './tool-reference.js'

async function main(): Promise<void> {
  const out = path.resolve(process.argv[2] ?? 'TOOL-REFERENCE.md')
  const server = await createServer({ allowEval: true, logger: NOOP_LOGGER })
  try {
    const markdown = renderToolReference(server.dispatcher.listManifest())
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, markdown, 'utf8')
    process.stderr.write(`Wrote ${out}\n`)
  } finally {
    await server.close().catch(() => undefined)
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})

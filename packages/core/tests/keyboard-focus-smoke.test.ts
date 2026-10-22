/**
 * Real-Electron focus-aware typing smoke — a button opens an input that takes focus 150 ms later
 * (a command palette); each step reinstalls it and cancels the previous step's timer. Typing
 * right after the click reports that the keys went to a non-editable element; waitForFocusMs
 * lands the text in the input; requireEditable refuses to type into nothing. Runs on the
 * Playwright launch and the CDP attach transports.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`.
 *
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import { INTERACTION_TOOLS } from '../src/tools/interaction/index.js'
import { attachTool } from '../src/tools/lifecycle/attach.js'
import { detachTool, launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { READ_TOOLS } from '../src/tools/read/index.js'
import { CDPTransport, PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

/** A palette button whose input appears and takes focus 150 ms after the click. */
const INSTALL_PALETTE = `
clearTimeout(window.__paletteTimer);
for (const stale of document.querySelectorAll('#palette-open, #palette')) stale.remove();
const open = document.createElement('button');
open.id = 'palette-open';
open.textContent = 'Open palette';
open.addEventListener('click', () => {
  window.__paletteTimer = setTimeout(() => {
    const input = document.createElement('input');
    input.id = 'palette';
    input.setAttribute('aria-label', 'Search commands');
    document.body.append(input);
    input.focus();
  }, 150);
});
document.body.append(open);
return true
`

let child: ChildProcess | undefined

afterAll(() => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
})

function newDispatcher(transport: CDPTransport | PlaywrightElectronTransport): Dispatcher {
  const dispatcher = new Dispatcher({
    sessions: new SessionManager(),
    snapshots: new SnapshotStore(),
    transports: new TransportRegistry({ transports: [transport] }),
    allowEval: true,
  })
  dispatcher.registerAll([
    launchTool,
    stopTool,
    attachTool,
    detachTool,
    ...INTERACTION_TOOLS,
    ...READ_TOOLS,
    ...EVAL_TOOLS,
  ])
  return dispatcher
}

async function checkFocusAwareTyping(dispatcher: Dispatcher, sessionId: string): Promise<void> {
  const install = () =>
    dispatcher.dispatch('electron_eval_renderer', { sessionId, code: INSTALL_PALETTE })

  // Right after the click the palette input does not exist yet: the keys go to the button.
  await install()
  await dispatcher.dispatch('electron_click', { sessionId, selector: '#palette-open' })
  const early = (await dispatcher.dispatch('electron_keyboard_type', {
    sessionId,
    text: 'lost',
  })) as SuccessResponse & { focused: { editable: boolean } | null }
  expect(early.ok).toBe(true)
  expect(early.focused?.editable ?? false).toBe(false)

  // Waiting for focus lands the text in the input.
  await install()
  await dispatcher.dispatch('electron_click', { sessionId, selector: '#palette-open' })
  await expect(
    dispatcher.dispatch('electron_keyboard_type', {
      sessionId,
      text: 'theme',
      waitForFocusMs: 2000,
    }),
  ).resolves.toMatchObject({
    ok: true,
    focused: { name: 'Search commands', editable: true },
  })
  await expect(
    dispatcher.dispatch('electron_get_value', { sessionId, selector: '#palette' }),
  ).resolves.toMatchObject({ ok: true, value: 'theme' })

  // With nothing editable focused, requireEditable refuses instead of losing the keys.
  await install()
  await dispatcher.dispatch('electron_eval_renderer', {
    sessionId,
    code: 'document.activeElement?.blur(); return true',
  })
  await expect(
    dispatcher.dispatch('electron_keyboard_type', { sessionId, text: 'x', requireEditable: true }),
  ).resolves.toMatchObject({ ok: false, code: 'NO_FOCUSED_EDITABLE' })
}

describe('focus-aware typing smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'reports, waits for and requires an editable focus on the launch transport',
    async () => {
      const dispatcher = newDispatcher(new PlaywrightElectronTransport())
      const launched = (await dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as SuccessResponse & { session_id: string }
      try {
        await checkFocusAwareTyping(dispatcher, launched.session_id)
      } finally {
        await dispatcher.dispatch('electron_stop', { sessionId: launched.session_id })
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'reports, waits for and requires an editable focus on the CDP transport',
    async () => {
      const electronPath = (await import('electron')).default as unknown as string
      const proc = spawn(electronPath, [FIXTURE_MAIN, '--remote-debugging-port=0'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      child = proc
      const cdpUrl = await new Promise<string>((resolve, reject) => {
        let stderr = ''
        const timer = setTimeout(
          () => reject(new Error(`No DevTools endpoint:\n${stderr}`)),
          20_000,
        )
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
          if (match?.[1] !== undefined) {
            clearTimeout(timer)
            resolve(match[1])
          }
        })
      })
      const dispatcher = newDispatcher(new CDPTransport())
      try {
        const attached = (await dispatcher.dispatch('electron_attach', {
          cdpUrl,
        })) as SuccessResponse & { session_id: string }
        await dispatcher.dispatch('electron_wait_for_selector', {
          sessionId: attached.session_id,
          selector: 'button',
        })
        await checkFocusAwareTyping(dispatcher, attached.session_id)
        await dispatcher.dispatch('electron_detach', { sessionId: attached.session_id })
      } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
    },
    60_000,
  )
})

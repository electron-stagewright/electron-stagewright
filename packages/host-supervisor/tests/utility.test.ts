import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { minimalEnvironment } from '../src/env.js'
import type { ChannelExit } from '../src/index.js'
import {
  utilityProcessTransport,
  type UtilityForkOptions,
  type UtilityProcessLike,
} from '../src/utility.js'

function fakeChild() {
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  const child: UtilityProcessLike & {
    emit(event: string, ...args: unknown[]): void
    posted: unknown[]
    killed: boolean
  } = {
    pid: 42,
    posted: [],
    killed: false,
    postMessage: (message) => void child.posted.push(message),
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    },
    kill: () => {
      child.killed = true
      return true
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (...values: unknown[]) => void)(...args)
      }
    },
  }
  return child
}

describe('utilityProcessTransport', () => {
  it('forks with a minimal environment by default and forwards messages and kill', () => {
    const child = fakeChild()
    let forked: { entry: string; args: string[]; options: UtilityForkOptions } | null = null
    const channel = utilityProcessTransport({
      entry: '/app/host.js',
      args: ['--flag'],
      serviceName: 'Host',
      fork: (entry, args, options) => {
        forked = { entry, args, options }
        return child
      },
    }).launch()
    expect(forked).toMatchObject({
      entry: '/app/host.js',
      args: ['--flag'],
      options: { serviceName: 'Host' },
    })
    const env = (forked as { options: UtilityForkOptions } | null)?.options.env ?? {}
    expect(Object.keys(env).every((name) => name !== 'HOME' && name !== 'NODE_OPTIONS')).toBe(true)

    const received: unknown[] = []
    channel.onMessage((message) => received.push(message))
    channel.send({ type: 'stop' })
    child.emit('message', { type: 'stopped' })
    expect(child.posted).toEqual([{ type: 'stop' }])
    expect(received).toEqual([{ type: 'stopped' }])
    channel.kill()
    expect(child.killed).toBe(true)
  })

  it('turns a fatal error event into the exit cause', () => {
    const child = fakeChild()
    const channel = utilityProcessTransport({ entry: 'x', fork: () => child }).launch()
    const exits: ChannelExit[] = []
    channel.onExit((exit) => exits.push(exit))
    child.emit('error', 'FatalError', 'v8::Isolate', 'report')
    child.emit('exit', 133)
    expect(exits[0]?.code).toBe(133)
    expect(exits[0]?.error?.message).toContain('FatalError at v8::Isolate')
  })
})

describe('minimalEnvironment', () => {
  it('passes only what a runtime needs and can move HOME', () => {
    const env = minimalEnvironment(
      { PATH: '/bin', SECRET_TOKEN: 's', HOME: '/Users/me', LANG: 'en', EXTRA: 'e' },
      { home: '/data/home', passThrough: ['EXTRA'] },
    )
    expect(env).toEqual({
      PATH: '/bin',
      LANG: 'en',
      EXTRA: 'e',
      HOME: '/data/home',
      USERPROFILE: '/data/home',
    })
  })
})

describe('subpaths', () => {
  it('keeps Electron out of every module but the utility transport', async () => {
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
    for (const file of await readdir(source)) {
      const text = await readFile(path.join(source, file), 'utf8')
      const mentions = /from 'electron'|require\(['"]electron['"]\)|\('electron'\)/.test(text)
      expect({ file, mentions }).toEqual({ file, mentions: file === 'utility.ts' })
    }
  })
})

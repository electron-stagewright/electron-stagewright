import { describe, expect, it } from 'vitest'

import { createKillProcessTree } from '../src/transports/process-tree.js'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('killProcessTree', () => {
  it('runs taskkill /T /F on Windows and falls back to the pid alone when it fails', async () => {
    const calls: string[][] = []
    const kills: number[] = []
    let code = 0
    const kill = createKillProcessTree({
      platform: 'win32',
      taskkill: async (args) => {
        calls.push([...args])
        return code
      },
      kill: (pid) => void kills.push(pid),
    })
    await expect(kill(4242)).resolves.toBe(true)
    expect(calls).toEqual([['/pid', '4242', '/T', '/F']])
    expect(kills).toEqual([])
    code = 128
    await expect(kill(4242)).resolves.toBe(true)
    expect(kills).toEqual([4242])
  })

  it('kills the POSIX process group and waits until it is empty', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    let aliveChecks = 0
    const kill = createKillProcessTree({
      platform: 'linux',
      kill: (pid, signal) => {
        signals.push([pid, signal])
        if (signal === 0 && ++aliveChecks > 2) throw errno('ESRCH')
      },
    })
    await expect(kill(4242)).resolves.toBe(true)
    expect(signals[0]).toEqual([-4242, 'SIGKILL'])
    expect(signals.filter(([, signal]) => signal === 0)).toHaveLength(3)
  })

  it('kills the pid alone when it leads no group, and gives up waiting after settleMs', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const single = createKillProcessTree({
      platform: 'darwin',
      kill: (pid, signal) => {
        signals.push([pid, signal])
        if (pid < 0) throw errno('ESRCH')
      },
    })
    await expect(single(4242)).resolves.toBe(true)
    expect(signals).toEqual([
      [-4242, 'SIGKILL'],
      [4242, 'SIGKILL'],
    ])

    const stuck = createKillProcessTree({ platform: 'linux', settleMs: 60, kill: () => undefined })
    const started = Date.now()
    await expect(stuck(4242)).resolves.toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('refuses pids that are not plain positive integers', async () => {
    const signals: number[] = []
    const kill = createKillProcessTree({ platform: 'linux', kill: (pid) => void signals.push(pid) })
    for (const pid of [0, -1, 1.5, Number.NaN]) await expect(kill(pid)).resolves.toBe(false)
    expect(signals).toEqual([])
  })

  it('reports false when nothing could be signalled', async () => {
    const kill = createKillProcessTree({
      platform: 'linux',
      kill: () => {
        throw errno('ESRCH')
      },
    })
    await expect(kill(4242)).resolves.toBe(false)
  })

  it('never touches a reused pid once the main process has exited', async () => {
    const taskkills: string[][] = []
    const winKills: number[] = []
    const win = createKillProcessTree({
      platform: 'win32',
      taskkill: async (args) => {
        taskkills.push([...args])
        return 0
      },
      kill: (pid) => void winKills.push(pid),
    })
    await expect(win(4242, { exited: true })).resolves.toBe(false)
    expect(taskkills).toEqual([])
    expect(winKills).toEqual([])

    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const posix = createKillProcessTree({
      platform: 'linux',
      kill: (pid, sig) => {
        signals.push([pid, sig])
        if (pid < 0) throw errno('ESRCH')
      },
    })
    await expect(posix(4242, { exited: true })).resolves.toBe(false)
    expect(signals).toEqual([[-4242, 'SIGKILL']])
  })
})

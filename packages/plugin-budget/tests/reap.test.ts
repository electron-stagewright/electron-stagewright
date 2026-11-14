import { describe, expect, it } from 'vitest'

import { reapSurvivors, type ProcessControl } from '../src/measure.js'
import { reapablePids, sameProcess, type EvaluatingSession } from '../src/session.js'

function processes(exitAfterMs: Record<number, number | 'never' | 'on-kill'>) {
  const started = Date.now()
  const killed = new Set<number>()
  const control: ProcessControl & { kills: number[] } = {
    kills: [],
    alive: (pid) => {
      const rule = exitAfterMs[pid]
      if (rule === 'never') return true
      if (rule === 'on-kill') return !killed.has(pid)
      return rule !== undefined && Date.now() - started < rule
    },
    kill: (pid) => {
      control.kills.push(pid)
      killed.add(pid)
    },
  }
  return control
}

describe('reapSurvivors', () => {
  it('waits for processes that exit on their own and kills none', async () => {
    const control = processes({ 1: 0, 2: 150 })
    expect(await reapSurvivors([1, 2], control, 1_000)).toEqual({ killed: [], survivors: [] })
    expect(control.kills).toEqual([])
  })

  it('kills a child that outlives the wait, and reports one that survives the kill', async () => {
    const control = processes({ 1: 0, 2: 'on-kill', 3: 'never' })
    const result = await reapSurvivors([1, 2, 3], control, 200)
    expect(result).toEqual({ killed: [2, 3], survivors: [3] })
    expect(control.kills).toEqual([2, 3])
  })

  it('never kills a pid that fails verification', async () => {
    const control = processes({ 2: 'on-kill', 3: 'on-kill' })
    const result = await reapSurvivors([2, 3], control, 50, async (pid) => pid === 2)
    expect(result).toEqual({ killed: [2], survivors: [] })
    expect(control.kills).toEqual([2])
  })
})

describe('reapablePids', () => {
  const facts = (pid: number) =>
    ({
      evaluate: async () => ({
        pid,
        creationTime: 1_000_000,
        electron: '45.0.0',
        platform: process.platform,
        processes: [
          { pid, type: 'Browser', name: null, workingSetKb: 1, privateKb: null },
          { pid: pid + 1, type: 'GPU', name: null, workingSetKb: 1, privateKb: null },
        ],
      }),
    }) as unknown as EvaluatingSession

  it('records the start time of each pid the app reports', async () => {
    const started = new Map([
      [10, 1_000_500],
      [11, 1_002_000],
    ])
    const pids = await reapablePids(facts(10), async (pid) => started.get(pid))
    expect([...pids]).toEqual([
      [10, 1_000_500],
      [11, 1_002_000],
    ])
  })

  it('returns none when this host’s main pid is not the app’s', async () => {
    const pids = await reapablePids(facts(10), async () => 5_000_000)
    expect(pids.size).toBe(0)
  })

  it('returns none when main cannot be read', async () => {
    const session = {
      evaluate: async () => {
        throw new Error('evaluate(main) is not supported')
      },
    } as unknown as EvaluatingSession
    expect((await reapablePids(session, async () => 1)).size).toBe(0)
  })

  it('treats a pid that restarted as another process', async () => {
    expect(await sameProcess(10, 1_000, async () => 1_500)).toBe(true)
    expect(await sameProcess(10, 1_000, async () => 60_000)).toBe(false)
    expect(await sameProcess(10, 1_000, async () => 'missing')).toBe(false)
    expect(await sameProcess(10, undefined, async () => 60_000)).toBe(true)
  })
})

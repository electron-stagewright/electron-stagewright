import { describe, expect, it } from 'vitest'

import { reapSurvivors, type ProcessControl } from '../src/measure.js'

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
})

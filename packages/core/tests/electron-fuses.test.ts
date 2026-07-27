import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { FuseState, FuseV1Options, FuseVersion } from '@electron/fuses'
import { describe, expect, it } from 'vitest'

import {
  describeElectronLaunchFuses,
  inspectElectronLaunchFuses,
} from '../src/runtime/electron-fuses.js'

const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

describe('describeElectronLaunchFuses', () => {
  it('marks a disabled Node CLI inspect fuse as launch-blocking', () => {
    const wire = {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: FuseState.DISABLE,
      [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    }

    expect(describeElectronLaunchFuses(wire)).toEqual({
      version: '1',
      run_as_node: 'disabled',
      node_cli_inspect_arguments: 'disabled',
      blocks_playwright_launch: true,
    })
  })

  it('does not block solely because RunAsNode is disabled', () => {
    const wire = {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: FuseState.DISABLE,
      [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.ENABLE,
    }

    expect(describeElectronLaunchFuses(wire)).toMatchObject({
      run_as_node: 'disabled',
      node_cli_inspect_arguments: 'enabled',
      blocks_playwright_launch: false,
    })
  })

  it('treats a removed inspect fuse as unavailable and missing values as unknown', () => {
    const wire = {
      version: FuseVersion.V1,
      [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.REMOVED,
    }

    expect(describeElectronLaunchFuses(wire)).toMatchObject({
      run_as_node: 'unknown',
      node_cli_inspect_arguments: 'removed',
      blocks_playwright_launch: true,
    })
  })

  it('reads a fuse wire from disk through the official Electron helper', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'stagewright-fuses-'))
    const executablePath = path.join(dir, 'electron')
    try {
      await writeFile(
        executablePath,
        Buffer.concat([
          Buffer.from('binary-prefix'),
          Buffer.from(FUSE_SENTINEL),
          Buffer.from([1, 4]),
          Buffer.from([FuseState.ENABLE, FuseState.DISABLE, FuseState.DISABLE, FuseState.DISABLE]),
          Buffer.from('binary-suffix'),
        ]),
      )

      await expect(inspectElectronLaunchFuses(executablePath)).resolves.toMatchObject({
        run_as_node: 'enabled',
        node_cli_inspect_arguments: 'disabled',
        blocks_playwright_launch: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

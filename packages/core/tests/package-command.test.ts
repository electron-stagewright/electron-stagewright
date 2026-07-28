import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '../../..')
const COMMAND_HELPER = pathToFileURL(
  path.join(REPOSITORY_ROOT, 'scripts', 'package-command.mjs'),
).href

const { packageCommandInvocation } = (await import(COMMAND_HELPER)) as {
  packageCommandInvocation: (
    command: string,
    args: readonly string[],
    platform?: NodeJS.Platform,
    commandProcessor?: string,
  ) => { readonly file: string; readonly args: readonly string[] }
}

describe('package command execution', () => {
  it('executes package binaries directly on POSIX', () => {
    expect(packageCommandInvocation('npm', ['pack'], 'linux')).toEqual({
      file: 'npm',
      args: ['pack'],
    })
  })

  it('routes Windows package shims through the command processor', () => {
    expect(
      packageCommandInvocation('npm', ['pack'], 'win32', 'C:\\Windows\\System32\\cmd.exe'),
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'npm.cmd', 'pack'],
    })
  })

  it('supports absolute npm bin paths without duplicating the shim extension', () => {
    const command = 'C:\\work tree\\node_modules\\.bin\\electron-stagewright-replay.cmd'

    expect(packageCommandInvocation(command, ['replay.json'], 'win32', 'cmd.exe')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', command, 'replay.json'],
    })
  })

  it('executes native Windows binaries directly without inventing a shim', () => {
    const command = 'C:\\Program Files\\nodejs\\node.exe'

    expect(packageCommandInvocation(command, ['cli.js'], 'win32', 'cmd.exe')).toEqual({
      file: command,
      args: ['cli.js'],
    })
  })
})

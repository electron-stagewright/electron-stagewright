// `electron_doctor` is a non-mutating preflight for the server environment.

import { z } from 'zod'

import { runDoctorChecks } from '../../doctor.js'
import { makeSuccess } from '../../errors/envelope.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

export const doctorTool: AnyToolDefinition = defineTool({
  name: 'electron_doctor',
  title: 'Diagnose Electron Stagewright environment',
  description: [
    'Run non-mutating preflight checks without starting an Electron session: Node version, Playwright,',
    'Electron, Linux display, configured app root and screenshot directory, and eval policy.',
    'Returns: { ok, doctor_ok, checks }. Inspect failed checks and their hints before electron_launch.',
    'Errors: none.',
  ].join(' '),
  inputSchema: z.object({}),
  operationType: 'query',
  handler: async (_args, ctx) => {
    const report = await runDoctorChecks({
      ...(ctx.appRoot !== undefined ? { appRoot: ctx.appRoot } : {}),
      ...(ctx.screenshotDir !== undefined ? { screenshotDir: ctx.screenshotDir } : {}),
      allowEvalMain: ctx.allowEval,
      allowEvalRenderer: ctx.allowEvalRenderer,
    })
    return makeSuccess(
      { doctor_ok: report.ok, checks: report.checks },
      { startedAt: ctx.startedAt, now: ctx.now },
    )
  },
})

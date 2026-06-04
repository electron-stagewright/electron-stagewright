// A minimal Electron Stagewright plugin (ADR-004), authored as plain ESM so it loads with
// `--plugin <path-to-this-file>` without a build step. It contributes one tool and one
// error code, reads deployment config validated by its configSchema, and uses the
// lifecycle hooks. The loader namespaces everything: the tool registers as `sample_greet`
// and the error code as `sample.NAME_REFUSED`.
import { defineTool, makePluginError, makeSuccess } from '@electron-stagewright/core'
import { z } from 'zod'

// The greeting word is deployment config; `setup` copies the validated value here so the
// tool handler (a closure) reads the current value at call time.
let greetingWord = 'Hello'

/** @type {import('@electron-stagewright/core').StagewrightPlugin} */
const plugin = {
  name: 'sample',
  version: '1.0.0',
  // Any core version (this is a demo). A real plugin pins the range it was built against.
  coreVersionRange: '*',
  // Config schema: `--plugin-config sample={"greeting":"Hola"}` (or createServer
  // pluginConfigs). The default keeps the plugin usable with no config supplied.
  configSchema: z.object({ greeting: z.string().min(1).default('Hello') }),
  errorCodes: {
    NAME_REFUSED: { http: 422, retryable: false, hint: 'The greeter refuses an empty name.' },
  },
  tools: [
    defineTool({
      name: 'greet',
      description: [
        'Greet a name using the configured greeting word. Takes { name }. Needs no running',
        'app. Returns: { ok, message }. Errors: sample.NAME_REFUSED (name is empty; not retryable).',
      ].join(' '),
      inputSchema: z.object({ name: z.string().describe('The name to greet.') }),
      operationType: 'query',
      handler: async (args, ctx) => {
        const name = args.name.trim()
        if (name.length === 0) {
          return makePluginError('sample.NAME_REFUSED', {
            message: 'Name must not be empty.',
            startedAt: ctx.startedAt,
            now: ctx.now,
          })
        }
        return makeSuccess(
          { message: `${greetingWord}, ${name}!` },
          { startedAt: ctx.startedAt, now: ctx.now },
        )
      },
    }),
  ],
  // `config` arrives typed as `unknown` (the contract can't know your schema), but it is
  // the value `configSchema` parsed — so a cast to the schema's shape is safe. In a
  // TypeScript plugin you would write `z.infer<typeof configSchema>` instead of this cast.
  setup(config) {
    greetingWord = /** @type {{ greeting: string }} */ (config).greeting
  },
}

export default plugin

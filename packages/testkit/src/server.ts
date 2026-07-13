import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createServer,
  NOOP_LOGGER,
  TransportRegistry,
  type CreateServerOptions,
  type StagewrightPlugin,
  type StagewrightServer,
  type TransportCapabilities,
} from '@electron-stagewright/core'

import { fullCapabilities } from './capabilities.js'
import { FakeTransport, type FakeSession } from './fake-transport.js'

/** Options for a server that uses one in-memory fake transport. */
export interface CreateTestServerOptions extends Omit<
  CreateServerOptions,
  'logger' | 'transports'
> {
  readonly session?: FakeSession
  readonly transport?: FakeTransport
  readonly capabilities?: TransportCapabilities
}

/** The server and fakes created together by {@link createTestServer}. */
export interface TestServer {
  readonly server: StagewrightServer
  readonly session: FakeSession
  readonly transport: FakeTransport
}

/** Assemble a real core server over a single configurable in-memory transport. */
export async function createTestServer(opts: CreateTestServerOptions = {}): Promise<TestServer> {
  const { session, transport: suppliedTransport, capabilities, ...serverOptions } = opts
  const transport =
    suppliedTransport ??
    new FakeTransport({
      ...(session !== undefined ? { session } : {}),
      capabilities: capabilities ?? fullCapabilities(),
    })
  const server = await createServer({
    ...serverOptions,
    logger: NOOP_LOGGER,
    transports: new TransportRegistry({ transports: [transport] }),
  })
  return { server, session: transport.session, transport }
}

/** Load one plugin into a test server without repeating the registry/logger wiring. */
export function createPluginTestServer(
  plugin: StagewrightPlugin,
  opts: Omit<CreateTestServerOptions, 'plugins'> = {},
): Promise<TestServer> {
  return createTestServer({ ...opts, plugins: [plugin] })
}

/** Arguments accepted by {@link TestLifecycle.launch}. */
export interface LaunchTestSessionOptions {
  readonly allowMultiple?: boolean
}

/**
 * Own fake servers and temporary Electron entry points for one test. Call {@link cleanup} from
 * `afterEach` so an assertion failure cannot leave a fake server or fixture directory behind.
 */
export class TestLifecycle {
  readonly #servers = new Set<StagewrightServer>()
  readonly #directories = new Set<string>()

  async createTestServer(opts: CreateTestServerOptions = {}): Promise<TestServer> {
    const created = await createTestServer(opts)
    this.#servers.add(created.server)
    return created
  }

  async createPluginTestServer(
    plugin: StagewrightPlugin,
    opts: Omit<CreateTestServerOptions, 'plugins'> = {},
  ): Promise<TestServer> {
    const created = await createPluginTestServer(plugin, opts)
    this.#servers.add(created.server)
    return created
  }

  /** Write the minimal main entry required by the real `electron_launch` validation path. */
  async fixtureMain(prefix = 'sw-testkit-'): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix))
    this.#directories.add(directory)
    const main = path.join(directory, 'main.js')
    await writeFile(main, '// testkit fake Electron entry\n', 'utf8')
    return main
  }

  /** Launch the test transport and return the server-assigned session id. */
  async launch(server: StagewrightServer, opts: LaunchTestSessionOptions = {}): Promise<string> {
    const main = await this.fixtureMain()
    const result = (await server.dispatcher.dispatch('electron_launch', {
      main,
      ...(opts.allowMultiple === true ? { allowMultiple: true } : {}),
    })) as { readonly session_id?: unknown; readonly _meta?: { readonly session_id?: unknown } }
    const sessionId = result.session_id ?? result._meta?.session_id
    if (typeof sessionId !== 'string') throw new Error('launch did not return a session id')
    return sessionId
  }

  /** Close every owned server and remove every generated fixture. Safe to call more than once. */
  async cleanup(): Promise<void> {
    await Promise.all([...this.#servers].map((server) => server.close().catch(() => undefined)))
    this.#servers.clear()
    await Promise.all(
      [...this.#directories].map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
    )
    this.#directories.clear()
  }
}

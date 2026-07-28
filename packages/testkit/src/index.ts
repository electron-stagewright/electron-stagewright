/** Private test-only helpers. This package is never part of a published runtime dependency graph. */
export { FULL_CAPABILITIES, fullCapabilities } from './capabilities.js'
export { FakeCdpServer, FakeSocket, type Json } from './fake-cdp.js'
export {
  FakeSession,
  FakeTransport,
  type FakeEvaluate,
  type FakeSessionOptions,
  type FakeTransportOptions,
} from './fake-transport.js'
export { connectMcpTestClient, type McpTestClient } from './mcp.js'
export {
  createPluginTestServer,
  createTestServer,
  TestLifecycle,
  type CreateTestServerOptions,
  type LaunchTestSessionOptions,
  type TestServer,
} from './server.js'
export {
  waitForTestSurfaces,
  type TestSurfaceDescriptor,
  type TestSurfaceListResult,
  type TestToolDispatcher,
  type WaitForTestSurfacesOptions,
} from './surfaces.js'

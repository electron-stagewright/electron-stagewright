/**
 * Optional in-band documentation resources.
 *
 * Resource discovery and rendering are host-controlled in MCP, so tools and initialization
 * instructions remain sufficient when a host does not surface resources. The static guides are
 * generated from tracked source documents at build time; no published server reads the operator's
 * filesystem to answer a resource request.
 *
 * @module
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { GENERATED_AGENT_RESOURCE_DOCUMENTS } from './generated-documents.js'
import { VERSION } from '../version.js'
import type { ToolProfile } from '../tools/profiles.js'

/** Stable URI for the compact, server-specific tool-profile resource. */
export const ACTIVE_PROFILE_RESOURCE_URI = 'stagewright://manifest/profile'

interface AgentResourceRegistration {
  /** The selected named core profile, or custom when callers supplied their own tool collection. */
  readonly activeProfile: ToolProfile | 'custom'
  /** Registered visible core tools after eval gating. */
  readonly visibleCoreToolCount: number
  /** Registered visible tools including optional plugins and conditional server introspection. */
  readonly visibleToolCount: number
}

function decorateGuide(source: string, text: string): string {
  return [
    `<!-- Electron Stagewright resource; server version ${VERSION}; canonical source: ${source} -->`,
    '',
    text,
  ].join('\n')
}

function profileResource(registration: AgentResourceRegistration): string {
  const additionalTools = registration.visibleToolCount - registration.visibleCoreToolCount
  return [
    '# Active Electron Stagewright tool profile',
    '',
    `- Server version: \`${VERSION}\``,
    `- Selected core profile: \`${registration.activeProfile}\``,
    `- Visible core tools: ${registration.visibleCoreToolCount}`,
    `- Additional visible tools: ${additionalTools}`,
    `- Visible MCP tools total: ${registration.visibleToolCount}`,
    '',
    "This is an availability summary, not a second tool schema. Read `tools/list` for each visible tool's arguments and behavior. Plugins and their conditional server introspection are enabled independently of a core profile.",
  ].join('\n')
}

/**
 * Register stable read-only documentation resources after the server knows its actual tool surface.
 * The resources are registered before a transport connects and remain fixed for that server
 * lifetime; this module never mutates the resource set after startup.
 */
export function registerAgentResources(
  mcp: McpServer,
  registration: AgentResourceRegistration,
): void {
  for (const document of GENERATED_AGENT_RESOURCE_DOCUMENTS) {
    mcp.registerResource(
      document.name,
      document.uri,
      {
        title: document.title,
        description: document.description,
        mimeType: 'text/markdown',
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: decorateGuide(document.source, document.text),
          },
        ],
      }),
    )
  }

  mcp.registerResource(
    'active_tool_profile',
    ACTIVE_PROFILE_RESOURCE_URI,
    {
      title: 'Active tool profile',
      description: 'Compact summary of the current core profile and visible tool counts.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: profileResource(registration) }],
    }),
  )
}

export { GENERATED_AGENT_RESOURCE_DOCUMENTS } from './generated-documents.js'

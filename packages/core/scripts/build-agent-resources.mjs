// Generate the static MCP resource payloads from the tracked public guides.
//
// The published core tarball intentionally ships only `dist/`, README, and LICENSE, so MCP
// resources cannot read the repository's docs at runtime. This generator makes the tracked guides
// the canonical source and emits a small TypeScript module that is compiled into `dist/`.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')
const OUTPUT_PATH = path.join(PACKAGE_DIR, 'src', 'resources', 'generated-documents.ts')

const DOCUMENTS = [
  {
    uri: 'stagewright://docs/quickstart',
    name: 'quickstart',
    title: 'Electron Stagewright quickstart',
    description: 'Start an Electron app session and drive its UI safely.',
    source: 'docs/guides/getting-started.md',
  },
  {
    uri: 'stagewright://docs/concepts',
    name: 'concepts',
    title: 'Electron Stagewright concepts',
    description: 'Agent-native concepts: sessions, snapshots, refs, errors, and plugins.',
    source: 'docs/guides/concepts.md',
  },
  {
    uri: 'stagewright://docs/security',
    name: 'security',
    title: 'Electron Stagewright security model',
    description: 'Trust boundaries, eval opt-in, and safe operating guidance.',
    source: 'docs/guides/security-model.md',
  },
]

function normaliseMarkdown(text) {
  return text.replace(/\r\n/g, '\n')
}

function extractResourceSection(source, text) {
  const startMarker = '<!-- stagewright-resource:begin -->'
  const endMarker = '<!-- stagewright-resource:end -->'
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `${source} must contain one ${startMarker} … ${endMarker} section for its MCP resource.`,
    )
  }
  return `${text.slice(start + startMarker.length, end).trim()}\n`
}

async function render() {
  const documents = await Promise.all(
    DOCUMENTS.map(async (document) => ({
      ...document,
      text: extractResourceSection(
        document.source,
        normaliseMarkdown(await readFile(path.join(REPO_ROOT, document.source), 'utf8')),
      ),
    })),
  )
  const unformatted = [
    '/**',
    ' * Generated from tracked public guides by scripts/build-agent-resources.mjs.',
    ' * Do not edit manually; run pnpm build:resources from packages/core after changing a source guide.',
    ' */',
    '',
    `export const GENERATED_AGENT_RESOURCE_DOCUMENTS = ${JSON.stringify(documents, null, 2)} as const`,
    '',
  ].join('\n')
  const prettierConfig = await resolveConfig(OUTPUT_PATH)
  return format(unformatted, { ...prettierConfig, filepath: OUTPUT_PATH })
}

const output = await render()
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = await readFile(OUTPUT_PATH, 'utf8')
  } catch {
    // The diagnostic below names the deterministic remediation.
  }
  if (current !== output) {
    process.stderr.write(
      'Generated MCP resource documents are stale. Run pnpm --filter @electron-stagewright/core build:resources.\n',
    )
    process.exitCode = 1
  }
} else {
  await writeFile(OUTPUT_PATH, output, 'utf8')
}

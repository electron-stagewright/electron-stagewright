/**
 * Drift and integrity guards for the public guides (ADR-013) — prose rots silently, so both
 * failure modes that matter are checked mechanically:
 *
 * 1. **Tool-name drift** — every `electron_*` / `trace_*` / `production_*` / `ipc_*` name in the
 *    current-facing docs (guides, root README, SECURITY.md, llms.txt) must exist in the live core
 *    manifest (including eval-gated tools) or in the corresponding plugin's tool list. A current doc
 *    citing a renamed or misspelled tool fails CI the same way TOOL-REFERENCE drift does. Wildcard
 *    family mentions (`electron_expect_*`) are validated as prefixes.
 * 2. **Relative-link integrity** — every relative markdown link in the public docs (guides, ADRs,
 *    the root README, SECURITY.md, llms.txt) must resolve to a file that exists AND is
 *    tracked-eligible (not gitignored). This mechanises the content-policy rule that tracked files
 *    never link to the local-only planning docs.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createServer } from '../src/server/server.js'
import ipcPlugin from '../../plugin-ipc/src/index.js'
import productionPlugin from '../../plugin-production/src/index.js'
import tracePlugin from '../../plugin-trace/src/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const GUIDES_DIR = path.join(REPO_ROOT, 'docs', 'guides')
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr')
const FIRST_PARTY_PLUGINS = [tracePlugin, productionPlugin, ipcPlugin] as const

/** One markdown document loaded for scanning. */
interface MarkdownDoc {
  /** Absolute path (used to resolve its relative links). */
  readonly file: string
  /** Full text, line endings normalised. */
  readonly text: string
}

async function loadMarkdown(dir: string): Promise<MarkdownDoc[]> {
  const entries = await readdir(dir)
  const docs: MarkdownDoc[] = []
  for (const entry of entries.filter((name) => name.endsWith('.md')).sort()) {
    const file = path.join(dir, entry)
    docs.push({ file, text: (await readFile(file, 'utf8')).replace(/\r\n/g, '\n') })
  }
  return docs
}

async function loadCurrentPublicDocs(): Promise<MarkdownDoc[]> {
  return [
    ...(await loadMarkdown(GUIDES_DIR)),
    {
      file: path.join(REPO_ROOT, 'README.md'),
      text: (await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'),
    },
    {
      file: path.join(REPO_ROOT, '.github', 'SECURITY.md'),
      text: (await readFile(path.join(REPO_ROOT, '.github', 'SECURITY.md'), 'utf8')).replace(
        /\r\n/g,
        '\n',
      ),
    },
    {
      file: path.join(REPO_ROOT, 'llms.txt'),
      text: (await readFile(path.join(REPO_ROOT, 'llms.txt'), 'utf8')).replace(/\r\n/g, '\n'),
    },
  ]
}

async function loadLinkCheckedDocs(): Promise<MarkdownDoc[]> {
  return [...(await loadCurrentPublicDocs()), ...(await loadMarkdown(ADR_DIR))]
}

/**
 * Namespaced tool-name mentions. A trailing underscore (from a wildcard family mention like
 * `electron_expect_*`) survives the match and is validated as a prefix.
 */
const TOOL_MENTION = /\b(?:electron|trace|ipc|production)_[a-z][a-z0-9_]*/g

/** The full set of real tool names: the live core manifest plus every first-party plugin. */
async function collectKnownToolNames(): Promise<ReadonlySet<string>> {
  const known = new Set<string>()
  const server = await createServer({ allowEval: true })
  try {
    for (const entry of server.dispatcher.listManifest()) known.add(entry.name)
  } finally {
    await server.close().catch(() => undefined)
  }
  // The loader registers plugin tools as `<plugin>_<tool>` (ADR-004).
  for (const plugin of FIRST_PARTY_PLUGINS) {
    for (const tool of plugin.tools ?? []) known.add(`${plugin.name}_${tool.name}`)
  }
  return known
}

function collectRuntimeEvalGatedPluginTools(): string[] {
  const names: string[] = []
  for (const plugin of FIRST_PARTY_PLUGINS) {
    for (const tool of plugin.tools ?? []) {
      if (tool.description.includes('--allow-eval') || tool.description.includes('EVAL_REQUIRED')) {
        names.push(`${plugin.name}_${tool.name}`)
      }
    }
  }
  return names.sort((a, b) => a.localeCompare(b))
}

describe('public guides — tool-name drift', () => {
  it('every tool a public doc mentions exists in the core manifest or a plugin', async () => {
    const known = await collectKnownToolNames()
    const docs = await loadCurrentPublicDocs()
    expect(docs.length).toBeGreaterThan(0)

    const unknown: string[] = []
    for (const doc of docs) {
      for (const raw of doc.text.match(TOOL_MENTION) ?? []) {
        const isFamilyPrefix = raw.endsWith('_')
        const resolves = isFamilyPrefix
          ? [...known].some((name) => name.startsWith(raw))
          : known.has(raw)
        if (!resolves) {
          unknown.push(`${path.basename(doc.file)}: ${raw}`)
        }
      }
    }
    expect(unknown, `Guides mention tools that do not exist:\n${unknown.join('\n')}`).toEqual([])
  })
})

/** A relative link target extracted from one document. */
interface RelativeLink {
  readonly from: string
  readonly target: string
  readonly resolved: string
}

/** Markdown inline links — `](target)`; external schemes and pure anchors are skipped. */
const MARKDOWN_LINK = /\]\(([^()\s]+)\)/g

function extractRelativeLinks(doc: MarkdownDoc): RelativeLink[] {
  const links: RelativeLink[] = []
  for (const match of doc.text.matchAll(MARKDOWN_LINK)) {
    const target = match[1] ?? ''
    if (target === '' || target.startsWith('#')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http:, https:, mailto:, …
    const withoutAnchor = target.split('#')[0] ?? ''
    if (withoutAnchor === '') continue
    links.push({
      from: doc.file,
      target,
      resolved: path.resolve(path.dirname(doc.file), withoutAnchor),
    })
  }
  return links
}

/** Whether git ignores `p` — a tracked doc linking an ignored path leaks local-only files. */
function isGitIgnored(p: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', p], { cwd: REPO_ROOT })
    return true
  } catch {
    return false
  }
}

describe('public docs — relative-link integrity', () => {
  it('every relative link in guides, ADRs, README, SECURITY.md, and llms.txt resolves to a public file', async () => {
    const docs = await loadLinkCheckedDocs()

    const broken: string[] = []
    for (const doc of docs) {
      for (const link of extractRelativeLinks(doc)) {
        const label = `${path.relative(REPO_ROOT, link.from)} -> ${link.target}`
        if (!existsSync(link.resolved)) {
          broken.push(`${label} (target does not exist)`)
        } else if (isGitIgnored(link.resolved)) {
          broken.push(`${label} (target is gitignored / local-only)`)
        }
      }
    }
    expect(broken, `Public docs contain broken or private links:\n${broken.join('\n')}`).toEqual([])
  })
})

describe('security model — eval-gated tool coverage', () => {
  it('names every --allow-eval-gated core tool and runtime-gated plugin tool', async () => {
    // A new eval-gated tool must not ship without an entry in the published threat model. Core eval
    // tools advertise the gate through the manifest; first-party plugin tools can gate at runtime
    // while staying listed, so collect those from their descriptions too.
    const server = await createServer({ allowEval: true })
    let evalGated: string[]
    try {
      evalGated = server.dispatcher
        .listManifest()
        .filter((entry) => entry.requiresEvalFlag === true)
        .map((entry) => entry.name)
    } finally {
      await server.close().catch(() => undefined)
    }
    expect(evalGated.length).toBeGreaterThan(0)

    const securityModel = (
      await readFile(path.join(GUIDES_DIR, 'security-model.md'), 'utf8')
    ).replace(/\r\n/g, '\n')
    const runtimeGatedPluginTools = collectRuntimeEvalGatedPluginTools()
    const missing = [...evalGated, ...runtimeGatedPluginTools].filter(
      (name) => !securityModel.includes(name),
    )
    expect(
      missing,
      `security-model.md must name every --allow-eval-gated tool; missing:\n${missing.join('\n')}`,
    ).toEqual([])
  })
})

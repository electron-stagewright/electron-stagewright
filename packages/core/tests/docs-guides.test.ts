/**
 * Drift and integrity guards for the public guides (ADR-013) — prose rots silently, so both
 * failure modes that matter are checked mechanically:
 *
 * 1. **Tool-name drift** — every `electron_*` / `trace_*` / `production_*` / `ipc_*` name in the
 *    current-facing docs (guides, root README, GitHub community files, llms.txt) must exist in the
 *    live core manifest (including eval-gated tools) or in the corresponding plugin's tool list. A
 *    current doc citing a renamed or misspelled tool fails CI the same way TOOL-REFERENCE drift does.
 *    Wildcard family mentions (`electron_expect_*`) are validated as prefixes.
 * 2. **Relative-link integrity** — every relative markdown link in the public docs (guides, ADRs,
 *    the root README, GitHub community files, llms.txt) must resolve to a file that exists AND is
 *    tracked-eligible (not gitignored). This mechanises the content-policy rule that tracked files
 *    never link to the local-only planning docs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createServer } from '../src/server/server.js'
import { NOOP_LOGGER } from '../src/server/logger.js'
import ipcPlugin from '../../plugin-ipc/src/index.js'
import networkPlugin from '../../plugin-network/src/index.js'
import productionPlugin from '../../plugin-production/src/index.js'
import tracePlugin from '../../plugin-trace/src/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const GUIDES_DIR = path.join(REPO_ROOT, 'docs', 'guides')
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr')
const GITHUB_DIR = path.join(REPO_ROOT, '.github')
const FIRST_PARTY_PLUGINS = [tracePlugin, productionPlugin, ipcPlugin, networkPlugin] as const

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

async function loadMarkdownTree(dir: string): Promise<MarkdownDoc[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const docs: MarkdownDoc[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      docs.push(...(await loadMarkdownTree(file)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      docs.push({ file, text: (await readFile(file, 'utf8')).replace(/\r\n/g, '\n') })
    }
  }
  return docs
}

async function loadCurrentPublicDocs(): Promise<MarkdownDoc[]> {
  return [
    ...(await loadMarkdown(GUIDES_DIR)),
    ...(await loadMarkdownTree(GITHUB_DIR)),
    {
      file: path.join(REPO_ROOT, 'README.md'),
      text: (await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'),
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
const TOOL_MENTION = /\b(?:electron|trace|ipc|network|production)_[a-z][a-z0-9_]*/g

/** The full set of real tool names: the live core manifest plus every first-party plugin. */
async function collectKnownToolNames(): Promise<ReadonlySet<string>> {
  const known = new Set<string>()
  const server = await createServer({ allowEval: true, logger: NOOP_LOGGER })
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

/**
 * The subset of a `spawnSync` result that {@link assertGitCheckIgnoreSucceeded} inspects. Narrowed to
 * these three fields so the success check can be unit-tested with a plain literal instead of a real
 * spawn. `status` is the process exit code, or `null` when git was killed by a signal; `error` is set
 * only when the process could not be spawned at all (e.g. git missing).
 */
interface GitCheckIgnoreResult {
  readonly error?: Error
  readonly status: number | null
  readonly stderr: string
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

/**
 * The subset of `paths` that git ignores, computed in ONE `git check-ignore` call rather than one
 * spawn per path. A tracked doc that links an ignored path leaks a local-only file. Per-path spawning
 * was slow enough on Windows (where process creation is costly) to time the whole test out as the doc
 * set grew; `--stdin --verbose --non-matching` emits one verdict line per input, in order, so paths
 * are matched by index — no fragile cross-platform path-string comparison.
 */
function gitIgnoredPaths(paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return new Set()
  const result = spawnSync('git', ['check-ignore', '--stdin', '--verbose', '--non-matching'], {
    cwd: REPO_ROOT,
    input: paths.join('\n'),
    encoding: 'utf8',
  })
  assertGitCheckIgnoreSucceeded(result)
  const lines = (result.stdout ?? '').split('\n').filter((line) => line.length > 0)
  const ignored = new Set<string>()
  lines.forEach((line, index) => {
    // A non-matching path reports an empty `<source>:<line>:<pattern>` — i.e. the line starts `::`.
    const p = paths[index]
    if (p !== undefined && !line.startsWith('::')) ignored.add(p)
  })
  return ignored
}

function assertGitCheckIgnoreSucceeded(result: GitCheckIgnoreResult): void {
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    const detail =
      (result.error?.message ?? result.stderr.trim()) || 'unknown git check-ignore error'
    throw new Error(`git check-ignore failed while validating public-doc links: ${detail}`)
  }
}

describe('gitIgnoredPaths', () => {
  it('fails loudly if the batched git probe fails', () => {
    expect(() =>
      assertGitCheckIgnoreSucceeded({
        status: 128,
        stderr: 'fatal: not a git repository',
      }),
    ).toThrow(
      'git check-ignore failed while validating public-doc links: fatal: not a git repository',
    )
  })
})

describe('public docs — relative-link integrity', () => {
  it('every relative link in public markdown docs and llms.txt resolves to a public file', async () => {
    const docs = await loadLinkCheckedDocs()
    const links = docs.flatMap((doc) =>
      extractRelativeLinks(doc).map((link) => ({
        label: `${path.relative(REPO_ROOT, link.from)} -> ${link.target}`,
        resolved: link.resolved,
        exists: existsSync(link.resolved),
      })),
    )
    const ignored = gitIgnoredPaths(
      links.filter((link) => link.exists).map((link) => link.resolved),
    )

    const broken: string[] = []
    for (const link of links) {
      if (!link.exists) {
        broken.push(`${link.label} (target does not exist)`)
      } else if (ignored.has(link.resolved)) {
        broken.push(`${link.label} (target is gitignored / local-only)`)
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
    const server = await createServer({ allowEval: true, logger: NOOP_LOGGER })
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

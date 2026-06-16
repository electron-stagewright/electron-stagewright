/**
 * Tests for the docs-site generator (ADR-013). Unit-tests the pure path/link helpers, then runs the
 * full build against the REAL public docs into a temp directory and asserts every page renders, the
 * build has no broken internal links, and no unresolved relative `.md` href survives in the output.
 * The generator lives under `scripts/` (never published); this test typechecks it via the import.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  buildDocsSite,
  canLinkAsGitHubBlob,
  extractTitle,
  githubHeadingSlug,
  mapDocToOutput,
  rewriteLinks,
} from '../scripts/build-docs-site.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GITHUB = 'https://github.com/electron-stagewright/electron-stagewright/blob/main/'

describe('mapDocToOutput', () => {
  it('maps the public docs to site-relative HTML paths', () => {
    expect(mapDocToOutput('README.md')).toBe('index.html')
    expect(mapDocToOutput('TOOL-REFERENCE.md')).toBe('tool-reference.html')
    expect(mapDocToOutput('docs/guides/concepts.md')).toBe('guides/concepts.html')
    expect(mapDocToOutput('docs/guides/README.md')).toBe('guides/index.html')
    expect(mapDocToOutput('docs/adr/005-snapshot-schema-v1.md')).toBe(
      'adr/005-snapshot-schema-v1.html',
    )
    expect(mapDocToOutput('.github/CONTRIBUTING.md')).toBe('contributing.html')
  })

  it('does not render internal, template, or local-only files', () => {
    expect(mapDocToOutput('.github/PULL_REQUEST_TEMPLATE.md')).toBeNull()
    expect(mapDocToOutput('docs/ROADMAP.md')).toBeNull()
    expect(mapDocToOutput('packages/core/src/index.ts')).toBeNull()
  })
})

describe('extractTitle', () => {
  it('uses the first H1, stripped of backticks', () => {
    expect(extractTitle('# Concepts — how it works\n\nbody', 'docs/guides/concepts.md')).toBe(
      'Concepts — how it works',
    )
    expect(extractTitle('# The `electron_eval` tool', 'x.md')).toBe('The electron_eval tool')
  })

  it('falls back to the file stem when there is no H1', () => {
    expect(extractTitle('no heading here', 'docs/guides/getting-started.md')).toBe(
      'getting-started',
    )
  })
})

describe('githubHeadingSlug', () => {
  it('matches the GitHub-style anchors used by the source docs', () => {
    expect(githubHeadingSlug('What each response looks like (the agent-UX detail)')).toBe(
      'what-each-response-looks-like-the-agent-ux-detail',
    )
    expect(githubHeadingSlug('The `electron_eval` tool')).toBe('the-electron_eval-tool')
  })
})

describe('rewriteLinks', () => {
  const linkMap = new Map([
    ['docs/guides/concepts.md', 'guides/concepts.html'],
    ['TOOL-REFERENCE.md', 'tool-reference.html'],
  ])
  const exists = (rel: string): boolean => rel === 'examples/minimal-app/README.md'

  it('rewrites a relative .md link to a rendered page, relative to the current page', () => {
    const { html, broken } = rewriteLinks(
      '<a href="./concepts.md">x</a>',
      'docs/guides/getting-started.md',
      'guides/getting-started.html',
      linkMap,
      exists,
    )
    expect(html).toContain('href="concepts.html"')
    expect(broken).toEqual([])
  })

  it('preserves an anchor and resolves a parent path', () => {
    const { html } = rewriteLinks(
      '<a href="../../TOOL-REFERENCE.md#electron_snapshot">ref</a>',
      'docs/guides/concepts.md',
      'guides/concepts.html',
      linkMap,
      exists,
    )
    expect(html).toContain('href="../tool-reference.html#electron_snapshot"')
  })

  it('rewrites a link to a tracked-but-unrendered file to its GitHub blob URL', () => {
    const { html, broken } = rewriteLinks(
      '<a href="../../examples/minimal-app/README.md">example</a>',
      'docs/guides/getting-started.md',
      'guides/getting-started.html',
      linkMap,
      exists,
    )
    expect(html).toContain(`href="${GITHUB}examples/minimal-app/README.md"`)
    expect(broken).toEqual([])
  })

  it('leaves external links and pure anchors untouched', () => {
    const { html } = rewriteLinks(
      '<a href="https://example.com">x</a> <a href="#section">y</a>',
      'docs/guides/concepts.md',
      'guides/concepts.html',
      linkMap,
      exists,
    )
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('href="#section"')
  })

  it('collects a link whose target does not exist as broken', () => {
    const { broken } = rewriteLinks(
      '<a href="./does-not-exist.md">x</a>',
      'docs/guides/concepts.md',
      'guides/concepts.html',
      linkMap,
      exists,
    )
    expect(broken).toEqual(['docs/guides/concepts.md -> ./does-not-exist.md'])
  })
})

describe('canLinkAsGitHubBlob', () => {
  it('allows tracked files but rejects local-only planning docs', () => {
    expect(canLinkAsGitHubBlob(REPO_ROOT, 'LICENSE')).toBe(true)
    // Missing in a fresh public checkout, gitignored in a maintainer checkout; both must be rejected
    // so the generated site never turns local planning docs into public GitHub blob links.
    expect(canLinkAsGitHubBlob(REPO_ROOT, 'docs/PLAN.md')).toBe(false)
  })
})

describe('buildDocsSite (full build against the real docs)', () => {
  let outDir = ''
  afterAll(async () => {
    if (outDir !== '') await rm(outDir, { recursive: true, force: true })
  })

  it('renders every public doc with no broken internal link', async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'sw-docs-site-'))
    // buildDocsSite throws on a broken internal link, so this test fails before the assertions if
    // the real docs' cross-link graph is broken; the assertions below document the success shape.
    const result = await buildDocsSite({ repoRoot: REPO_ROOT, outDir })
    expect(result.brokenLinks).toEqual([])
    expect(result.pageCount).toBeGreaterThan(20)

    for (const rel of [
      'index.html',
      'guides/concepts.html',
      'adr/index.html',
      'tool-reference.html',
      'sitemap.xml',
      'llms.txt',
    ]) {
      await expect(readFile(path.join(outDir, rel), 'utf8')).resolves.toBeTruthy()
    }

    const home = await readFile(path.join(outDir, 'index.html'), 'utf8')
    expect(home).toContain('class="sidebar"')
    expect(home).toContain('id="what-each-response-looks-like-the-agent-ux-detail"')
    // No unresolved RELATIVE `.md` href survives (GitHub-blob `.md` URLs start with https and are ok).
    expect(home).not.toMatch(/href="(?!https?:\/\/)[^"]*\.md"/)
  })
})

/**
 * Static-site generator for the public docs (ADR-013). A deliberately lean markdown→HTML pipeline —
 * one markdown library, no framework — that consumes the tracked public docs in place (the guides,
 * the ADRs, the generated tool reference, the root README) and emits a browsable `site/` of linked
 * HTML pages with a Diátaxis-grouped sidebar, syntax-highlighted code, a copied `llms.txt`, and a
 * `sitemap.xml`. Relative `.md` links are rewritten to the mapped `.html` path; an unresolvable
 * internal link FAILS the build (a guard that complements the source-link check in
 * `docs-guides.test.ts`).
 *
 * It lives under `scripts/` (never `src/`), so neither it nor its build-only `marked`/`highlight.js`
 * dependencies ship in the published `dist/`. Run it with `pnpm docs:site`.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import hljs from 'highlight.js'
import { Marked, type RendererObject, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..')
/** Base URL for `sitemap.xml` — the project's GitHub Pages origin. */
const SITE_BASE_URL = 'https://electron-stagewright.github.io/electron-stagewright/'
/** GitHub blob base for links to tracked repo files that are not rendered into the site. */
const GITHUB_BLOB_BASE = 'https://github.com/electron-stagewright/electron-stagewright/blob/main/'

/**
 * One source doc to render. `sourceRel` is repo-root-relative (`docs/guides/concepts.md`);
 * `outputRel` is site-root-relative (`guides/concepts.html`); `title` feeds the `<title>` and nav.
 */
export interface DocPage {
  readonly sourceRel: string
  readonly outputRel: string
  readonly title: string
}

/** The site-relative output path for a repo-relative source doc, or `null` if it is not rendered. */
export function mapDocToOutput(sourceRel: string): string | null {
  const normalized = sourceRel.replace(/\\/g, '/')
  if (normalized === 'README.md') return 'index.html'
  if (normalized === 'TOOL-REFERENCE.md') return 'tool-reference.html'
  for (const [dir, prefix] of [
    ['docs/guides/', 'guides/'],
    ['docs/adr/', 'adr/'],
  ] as const) {
    if (normalized.startsWith(dir) && normalized.endsWith('.md')) {
      const base = normalized.slice(dir.length, -'.md'.length)
      // The directory README becomes that section's index.html.
      return `${prefix}${base === 'README' ? 'index' : base}.html`
    }
  }
  // The public community docs — an allowlist, so GitHub templates (PULL_REQUEST_TEMPLATE, issue
  // forms) are not rendered as doc pages. Links to a non-rendered file fall back to its GitHub URL.
  if (normalized.startsWith('.github/') && normalized.endsWith('.md')) {
    const base = normalized.slice('.github/'.length, -'.md'.length)
    const COMMUNITY = new Set([
      'CONTRIBUTING',
      'GOVERNANCE',
      'SECURITY',
      'RELEASING',
      'CODE_OF_CONDUCT',
    ])
    return COMMUNITY.has(base) ? `${base.toLowerCase()}.html` : null
  }
  return null
}

/** The first `# H1` of a markdown doc, or the file stem when it has none — used as the page title. */
export function extractTitle(markdown: string, sourceRel: string): string {
  const h1 = markdown.match(/^#\s+(.+?)\s*$/m)
  if (h1?.[1] !== undefined) return h1[1].replace(/`/g, '')
  return path.basename(sourceRel).replace(/\.[^.]+$/, '')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** GitHub-style heading slug, matching the anchors our markdown docs already link to. */
export function githubHeadingSlug(text: string): string {
  const slug = text
    .replace(/`([^`]*)`/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
  return slug === '' ? 'section' : slug
}

function createMarkdownRenderer(): Marked {
  const headingCounts = new Map<string, number>()
  const renderer: RendererObject = {
    heading(this, token: Tokens.Heading) {
      const base = githubHeadingSlug(token.text)
      const count = headingCounts.get(base) ?? 0
      headingCounts.set(base, count + 1)
      const id = count === 0 ? base : `${base}-${count}`
      return `<h${token.depth} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`
    },
  }

  return new Marked(
    markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = lang && hljs.getLanguage(lang) ? lang : undefined
        return language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value
      },
    }),
    { renderer },
  )
}

/** The `../`-prefix that turns a site-root-relative path into one relative to `fromOutputRel`. */
function relativePrefix(fromOutputRel: string): string {
  const depth = fromOutputRel.split('/').length - 1
  return '../'.repeat(depth)
}

/**
 * Rewrite relative links in rendered HTML. A relative link to a rendered page becomes the mapped
 * `.html`, relative to the current page; a relative link to any other tracked repo file (an example
 * README, `LICENSE`, …) becomes its GitHub blob URL; a relative link whose target does not exist is
 * collected as broken. External (`scheme:`) links and pure `#anchors` are left untouched.
 */
export function rewriteLinks(
  html: string,
  sourceRel: string,
  outputRel: string,
  linkMap: ReadonlyMap<string, string>,
  repoFileCanLink: (repoRel: string) => boolean,
): { html: string; broken: string[] } {
  const broken: string[] = []
  const fromOutputDir = path.posix.dirname(outputRel)
  const sourceDir = path.posix.dirname(sourceRel.replace(/\\/g, '/'))

  const rewriteHrefs = (segment: string): string =>
    segment.replace(/href="([^"]*)"/g, (match, href: string) => {
      if (href === '' || href.startsWith('#')) return match
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return match // http:, https:, mailto:, …
      const hashIndex = href.indexOf('#')
      const filePart = hashIndex === -1 ? href : href.slice(0, hashIndex)
      const suffix = hashIndex === -1 ? '' : href.slice(hashIndex)
      const targetRel = path.posix.normalize(path.posix.join(sourceDir, filePart))

      const mapped = linkMap.get(targetRel)
      if (mapped !== undefined) {
        return `href="${path.posix.relative(fromOutputDir, mapped)}${suffix}"`
      }
      if (repoFileCanLink(targetRel)) {
        return `href="${GITHUB_BLOB_BASE}${targetRel}${suffix}"`
      }
      broken.push(`${sourceRel} -> ${href}`)
      return match
    })

  // Rewrite hrefs only OUTSIDE <pre>…</pre> — a code sample may contain a literal href="…/x.md".
  // Splitting on a capturing group puts the <pre> blocks at odd indices, which are left verbatim.
  const rewritten = html
    .split(/(<pre[\s\S]*?<\/pre>)/g)
    .map((segment, index) => (index % 2 === 0 ? rewriteHrefs(segment) : segment))
    .join('')

  return { html: rewritten, broken }
}

/**
 * Whether a non-rendered repo path is safe to expose as a GitHub blob link. Existence alone is not
 * enough: local planning files under `docs/` exist in the maintainer checkout but are gitignored, so
 * linking them would ship a public 404 and leak private planning vocabulary. `git ls-files` answers
 * against the index, so staged public docs also count during local review.
 */
export function canLinkAsGitHubBlob(repoRoot: string, repoRel: string): boolean {
  const normalized = repoRel.replace(/\\/g, '/')
  if (!existsSync(path.join(repoRoot, normalized))) return false
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', normalized], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** Build the shared Diátaxis-grouped sidebar, with hrefs relative to `currentOutputRel`. */
function renderNav(
  currentOutputRel: string,
  adrPages: readonly DocPage[],
  projectPages: readonly DocPage[],
): string {
  const prefix = relativePrefix(currentOutputRel)
  const link = (target: string, label: string): string => {
    const cls = target === currentOutputRel ? ' class="active"' : ''
    return `<li><a href="${prefix}${target}"${cls}>${escapeHtml(label)}</a></li>`
  }
  const groups: Array<{ heading: string | null; items: Array<{ target: string; label: string }> }> =
    [
      { heading: null, items: [{ target: 'index.html', label: 'Home' }] },
      {
        heading: 'Tutorial',
        items: [{ target: 'guides/getting-started.html', label: 'Getting started' }],
      },
      {
        heading: 'How-to',
        items: [
          { target: 'guides/launch-or-attach.html', label: 'Launch, attach, or inject' },
          { target: 'guides/assert-ui-state.html', label: 'Assert UI state' },
          { target: 'guides/capture-diagnostics.html', label: 'Capture diagnostics' },
          {
            target: 'guides/migrate-from-electron-driver.html',
            label: 'Migrate from electron-driver',
          },
        ],
      },
      {
        heading: 'Explanation',
        items: [
          { target: 'guides/concepts.html', label: 'Concepts' },
          { target: 'guides/security-model.html', label: 'Security model' },
        ],
      },
      {
        heading: 'Reference',
        items: [
          { target: 'tool-reference.html', label: 'Tool reference' },
          { target: 'guides/index.html', label: 'Guides index' },
          { target: 'adr/index.html', label: 'Architecture decisions' },
        ],
      },
      {
        heading: 'Project',
        items: projectPages.map((p) => ({ target: p.outputRel, label: p.title })),
      },
      {
        heading: 'Decision records',
        items: adrPages
          .filter((p) => p.outputRel !== 'adr/index.html')
          .map((p) => ({ target: p.outputRel, label: p.title })),
      },
    ]
  const sections = groups
    .map(({ heading, items }) => {
      const head = heading === null ? '' : `<h3>${escapeHtml(heading)}</h3>`
      return `${head}<ul>${items.map((i) => link(i.target, i.label)).join('')}</ul>`
    })
    .join('\n')
  return `<a class="brand" href="${prefix}index.html">Electron Stagewright</a>\n${sections}`
}

/** Minimal, self-contained page styling plus a compact highlight.js token palette. */
const CSS = `
:root{--fg:#1b1f24;--muted:#57606a;--bg:#fff;--side:#f6f8fa;--line:#d0d7de;--link:#0969da;--code:#f6f8fa}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
.layout{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto}
.sidebar{width:280px;flex:0 0 280px;padding:24px 18px;background:var(--side);border-right:1px solid var(--line);height:100vh;position:sticky;top:0;overflow:auto}
.sidebar .brand{display:block;font-weight:700;font-size:17px;color:var(--fg);text-decoration:none;margin-bottom:16px}
.sidebar h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 6px}
.sidebar ul{list-style:none;margin:0;padding:0}.sidebar li{margin:2px 0}
.sidebar a{color:var(--fg);text-decoration:none;font-size:14px;display:block;padding:3px 8px;border-radius:6px}
.sidebar a:hover{background:#eaeef2}.sidebar a.active{background:#ddf4ff;color:var(--link);font-weight:600}
.content{flex:1 1 auto;min-width:0;padding:32px 40px;max-width:860px}
.content h1,.content h2,.content h3{line-height:1.25}.content h1{margin-top:0}
.content h2{border-bottom:1px solid var(--line);padding-bottom:.3em;margin-top:1.6em}
.content a{color:var(--link);text-decoration:none}.content a:hover{text-decoration:underline}
.content code{background:var(--code);padding:.15em .35em;border-radius:5px;font-size:.88em}
.content pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto}
.content pre code{background:none;padding:0;font-size:.84em}
.content table{border-collapse:collapse;display:block;overflow:auto}
.content th,.content td{border:1px solid var(--line);padding:6px 12px}.content th{background:var(--side)}
.content blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}
@media(max-width:800px){.layout{flex-direction:column}.sidebar{width:100%;height:auto;position:static;border-right:none;border-bottom:1px solid var(--line)}}
.hljs-comment,.hljs-quote{color:#6a737d}.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-literal{color:#d73a49}
.hljs-string,.hljs-attr,.hljs-template-tag,.hljs-addition{color:#032f62}.hljs-number,.hljs-meta{color:#005cc5}
.hljs-title,.hljs-section,.hljs-function .hljs-title{color:#6f42c1}.hljs-type,.hljs-class .hljs-title{color:#e36209}
`.trim()

function renderTemplate(title: string, bodyHtml: string, navHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Electron Stagewright docs</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
<nav class="sidebar">${navHtml}</nav>
<main class="content">${bodyHtml}</main>
</div>
</body>
</html>
`
}

/** List every immediate `*.md` under a repo-relative directory, repo-root-relative and sorted. */
async function listMarkdown(repoRoot: string, dirRel: string): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, dirRel), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `${dirRel}/${entry.name}`)
    .sort()
}

/** Result of a site build: the page count and any broken internal links found. */
export interface BuildResult {
  readonly pageCount: number
  readonly brokenLinks: readonly string[]
}

/**
 * Render the public docs to a static site under `outDir`. Throws if any internal `.md` link cannot
 * be mapped (the build-time broken-link guard). Reads only the tracked public docs — never the
 * gitignored local-only planning docs.
 */
export async function buildDocsSite(
  opts: { repoRoot?: string; outDir?: string } = {},
): Promise<BuildResult> {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT
  const outDir = opts.outDir ?? path.join(repoRoot, 'site')

  const sources = [
    'README.md',
    'TOOL-REFERENCE.md',
    ...(await listMarkdown(repoRoot, 'docs/guides')),
    ...(await listMarkdown(repoRoot, 'docs/adr')),
    ...(await listMarkdown(repoRoot, '.github')),
  ]

  const pages: DocPage[] = []
  const linkMap = new Map<string, string>()
  const markdownBySource = new Map<string, string>()
  for (const sourceRel of sources) {
    const outputRel = mapDocToOutput(sourceRel)
    if (outputRel === null) continue
    const markdown = await readFile(path.join(repoRoot, sourceRel), 'utf8')
    markdownBySource.set(sourceRel, markdown)
    pages.push({ sourceRel, outputRel, title: extractTitle(markdown, sourceRel) })
    linkMap.set(sourceRel.replace(/\\/g, '/'), outputRel)
  }

  const adrPages = pages.filter((p) => p.outputRel.startsWith('adr/'))
  const projectPages = pages.filter((p) => p.sourceRel.startsWith('.github/'))
  // Render every page to memory first. Only touch the output directory once the whole link graph is
  // known to be intact, so a broken build throws WITHOUT leaving a partial or stale-broken site.
  const repoFileCanLink = (rel: string): boolean => canLinkAsGitHubBlob(repoRoot, rel)
  const outputs: Array<{ outPath: string; document: string }> = []
  const allBroken: string[] = []
  for (const page of pages) {
    const markdown = markdownBySource.get(page.sourceRel) ?? ''
    const marked = createMarkdownRenderer()
    const rendered = await marked.parse(markdown)
    const { html, broken } = rewriteLinks(
      rendered,
      page.sourceRel,
      page.outputRel,
      linkMap,
      repoFileCanLink,
    )
    allBroken.push(...broken)
    const document = renderTemplate(
      page.title,
      html,
      renderNav(page.outputRel, adrPages, projectPages),
    )
    outputs.push({ outPath: path.join(outDir, page.outputRel), document })
  }
  if (allBroken.length > 0) {
    throw new Error(
      `Docs site has ${allBroken.length} unresolved internal link(s):\n${allBroken.join('\n')}`,
    )
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const { outPath, document } of outputs) {
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, document, 'utf8')
  }
  // Serve llms.txt verbatim (it is an AI-discovery artifact, not a human page) and a sitemap.
  await copyFile(path.join(repoRoot, 'llms.txt'), path.join(outDir, 'llms.txt'))
  await writeFile(path.join(outDir, 'sitemap.xml'), renderSitemap(pages), 'utf8')

  return { pageCount: pages.length, brokenLinks: allBroken }
}

/** A minimal `sitemap.xml` listing every rendered page against {@link SITE_BASE_URL}. */
function renderSitemap(pages: readonly DocPage[]): string {
  const urls = pages.map((p) => `  <url><loc>${SITE_BASE_URL}${p.outputRel}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

// Run as a script (pnpm docs:site) — not when imported by the test.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  buildDocsSite()
    .then((r) => process.stdout.write(`Docs site built: ${r.pageCount} pages.\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}

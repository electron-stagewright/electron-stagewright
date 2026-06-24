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
/** Site-wide meta description — the search snippet and the Open Graph / Twitter card description. */
const SITE_DESCRIPTION =
  'Agent-native MCP server for driving real Electron apps from AI agents: launch or attach, read the accessibility tree, assert UI state, and capture diagnostics.'
/** Social-card image (1200x630) served at the site root; the Open Graph / Twitter card image. */
const SOCIAL_CARD_URL = `${SITE_BASE_URL}social-card.png`
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
          { target: 'guides/connect-your-mcp-client.html', label: 'Connect your MCP client' },
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
  return sections
}

/** Self-contained styling: a refined technical theme with light + dark mode and a tuned hljs palette. */
const CSS = `
:root{color-scheme:light dark;
--bg:#fbfaf8;--bg-elev:#ffffff;--surface:#f4f2ec;--surface-2:#ece8df;
--fg:#1c1b18;--muted:#6b685f;--faint:#928e83;--line:#e7e3d9;--line-2:#dad5c8;
--accent:#b45309;--accent-soft:#fbeed7;
--shadow:0 1px 2px rgba(28,27,24,.04),0 10px 30px -16px rgba(28,27,24,.18);
--hl-comment:#9a9588;--hl-kw:#b03a2e;--hl-str:#3f7a45;--hl-num:#1f6f8b;--hl-fn:#9a5b06;--hl-type:#7a3e9d;
--font-sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--font-mono:ui-monospace,SFMono-Regular,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#141310;--bg-elev:#1b1914;--surface:#1a1812;--surface-2:#262219;
--fg:#ece8dc;--muted:#a09b8d;--faint:#7b776a;--line:#2a261d;--line-2:#3a3528;
--accent:#f0b552;--accent-soft:rgba(240,181,82,.12);
--shadow:0 1px 2px rgba(0,0,0,.3),0 12px 34px -16px rgba(0,0,0,.6);
--hl-comment:#7b776a;--hl-kw:#f0876a;--hl-str:#a6cf8a;--hl-num:#6fc2d8;--hl-fn:#f0b552;--hl-type:#c79be8}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-sans);font-size:16px;line-height:1.7;color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:var(--accent-soft)}
a{color:var(--accent);text-decoration:none}
.skip{position:absolute;left:-9999px;top:0;z-index:10;background:var(--accent);color:#fff;padding:8px 14px;border-radius:8px}
.skip:focus{left:12px;top:12px}
.topbar{position:sticky;top:0;z-index:8;display:flex;align-items:center;justify-content:space-between;gap:16px;height:56px;padding:0 22px;border-bottom:1px solid var(--line);box-shadow:inset 0 2px 0 var(--accent);background:var(--bg);background:color-mix(in srgb,var(--bg) 80%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(10px);backdrop-filter:saturate(1.4) blur(10px)}
.topbar-left{display:flex;align-items:center;gap:10px;min-width:0}
.topbar .brand{display:flex;align-items:center;gap:9px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono);font-weight:500;font-size:15px;letter-spacing:-.01em;color:var(--fg)}
.hamburger{display:none;flex:0 0 auto;flex-direction:column;justify-content:center;gap:4px;width:38px;height:38px;padding:9px;border:1px solid var(--line-2);border-radius:9px;background:none;cursor:pointer}
.hamburger span{display:block;height:2px;width:100%;background:var(--fg);border-radius:2px;transition:transform .2s,opacity .2s}
.nav-scrim{display:none}
.topbar .brand .mark{color:var(--accent);font-size:13px}
.topbar .brand .tag{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);border:1px solid var(--line-2);border-radius:5px;padding:1px 6px}
.topnav{display:flex;gap:4px}
.topnav a{font-size:13.5px;color:var(--muted);padding:6px 11px;border-radius:8px;transition:background .15s,color .15s}
.topnav a:hover{background:var(--surface-2);color:var(--fg)}
.layout{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto}
.sidebar{width:272px;flex:0 0 272px;padding:26px 16px 48px;height:calc(100vh - 56px);position:sticky;top:56px;overflow:auto;border-right:1px solid var(--line);scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}
.sidebar::-webkit-scrollbar{width:9px}.sidebar::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:9px;border:3px solid var(--bg)}
.sidebar h3{font-family:var(--font-mono);font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);margin:22px 6px 7px}
.sidebar ul{list-style:none;margin:0;padding:0}.sidebar li{margin:1px 0}
.sidebar a{display:block;font-size:13.5px;color:var(--muted);padding:6px 10px;border-radius:8px;border-left:2px solid transparent;transition:background .15s,color .15s}
.sidebar a:hover{background:var(--surface-2);color:var(--fg)}
.sidebar a.active{background:var(--accent-soft);color:var(--accent);font-weight:500;border-left-color:var(--accent)}
.content{flex:1 1 auto;min-width:0;max-width:792px;padding:44px 52px 96px;animation:rise .5s ease both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.content>*:first-child{margin-top:0}
.content h1{font-size:2.05rem;line-height:1.15;letter-spacing:-.022em;font-weight:680;margin:.2em 0 .55em}
.content h2{font-size:1.42rem;line-height:1.25;letter-spacing:-.015em;font-weight:650;margin:2.4em 0 .7em;padding-top:1.4em;border-top:1px solid var(--line)}
.content h3{font-size:1.16rem;line-height:1.3;letter-spacing:-.01em;font-weight:650;margin:1.9em 0 .5em}
.content h1,.content h2,.content h3{scroll-margin-top:74px}
.content a{text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 35%,transparent);text-underline-offset:2px;text-decoration-thickness:1px;transition:text-decoration-color .15s}
.content a:hover{text-decoration-color:var(--accent)}
.content strong{font-weight:650}
.content code{font-family:var(--font-mono);font-size:.86em;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:.1em .36em}
.content pre{font-family:var(--font-mono);background:var(--bg-elev);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:1.3em 0;overflow:auto;box-shadow:var(--shadow);line-height:1.6}
.content pre code{background:none;border:0;padding:0;font-size:.85em}
.content pre::-webkit-scrollbar{height:9px}.content pre::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:9px}
.content blockquote{margin:1.3em 0;padding:.4em 0 .4em 1.1em;border-left:3px solid var(--accent);color:var(--muted)}
.content blockquote p{margin:.4em 0}
.content table{border-collapse:collapse;display:block;overflow:auto;margin:1.3em 0;font-size:.93em}
.content thead th{font-family:var(--font-mono);font-size:.8em;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:left;font-weight:500;border-bottom:1px solid var(--line-2);padding:8px 14px}
.content tbody td{border-bottom:1px solid var(--line);padding:9px 14px;vertical-align:top}
.content tbody tr:hover{background:var(--surface)}
.content hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
@media (max-width:860px){
.topbar{padding:0 14px;gap:10px}
.topbar .brand{font-size:14px}
.topbar .brand .tag{display:none}
.topnav{gap:2px}.topnav a{padding:6px 8px;font-size:13px}
.js .hamburger{display:flex}
.layout{flex-direction:column;align-items:stretch;max-width:none}
.content{padding:28px 18px 72px;max-width:none;width:100%}
.content h1{font-size:1.72rem}
.content pre,.content table{font-size:.84em}
.content code{overflow-wrap:anywhere}
.sidebar{width:100%;flex-basis:auto;height:auto;position:static;border-right:0;border-bottom:1px solid var(--line)}
.js .sidebar{position:fixed;top:56px;left:0;bottom:0;width:min(84vw,330px);transform:translateX(-100%);transition:transform .24s ease;z-index:9;background:var(--surface);border:0;border-right:1px solid var(--line);box-shadow:var(--shadow);overflow:auto;padding:20px 14px 40px}
.nav-open .sidebar{transform:none}
.js .nav-scrim{display:block;position:fixed;inset:56px 0 0 0;z-index:8;background:rgba(0,0,0,.42);opacity:0;pointer-events:none;transition:opacity .2s}
.nav-open .nav-scrim{opacity:1;pointer-events:auto}
.nav-open .hamburger span:nth-child(1){transform:translateY(6px) rotate(45deg)}
.nav-open .hamburger span:nth-child(2){opacity:0}
.nav-open .hamburger span:nth-child(3){transform:translateY(-6px) rotate(-45deg)}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.hljs-comment,.hljs-quote{color:var(--hl-comment);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-literal{color:var(--hl-kw)}
.hljs-string,.hljs-attr,.hljs-template-tag,.hljs-addition{color:var(--hl-str)}
.hljs-number,.hljs-meta{color:var(--hl-num)}
.hljs-title,.hljs-section,.hljs-function .hljs-title,.hljs-name{color:var(--hl-fn)}
.hljs-type,.hljs-class .hljs-title{color:var(--hl-type)}
`.trim()

function renderTemplate(
  title: string,
  bodyHtml: string,
  navHtml: string,
  outputRel: string,
): string {
  const home = `${relativePrefix(outputRel)}index.html`
  const canonical = `${SITE_BASE_URL}${outputRel === 'index.html' ? '' : outputRel}`
  const pageTitle = `${escapeHtml(title)} — Electron Stagewright docs`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${SITE_DESCRIPTION}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Electron Stagewright">
<meta property="og:title" content="${pageTitle}">
<meta property="og:description" content="${SITE_DESCRIPTION}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SOCIAL_CARD_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${pageTitle}">
<meta name="twitter:description" content="${SITE_DESCRIPTION}">
<meta name="twitter:image" content="${SOCIAL_CARD_URL}">
<title>${pageTitle}</title>
<style>${CSS}</style>
<script>document.documentElement.classList.add('js')</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
<div class="topbar-left">
<button class="hamburger" type="button" aria-label="Toggle navigation" aria-controls="sidebar" aria-expanded="false"><span></span><span></span><span></span></button>
<a class="brand" href="${home}"><span class="mark" aria-hidden="true">▸</span> Electron Stagewright <span class="tag">docs</span></a>
</div>
<nav class="topnav" aria-label="Project links">
<a href="https://github.com/electron-stagewright/electron-stagewright">GitHub</a>
<a href="https://www.npmjs.com/package/@electron-stagewright/core">npm</a>
</nav>
</header>
<div class="layout">
<nav class="sidebar" id="sidebar" aria-label="Documentation">${navHtml}</nav>
<main class="content" id="content">${bodyHtml}</main>
</div>
<div class="nav-scrim" aria-hidden="true"></div>
<script>
(function () {
  var h = document.querySelector('.hamburger'),
    root = document.documentElement,
    scrim = document.querySelector('.nav-scrim')
  if (!h) return
  function closeNav() {
    root.classList.remove('nav-open')
    h.setAttribute('aria-expanded', 'false')
  }
  h.addEventListener('click', function () {
    var open = root.classList.toggle('nav-open')
    h.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  if (scrim) scrim.addEventListener('click', closeNav)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav()
  })
  document.querySelectorAll('.sidebar a').forEach(function (a) {
    a.addEventListener('click', closeNav)
  })
})()
</script>
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
      page.outputRel,
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
  // The Open Graph / Twitter card image, served at the root and referenced by every page's meta.
  await copyFile(
    path.join(repoRoot, 'docs/assets/social-card.png'),
    path.join(outDir, 'social-card.png'),
  )

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

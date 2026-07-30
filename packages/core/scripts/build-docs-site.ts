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
  'Agentic UX testing for real Electron apps: launch or attach, inspect the accessibility tree, assert behavior, and capture bounded evidence through MCP.'
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
    const active = target === currentOutputRel
    const cls = active ? ' class="active"' : ''
    const current = active ? ' aria-current="page"' : ''
    return `<li><a href="${prefix}${target}"${cls}${current}>${escapeHtml(label)}</a></li>`
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
          { target: 'guides/demo.html', label: 'Try the packaged demo' },
          { target: 'guides/launch-or-attach.html', label: 'Launch, attach, or inject' },
          { target: 'guides/assert-ui-state.html', label: 'Assert UI state' },
          { target: 'guides/type-into-code-editors.html', label: 'Type into code editors' },
          { target: 'guides/capture-diagnostics.html', label: 'Capture diagnostics' },
          { target: 'guides/plugins.html', label: 'Load, configure, and diagnose plugins' },
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
          {
            target: 'guides/choosing-an-electron-mcp-server.html',
            label: 'Choose an Electron MCP server',
          },
          { target: 'guides/compatibility.html', label: 'Compatibility' },
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

/** Self-contained styling: the Cue Frame identity, responsive docs layout, and tuned hljs palette. */
const CSS = `
:root{color-scheme:light dark;
--bg:#f8f5ed;--bg-elev:#fffdf8;--surface:#f1ede3;--surface-2:#e8e1d3;
--fg:#191813;--muted:#666156;--faint:#8f897a;--line:#e4ded1;--line-2:#d5ccbc;
--accent:#a94e08;--accent-strong:#843b06;--accent-soft:#f7e7c9;--signal:#3d6848;
--shadow:0 1px 2px rgba(45,36,22,.05),0 18px 50px -28px rgba(55,39,17,.28);
--hl-comment:#9a9588;--hl-kw:#b03a2e;--hl-str:#3f7a45;--hl-num:#1f6f8b;--hl-fn:#9a5b06;--hl-type:#7a3e9d;
--font-display:"Avenir Next",Avenir,"Segoe UI Variable Display","Segoe UI",sans-serif;
--font-sans:"Avenir Next",Avenir,"Segoe UI Variable Text","Segoe UI",sans-serif;
--font-mono:"SFMono-Regular","SF Mono","Cascadia Code","Roboto Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#12110e;--bg-elev:#191712;--surface:#1e1b15;--surface-2:#28231a;
--fg:#f0ecdf;--muted:#aaa394;--faint:#7f796b;--line:#2c281f;--line-2:#40392b;
--accent:#f0b552;--accent-strong:#ffd081;--accent-soft:rgba(240,181,82,.12);--signal:#8dbb91;
--shadow:0 1px 2px rgba(0,0,0,.35),0 22px 54px -28px rgba(0,0,0,.8);
--hl-comment:#7b776a;--hl-kw:#f0876a;--hl-str:#a6cf8a;--hl-num:#6fc2d8;--hl-fn:#f0b552;--hl-type:#c79be8}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-sans);font-size:16px;line-height:1.72;color:var(--fg);background:
radial-gradient(circle at 82% -10%,color-mix(in srgb,var(--accent) 9%,transparent),transparent 29rem),
linear-gradient(color-mix(in srgb,var(--line) 28%,transparent) 1px,transparent 1px),
linear-gradient(90deg,color-mix(in srgb,var(--line) 22%,transparent) 1px,transparent 1px),
var(--bg);background-size:auto,64px 64px,64px 64px,auto;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body:before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.2;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.08'/%3E%3C/svg%3E")}
::selection{background:var(--accent-soft)}
a{color:var(--accent);text-decoration:none}.skip{position:absolute;left:-9999px;top:0;z-index:20;background:var(--accent);color:#fff;padding:9px 15px;border-radius:0 0 8px 0}
.skip:focus{left:0;top:0}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:18px;height:68px;padding:0 max(22px,calc((100vw - 1380px)/2));border-bottom:1px solid color-mix(in srgb,var(--line) 78%,transparent);background:color-mix(in srgb,var(--bg) 86%,transparent);-webkit-backdrop-filter:saturate(1.3) blur(16px);backdrop-filter:saturate(1.3) blur(16px)}
.topbar:after{content:"";position:absolute;left:0;bottom:-1px;width:clamp(120px,18vw,260px);height:1px;background:var(--accent)}
.topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
.topbar .brand{display:flex;align-items:center;gap:11px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-display);font-weight:620;font-size:15px;letter-spacing:-.015em;color:var(--fg)}
.brand-mark{width:30px;height:30px;flex:0 0 auto;filter:drop-shadow(0 5px 10px color-mix(in srgb,var(--accent) 16%,transparent))}
.brand-mark .frame-secondary{stroke:var(--fg)}
.brand-mark .frame-primary{stroke:var(--accent)}.brand-mark .cue{fill:var(--accent)}
.brand-mark .cue-cutout{fill:var(--bg)}
.hamburger{display:none;flex:0 0 auto;flex-direction:column;justify-content:center;gap:4px;width:40px;height:40px;padding:10px;border:1px solid var(--line-2);border-radius:8px;background:var(--bg-elev);cursor:pointer}
.hamburger span{display:block;height:2px;width:100%;background:var(--fg);border-radius:2px;transition:transform .2s,opacity .2s}
.nav-scrim{display:none}
.topbar .brand .tag{font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:var(--faint);border-left:1px solid var(--line-2);padding-left:11px}
.topnav{display:flex;align-items:center;gap:3px}
.topnav a{font-size:13px;font-weight:520;color:var(--muted);padding:7px 10px;border-radius:7px;transition:background .18s,color .18s,transform .18s}
.topnav a:hover{background:var(--surface-2);color:var(--fg);transform:translateY(-1px)}
.topnav a:active{transform:translateY(0)}
.topnav .topnav-cta{color:var(--bg);background:var(--fg);padding-inline:13px}
.topnav .topnav-cta:hover{color:var(--bg);background:var(--accent)}
.layout{display:flex;align-items:flex-start;max-width:1380px;margin:0 auto}
.sidebar{width:292px;flex:0 0 292px;padding:34px 22px 64px;height:calc(100vh - 68px);position:sticky;top:68px;overflow:auto;border-right:1px solid var(--line);scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}
.sidebar::-webkit-scrollbar{width:9px}.sidebar::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:9px;border:3px solid var(--bg)}
.sidebar h3{font-family:var(--font-mono);font-size:9.5px;font-weight:550;text-transform:uppercase;letter-spacing:.16em;color:var(--faint);margin:25px 8px 8px}
.sidebar ul{list-style:none;margin:0;padding:0}.sidebar li{margin:1px 0}
.sidebar a{display:block;font-size:13.2px;line-height:1.4;color:var(--muted);padding:7px 10px;border-radius:7px;border-left:2px solid transparent;transition:background .16s,color .16s,transform .16s}
.sidebar a:hover{background:var(--surface-2);color:var(--fg);transform:translateX(2px)}
.sidebar a.active{background:var(--accent-soft);color:var(--accent-strong);font-weight:600;border-left-color:var(--accent)}
.content{flex:1 1 auto;min-width:0;max-width:880px;padding:58px 64px 112px;animation:rise .55s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.content>*:first-child{margin-top:0}
.content h1{font-family:var(--font-display);font-size:2.45rem;line-height:1.08;letter-spacing:-.04em;font-weight:650;margin:.15em 0 .6em;text-wrap:balance}
.content h2{font-family:var(--font-display);font-size:1.48rem;line-height:1.22;letter-spacing:-.025em;font-weight:640;margin:2.6em 0 .75em;padding-top:1.45em;border-top:1px solid var(--line);text-wrap:balance}
.content h3{font-family:var(--font-display);font-size:1.17rem;line-height:1.3;letter-spacing:-.012em;font-weight:650;margin:2em 0 .55em}
.content h1,.content h2,.content h3{scroll-margin-top:74px}
.content p,.content li{max-width:72ch;text-wrap:pretty}
.content a{text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 35%,transparent);text-underline-offset:2px;text-decoration-thickness:1px;transition:text-decoration-color .15s}
.content a:hover{text-decoration-color:var(--accent)}
.content strong{font-weight:650}
.content code{font-family:var(--font-mono);font-size:.86em;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:.1em .36em}
.content pre{font-family:var(--font-mono);background:var(--bg-elev);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px 12px 12px 4px;padding:18px 20px;margin:1.45em 0;overflow:auto;box-shadow:var(--shadow);line-height:1.65}
.content pre code{background:none;border:0;padding:0;font-size:.85em}
.content pre::-webkit-scrollbar{height:9px}.content pre::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:9px}
.content blockquote{margin:1.5em 0;padding:.55em 0 .55em 1.2em;border-left:3px solid var(--accent);color:var(--muted)}
.content blockquote p{margin:.4em 0}
.content table{border-collapse:collapse;display:block;overflow:auto;margin:1.3em 0;font-size:.93em}
.content thead th{font-family:var(--font-mono);font-size:.8em;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:left;font-weight:500;border-bottom:1px solid var(--line-2);padding:8px 14px}
.content tbody td{border-bottom:1px solid var(--line);padding:9px 14px;vertical-align:top}
.content tbody tr:hover{background:var(--surface)}
.content hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
.page-home .layout{max-width:1380px}.page-home .content{max-width:1088px;padding-top:0}
.home-hero{position:relative;margin:0 -20px 54px;padding:72px 20px 0;overflow:hidden}
.home-hero:before{content:"";position:absolute;right:-180px;top:-160px;width:520px;height:520px;border:1px solid color-mix(in srgb,var(--accent) 12%,transparent);border-radius:50%;box-shadow:0 0 0 72px color-mix(in srgb,var(--accent) 3%,transparent),0 0 0 144px color-mix(in srgb,var(--accent) 2%,transparent)}
.hero-kicker{position:relative;display:flex;align-items:center;gap:11px;margin-bottom:24px;font-family:var(--font-mono);font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
.hero-kicker:before{content:"";width:34px;height:1px;background:var(--accent)}
.hero-kicker .status-dot{width:6px;height:6px;margin-left:4px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 4px color-mix(in srgb,var(--signal) 14%,transparent)}
.hero-grid{position:relative;display:grid;grid-template-columns:minmax(0,1.12fr) minmax(310px,.88fr);gap:clamp(48px,7vw,90px);align-items:center}
.hero-copy h1{font-family:var(--font-display);font-size:clamp(3.7rem,6.3vw,5.7rem);font-weight:640;line-height:.96;letter-spacing:-.064em;margin:0;color:var(--fg);text-wrap:balance}
.hero-copy h1 span{display:block;color:var(--accent);font-style:normal}
.hero-deck{max-width:610px;margin:28px 0 0;font-size:1.12rem;line-height:1.65;color:var(--muted);text-wrap:pretty}
.hero-actions{display:flex;align-items:center;gap:14px;margin-top:32px;flex-wrap:wrap}
.hero-actions a{text-decoration:none}
.button-primary,.button-secondary{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 17px;border-radius:7px;font-size:13px;font-weight:620;transition:transform .18s,background .18s,color .18s,border-color .18s}
.button-primary{color:var(--bg)!important;background:var(--fg);border:1px solid var(--fg)}
.button-primary:hover{background:var(--accent);border-color:var(--accent);transform:translateY(-2px)}
.button-secondary{color:var(--fg)!important;border:1px solid var(--line-2);background:color-mix(in srgb,var(--bg-elev) 62%,transparent)}
.button-secondary:hover{border-color:var(--accent);color:var(--accent)!important;transform:translateY(-2px)}
.button-primary:active,.button-secondary:active{transform:translateY(0)}
.install-line{display:flex;align-items:center;gap:10px;width:max-content;max-width:100%;margin-top:24px;padding:10px 13px;border:1px solid var(--line);border-radius:7px;background:color-mix(in srgb,var(--bg-elev) 75%,transparent);font-family:var(--font-mono);font-size:11.5px;color:var(--muted);box-shadow:var(--shadow)}
.install-line .prompt{color:var(--accent);font-weight:700}.install-line code{padding:0;border:0;background:none;color:var(--fg);overflow-wrap:anywhere}
.session-card{position:relative;min-height:410px;border:1px solid var(--line-2);border-radius:18px 4px 18px 4px;background:color-mix(in srgb,var(--bg-elev) 88%,transparent);box-shadow:var(--shadow);overflow:hidden;transform:rotate(.5deg)}
.session-card:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,color-mix(in srgb,var(--accent) 7%,transparent),transparent 36%);pointer-events:none}
.session-head{position:relative;display:flex;align-items:center;justify-content:space-between;padding:14px 17px;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.session-head span:last-child{color:var(--signal)}
.session-body{position:relative;padding:10px 18px 4px}
.session-row{display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:10px;min-height:61px;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:11px}
.session-row .step{color:var(--faint)}.session-row .tool{color:var(--fg)}.session-row .result{color:var(--muted);text-align:right}
.session-row.is-proof .result{color:var(--signal)}.session-row.is-proof .tool{color:var(--accent)}
.session-foot{position:relative;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:17px 18px;font-family:var(--font-mono);font-size:9.5px;color:var(--faint)}
.session-foot strong{font-weight:600;color:var(--fg)}.session-cue{display:flex;align-items:center;gap:8px}
.mini-mark{width:20px;height:20px}
.proof-rail{display:grid;grid-template-columns:repeat(3,1fr);margin-top:62px;border-top:1px solid var(--line-2);border-bottom:1px solid var(--line-2)}
.proof-item{padding:22px 22px 25px 0}.proof-item+.proof-item{padding-left:22px;border-left:1px solid var(--line)}
.proof-item .label{display:block;margin-bottom:7px;font-family:var(--font-mono);font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent)}
.proof-item strong{display:block;font-size:14px;font-weight:620;color:var(--fg)}
.proof-item p{margin:5px 0 0;font-size:12.5px;line-height:1.55;color:var(--muted)}
.home-overview{margin-top:0}.home-overview:before{content:"Project rationale";display:block;margin-bottom:30px;font-family:var(--font-mono);font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--faint)}
.site-footer{border-top:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,transparent)}
.site-footer-inner{display:flex;align-items:center;justify-content:space-between;gap:24px;max-width:1380px;margin:0 auto;padding:26px max(22px,calc((100vw - 1380px)/2));font-family:var(--font-mono);font-size:10.5px;color:var(--faint)}
.site-footer nav{display:flex;gap:18px}.site-footer a{color:var(--muted)}.site-footer a:hover{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
@media (max-width:1040px){
.content{padding-inline:42px}.page-home .content{padding-inline:38px}
.hero-grid{grid-template-columns:1fr;gap:44px}.session-card{max-width:620px;min-height:auto;transform:none}
}
@media (max-width:860px){
.topbar{height:60px;padding:0 14px;gap:10px}
.topbar .brand{font-size:14px}
.topbar .brand .tag{display:none}
.brand-mark{width:27px;height:27px}
.topnav a:not(.topnav-cta){display:none}.topnav a{padding:7px 10px;font-size:12.5px}
.js .hamburger{display:flex}
.layout{flex-direction:column;align-items:stretch;max-width:none}
.content,.page-home .content{padding:34px 20px 78px;max-width:none;width:100%}
.content h1{font-size:2rem}
.content pre,.content table{font-size:.84em}
.content code{overflow-wrap:anywhere}
.sidebar{width:100%;flex-basis:auto;height:auto;position:static;border-right:0;border-bottom:1px solid var(--line)}
.js .sidebar{position:fixed;top:60px;left:0;bottom:0;width:min(86vw,340px);transform:translateX(-100%);transition:transform .24s ease;z-index:11;background:var(--surface);border:0;border-right:1px solid var(--line);box-shadow:var(--shadow);overflow:auto;padding:20px 14px 40px}
.nav-open .sidebar{transform:none}
.js .nav-scrim{display:block;position:fixed;inset:60px 0 0 0;z-index:9;background:rgba(0,0,0,.48);opacity:0;pointer-events:none;transition:opacity .2s}
.nav-open .nav-scrim{opacity:1;pointer-events:auto}
.nav-open .hamburger span:nth-child(1){transform:translateY(6px) rotate(45deg)}
.nav-open .hamburger span:nth-child(2){opacity:0}
.nav-open .hamburger span:nth-child(3){transform:translateY(-6px) rotate(-45deg)}
.home-hero{margin:0;padding:50px 0 0}.hero-copy h1{font-size:clamp(3.35rem,14vw,4.5rem)}
.hero-deck{font-size:1.04rem}.proof-rail{grid-template-columns:1fr}.proof-item,.proof-item+.proof-item{padding:18px 0;border-left:0}.proof-item+.proof-item{border-top:1px solid var(--line)}
.site-footer-inner{align-items:flex-start;flex-direction:column;padding:24px 20px}.site-footer nav{flex-wrap:wrap}
}
@media (max-width:480px){
.topbar .brand{font-size:13px}.topnav .topnav-cta{display:none}
.hero-copy h1{font-size:3.05rem}.hero-actions{align-items:stretch;flex-direction:column}.hero-actions a{width:100%}
.install-line{width:100%;font-size:10.5px}.session-card{border-radius:14px 3px}.session-row{grid-template-columns:24px 1fr;min-height:68px}.session-row .result{grid-column:2;text-align:left;margin-top:-15px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.hljs-comment,.hljs-quote{color:var(--hl-comment);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-literal{color:var(--hl-kw)}
.hljs-string,.hljs-attr,.hljs-template-tag,.hljs-addition{color:var(--hl-str)}
.hljs-number,.hljs-meta{color:var(--hl-num)}
.hljs-title,.hljs-section,.hljs-function .hljs-title,.hljs-name{color:var(--hl-fn)}
.hljs-type,.hljs-class .hljs-title{color:var(--hl-type)}
`.trim()

/** The compact Cue Frame mark used in the top bar and homepage session panel. */
function renderBrandMark(className = 'brand-mark'): string {
  return `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true">
<path class="frame-primary" d="M8 27V10a2 2 0 0 1 2-2h17" fill="none" stroke-width="6"/>
<path class="frame-secondary" d="M37 8h17a2 2 0 0 1 2 2v17" fill="none" stroke-width="6"/>
<path class="frame-primary" d="M56 37v17a2 2 0 0 1-2 2H37" fill="none" stroke-width="6"/>
<path class="frame-secondary" d="M27 56H10a2 2 0 0 1-2-2V37" fill="none" stroke-width="6"/>
<path class="cue" d="m32 23 9 9-9 9-9-9 9-9Z" stroke="none"/>
<rect class="cue-cutout" x="29" y="29" width="6" height="6"/>
</svg>`
}

/** Homepage-only product introduction; the rest of the page remains generated from README.md. */
function renderHomePage(bodyHtml: string): string {
  const rationaleStart = bodyHtml.indexOf('<h2 id="why-this-exists">')
  const overview = rationaleStart === -1 ? bodyHtml : bodyHtml.slice(rationaleStart)
  return `<section class="home-hero" aria-labelledby="hero-title">
<div class="hero-kicker"><span>Agentic UX testing for Electron</span><span class="status-dot" aria-hidden="true"></span><span>v0.5.0</span></div>
<div class="hero-grid">
<div class="hero-copy">
<h1 id="hero-title">Cue the app.<span>Prove the experience.</span></h1>
<p class="hero-deck">Launch or attach to real Electron apps, inspect what users can reach, assert behavior, and return bounded evidence to the agent that asked.</p>
<div class="hero-actions">
<a class="button-primary" href="guides/demo.html">Run the packaged demo</a>
<a class="button-secondary" href="guides/getting-started.html">Read the getting-started guide</a>
</div>
<div class="install-line" aria-label="Install the core package"><span class="prompt" aria-hidden="true">$</span><code>pnpm add -D @electron-stagewright/core</code></div>
</div>
<div class="session-card" aria-label="Example Electron Stagewright session">
<div class="session-head"><span>Session / desktop-app</span><span>connected</span></div>
<div class="session-body">
<div class="session-row"><span class="step">01</span><span class="tool">electron_launch</span><span class="result">ready</span></div>
<div class="session-row"><span class="step">02</span><span class="tool">electron_snapshot</span><span class="result">43 refs</span></div>
<div class="session-row"><span class="step">03</span><span class="tool">electron_expect_text</span><span class="result">matched</span></div>
<div class="session-row is-proof"><span class="step">04</span><span class="tool">electron_trace_stop</span><span class="result">evidence saved</span></div>
</div>
<div class="session-foot"><span class="session-cue">${renderBrandMark('brand-mark mini-mark')}<strong>Agent-native from the primitive up.</strong></span><span>4 calls</span></div>
</div>
</div>
<div class="proof-rail" aria-label="Core product qualities">
<div class="proof-item"><span class="label">Control</span><strong>Launch, attach, or inject</strong><p>Reach development builds and running desktop applications.</p></div>
<div class="proof-item"><span class="label">Context</span><strong>Accessibility-first inspection</strong><p>Give agents stable refs and compact state instead of raw pixels.</p></div>
<div class="proof-item"><span class="label">Proof</span><strong>Assertions, traces, and diagnostics</strong><p>Return replayable evidence instead of optimistic automation.</p></div>
</div>
</section>
<div class="home-overview">${overview}</div>`
}

function renderTemplate(
  title: string,
  bodyHtml: string,
  navHtml: string,
  outputRel: string,
): string {
  const prefix = relativePrefix(outputRel)
  const home = `${prefix}index.html`
  const gettingStarted = `${prefix}guides/getting-started.html`
  const canonical = `${SITE_BASE_URL}${outputRel === 'index.html' ? '' : outputRel}`
  const pageTitle = `${escapeHtml(title)} — Electron Stagewright docs`
  const isHome = outputRel === 'index.html'
  const renderedBody = isHome ? renderHomePage(bodyHtml) : bodyHtml
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f8f5ed">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#12110e">
<meta name="description" content="${SITE_DESCRIPTION}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
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
<body${isHome ? ' class="page-home"' : ''}>
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
<div class="topbar-left">
<button class="hamburger" type="button" aria-label="Toggle navigation" aria-controls="sidebar" aria-expanded="false"><span></span><span></span><span></span></button>
<a class="brand" href="${home}">${renderBrandMark()}<span>Electron Stagewright</span><span class="tag">docs</span></a>
</div>
<nav class="topnav" aria-label="Project links">
<a href="${gettingStarted}">Get started</a>
<a href="https://github.com/electron-stagewright/electron-stagewright">GitHub</a>
<a class="topnav-cta" href="https://www.npmjs.com/package/@electron-stagewright/core">View on npm</a>
</nav>
</header>
<div class="layout">
<nav class="sidebar" id="sidebar" aria-label="Documentation">${navHtml}</nav>
<main class="content" id="content">${renderedBody}</main>
</div>
<div class="nav-scrim" aria-hidden="true"></div>
<footer class="site-footer">
<div class="site-footer-inner">
<span>Electron Stagewright · Independent open-source tooling</span>
<nav aria-label="Footer links">
<a href="https://github.com/electron-stagewright/electron-stagewright/blob/main/LICENSE">MIT license</a>
<a href="${prefix}security.html">Security</a>
<a href="${prefix}governance.html">Governance</a>
</nav>
</div>
</footer>
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
  await copyFile(
    path.join(repoRoot, 'docs/assets/brand-mark.svg'),
    path.join(outDir, 'brand-mark.svg'),
  )
  await copyFile(path.join(repoRoot, 'docs/assets/favicon.svg'), path.join(outDir, 'favicon.svg'))

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

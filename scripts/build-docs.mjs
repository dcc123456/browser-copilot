#!/usr/bin/env node
/**
 * Render docs/workflow/*.md into website/docs/*.html.
 *
 * The docs sources are the single source of truth. Generator output is
 * committed so the existing Pages workflow (upload website/ verbatim) needs no
 * build step. `--check` re-renders in memory and fails when committed output
 * has drifted.
 *
 * @module scripts/build-docs
 */

import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import * as prettier from 'prettier'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = path.join(ROOT, 'docs', 'workflow')
const OUTPUT_DIR = path.join(ROOT, 'website', 'docs')
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'docs-manifest.json'), 'utf8'))
const PAGES = MANIFEST.pages
const STATUSES = MANIFEST.statuses
const LANGS = ['en', 'zh']
const MARKER_RE = /^<!--\s*operator:([a-z0-9-]+)(?:\s+status:([a-z0-9-]+))?\s*-->\s*$/gm
const CHECK = process.argv.includes('--check')

const UI = {
  en: {
    docs: 'Docs',
    features: 'Features',
    howItWorks: 'How it works',
    github: 'GitHub',
    switchTo: '中文',
    onThisPage: 'On this page',
    menu: 'Documentation menu',
    previous: 'Previous',
    next: 'Next',
    editOnGithub: 'Edit this page on GitHub',
    generated: 'Generated from docs/workflow',
    start: 'Start',
    operators: 'Operators',
    license: 'PolyForm Noncommercial 1.0.0',
  },
  zh: {
    docs: '文档',
    features: '功能',
    howItWorks: '工作原理',
    github: 'GitHub',
    switchTo: 'EN',
    onThisPage: '本页目录',
    menu: '文档菜单',
    previous: '上一页',
    next: '下一页',
    editOnGithub: '在 GitHub 上编辑此页',
    generated: '由 docs/workflow 生成',
    start: '开始',
    operators: '算子',
    license: 'PolyForm 非商业许可 1.0.0',
  },
}

function outputName(page, lang) {
  return `${page.slug}${lang === 'zh' ? '-zh' : ''}.html`
}

function otherLang(lang) {
  return lang === 'en' ? 'zh' : 'en'
}

function readSource(page, lang) {
  const file = path.join(SOURCE_DIR, page.source[lang])
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new Error(`Missing docs source: ${path.relative(ROOT, file)}`)
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stripHtml(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function slugify(value) {
  return stripHtml(value)
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function makeSlugger() {
  const seen = new Map()
  return (value) => {
    const base = slugify(value) || 'section'
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count + 1}`
  }
}

function extractHeading(markdown) {
  const match = /^##\s+(.+)$/m.exec(markdown)
  if (!match) throw new Error('Operator section is missing its H2 heading')
  return match[1].trim()
}

function summarize(markdown) {
  const afterHeading = markdown.replace(/^##\s+.*$/m, '').trim()
  const paragraph =
    afterHeading
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !/^[|#<\-*>`]/.test(part)) ?? ''
  let text = paragraph
    .replace(/\[Automa(?: reference| 参考)\]\([^)]*\)/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > 180) text = `${text.slice(0, 177).trimEnd()}…`
  return text
}

function splitSections(markdown, sourceName) {
  const matches = [...markdown.matchAll(MARKER_RE)]
  const intro = markdown.slice(0, matches[0]?.index ?? markdown.length)
  if (/^##\s/m.test(intro)) {
    throw new Error(`${sourceName}: category intro must not contain an H2`)
  }
  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end =
      index + 1 < matches.length ? (matches[index + 1].index ?? markdown.length) : markdown.length
    const body = markdown.slice(start, end)
    const h2Count = [...body.matchAll(/^##\s/gm)].length
    if (h2Count !== 1 || !/^\s*##\s/.test(body)) {
      throw new Error(`${sourceName}: operator ${match[1]} must contain exactly one H2`)
    }
    const status = match[2] ?? null
    if (status && !STATUSES[status]) {
      throw new Error(`${sourceName}: operator ${match[1]} has unknown status ${status}`)
    }
    return { id: match[1], status, body }
  })
  const ids = sections.map((section) => section.id)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length) {
    throw new Error(
      `${sourceName}: duplicate operator markers: ${[...new Set(duplicates)].join(', ')}`,
    )
  }
  return { intro, sections }
}

function rewriteHref(href, lang) {
  if (/^(https?:|mailto:|tel:|#)/.test(href)) return href
  const hashIndex = href.indexOf('#')
  const file = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)
  if (!file.endsWith('.md')) return href
  const isZhSource = file.endsWith('.zh-CN.md')
  const base = file.replace(/\.zh-CN\.md$/, '').replace(/\.md$/, '')
  const targetLang = isZhSource ? 'zh' : lang
  const slug = base === 'README' ? 'index' : base
  return `${slug}${targetLang === 'zh' ? '-zh' : ''}.html${hash}`
}

function rewriteLinks(markdown, lang) {
  return markdown.replace(
    /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (_full, href, title) => `](${rewriteHref(href, lang)}${title ?? ''})`,
  )
}

function decorateHeadings(html, slugger, toc) {
  return html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (full, depth, attrs, inner) => {
    if (/\sid="/.test(attrs)) return full
    const text = stripHtml(inner).trim()
    const id = slugger(text)
    toc.push({ depth: Number(depth), text, id })
    return `<h${depth}${attrs} id="${id}">${inner}</h${depth}>`
  })
}

function wrapTables(html) {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (table) => {
    const isSettings = /<th>Field<\/th>|<th>字段<\/th>/.test(table)
    return `<div class="table-wrap${isSettings ? ' table-settings' : ''}">${table}</div>`
  })
}

function statusBadge(status, lang) {
  if (!status) return ''
  const meta = STATUSES[status]
  const tone =
    meta.tone === 'danger'
      ? 'border-err/40 bg-err/10 text-err'
      : 'border-border bg-panel-2 text-muted'
  return `<span class="ml-3 inline-flex translate-y-[-2px] items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}">${escapeHtml(meta[lang])}</span>`
}

function statusCell(status, lang) {
  if (!status) return ''
  const meta = STATUSES[status]
  const tone =
    meta.tone === 'danger'
      ? 'border-err/40 bg-err/10 text-err'
      : 'border-border bg-panel-2 text-muted'
  return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}">${escapeHtml(meta[lang])}</span>`
}

function categoryPages() {
  return PAGES.filter((page) => page.category)
}

function buildOperatorIndex(lang) {
  const suffix = lang === 'zh' ? '-zh' : ''
  const headers =
    lang === 'zh'
      ? '<tr><th>算子</th><th>用途</th><th>状态</th></tr>'
      : '<tr><th>Operator</th><th>What it does</th><th>Status</th></tr>'
  const rows = []
  for (const page of categoryPages()) {
    const source = readSource(page, lang)
    const { sections } = splitSections(source, page.source[lang])
    rows.push(
      `<tr class="docs-group-row"><td colspan="3"><strong>${escapeHtml(page.nav[lang])}</strong></td></tr>`,
    )
    for (const section of sections) {
      const href = `${page.slug}${suffix}.html#operator-${section.id}`
      rows.push(
        `<tr><td><a href="${href}">${escapeHtml(extractHeading(section.body))}</a></td><td>${escapeHtml(summarize(section.body))}</td><td>${statusCell(section.status, lang)}</td></tr>`,
      )
    }
  }
  return `<table><thead>${headers}</thead><tbody>${rows.join('')}</tbody></table>`
}

function renderOperatorSection(section, lang, slugger, toc) {
  const headingText = extractHeading(section.body)
  let html = marked.parse(rewriteLinks(section.body, lang), { gfm: true })
  let replaced = false
  html = html.replace(/<h2>([\s\S]*?)<\/h2>/, (_full, inner) => {
    replaced = true
    toc.push({ depth: 2, text: headingText, id: `operator-${section.id}` })
    return `<h2 id="operator-${section.id}">${inner}${statusBadge(section.status, lang)}</h2>`
  })
  if (!replaced) throw new Error(`Operator ${section.id} did not render an H2 heading`)
  html = decorateHeadings(html, slugger, toc)
  return `<section data-operator="${section.id}">${html}</section>`
}

function renderContent(page, lang) {
  const source = readSource(page, lang)
  const toc = []
  const slugger = makeSlugger()
  if (page.category) {
    const { intro, sections } = splitSections(source, page.source[lang])
    let html = marked.parse(rewriteLinks(intro, lang), { gfm: true })
    html = decorateHeadings(html, slugger, toc)
    for (const section of sections) {
      html += renderOperatorSection(section, lang, slugger, toc)
    }
    return { article: wrapTables(html), toc }
  }
  let markdown = source
  if (page.slug === 'index') {
    const placeholders = (markdown.match(/<!-- operator-index -->/g) ?? []).length
    if (placeholders !== 1) {
      throw new Error(
        `${page.source[lang]}: expected exactly one <!-- operator-index --> placeholder`,
      )
    }
    markdown = markdown.replace('<!-- operator-index -->', `\n\n${buildOperatorIndex(lang)}\n\n`)
  }
  let html = marked.parse(rewriteLinks(markdown, lang), { gfm: true })
  html = decorateHeadings(html, slugger, toc)
  return { article: wrapTables(html), toc }
}

function sidebarHtml(page, lang) {
  const groups = [
    { key: 'start', label: UI[lang].start },
    { key: 'operators', label: UI[lang].operators },
  ]
  return groups
    .map((group) => {
      const links = PAGES.filter((entry) => entry.group === group.key)
        .map((entry) => {
          const active = entry.slug === page.slug
          const classes = active ? 'bg-panel text-ink' : 'text-muted hover:bg-panel hover:text-ink'
          const current = active ? ' aria-current="page"' : ''
          return `<a href="${outputName(entry, lang)}" class="block rounded-lg px-3 py-2 text-sm transition-colors ${classes}"${current}>${escapeHtml(entry.nav[lang])}</a>`
        })
        .join('')
      return `<div><p class="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-faint">${escapeHtml(group.label)}</p><nav class="space-y-1">${links}</nav></div>`
    })
    .join('')
}

function tocEntries(toc, page) {
  return page.category ? toc.filter((entry) => entry.depth === 2) : toc
}

function tocLinks(toc, page) {
  return tocEntries(toc, page)
    .map((entry) => {
      const indent = entry.depth === 3 ? 'pl-3 text-xs' : 'text-sm'
      return `<a href="#${entry.id}" class="block py-1 ${indent} text-muted transition-colors hover:text-ink">${escapeHtml(entry.text)}</a>`
    })
    .join('')
}

function tocHtml(toc, lang, page) {
  if (!tocEntries(toc, page).length) return ''
  return `<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">${escapeHtml(UI[lang].onThisPage)}</p><nav class="max-h-[calc(100vh-8rem)] space-y-1 overflow-y-auto pr-2">${tocLinks(toc, page)}</nav>`
}

function pagerHtml(page, lang) {
  const index = PAGES.indexOf(page)
  const previous = PAGES[index - 1]
  const next = PAGES[index + 1]
  const previousHtml = previous
    ? `<a href="${outputName(previous, lang)}" class="group flex flex-col gap-1 rounded-xl border border-border bg-panel p-4 transition-colors hover:border-accent"><span class="text-xs text-faint">← ${escapeHtml(UI[lang].previous)}</span><span class="text-sm text-ink">${escapeHtml(previous.nav[lang])}</span></a>`
    : '<span></span>'
  const nextHtml = next
    ? `<a href="${outputName(next, lang)}" class="group flex flex-col items-end gap-1 rounded-xl border border-border bg-panel p-4 text-right transition-colors hover:border-accent"><span class="text-xs text-faint">${escapeHtml(UI[lang].next)} →</span><span class="text-sm text-ink">${escapeHtml(next.nav[lang])}</span></a>`
    : '<span></span>'
  return `${previousHtml}${nextHtml}`
}

function pageHead(page, lang) {
  const title = `${page.title[lang]} — Browser Copilot Docs`
  const description = escapeHtml(page.description[lang])
  const canonical = `${MANIFEST.siteUrl}/docs/${outputName(page, lang)}`
  const enHref = `${MANIFEST.siteUrl}/docs/${page.slug}.html`
  const zhHref = `${MANIFEST.siteUrl}/docs/${page.slug}-zh.html`
  const image = `${MANIFEST.siteUrl}/og-image.svg`
  return `<meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" hreflang="en" href="${enHref}" />
    <link rel="alternate" hreflang="zh-CN" href="${zhHref}" />
    <link rel="alternate" hreflang="x-default" href="${enHref}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${image}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />
    <link rel="icon" type="image/png" sizes="32x32" href="../icons/icon-32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="../icons/icon-16.png" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              bg: '#0f1115',
              panel: '#161a21',
              'panel-2': '#1e232c',
              border: '#2a303c',
              ink: '#e9ecf2',
              muted: '#9aa4b5',
              faint: '#687183',
              accent: '#6ea3ff',
              'accent-strong': '#8bb6ff',
              ok: '#43c9a3',
              err: '#ff6f6f',
            },
            fontFamily: {
              sans: [
                'ui-sans-serif',
                'system-ui',
                '-apple-system',
                "'Segoe UI'",
                'Roboto',
                "'PingFang SC'",
                "'Hiragino Sans GB'",
                "'Microsoft YaHei'",
                'sans-serif',
              ],
            },
          },
        },
      }
    </script>
    <style>
      html {
        scroll-behavior: smooth;
      }
      .docs-prose {
        overflow-wrap: anywhere;
        line-height: 1.75;
      }
      .docs-prose h1 {
        margin: 0 0 1rem;
        font-size: clamp(2rem, 5vw, 2.75rem);
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .docs-prose h2 {
        margin: 2.5rem 0 1rem;
        border-top: 1px solid #2a303c;
        padding-top: 1.5rem;
        font-size: 1.5rem;
        font-weight: 700;
        line-height: 1.3;
      }
      .docs-prose h2[id^='operator-'] {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }
      .docs-prose h3 {
        margin: 1.75rem 0 0.75rem;
        font-size: 1.1rem;
        font-weight: 600;
      }
      .docs-prose p,
      .docs-prose li {
        color: #9aa4b5;
      }
      .docs-prose p {
        margin: 1rem 0;
      }
      .docs-prose strong {
        color: #e9ecf2;
      }
      .docs-prose a {
        color: #6ea3ff;
        text-decoration: none;
      }
      .docs-prose a:hover {
        text-decoration: underline;
      }
      .docs-prose ul,
      .docs-prose ol {
        margin: 1rem 0;
        padding-left: 1.5rem;
      }
      .docs-prose ul {
        list-style: disc;
      }
      .docs-prose ol {
        list-style: decimal;
      }
      .docs-prose li {
        margin: 0.35rem 0;
      }
      .docs-prose code {
        border-radius: 0.35rem;
        background: #1e232c;
        padding: 0.15rem 0.4rem;
        color: #8bb6ff;
        font-size: 0.85em;
      }
      .docs-prose pre {
        margin: 1.25rem 0;
        overflow-x: auto;
        border: 1px solid #2a303c;
        border-radius: 0.75rem;
        background: #161a21;
        padding: 1rem;
      }
      .docs-prose pre code {
        background: transparent;
        padding: 0;
        color: #e9ecf2;
      }
      .docs-prose blockquote {
        margin: 1.25rem 0;
        border-left: 3px solid #2a303c;
        padding-left: 1rem;
        color: #9aa4b5;
      }
      .docs-prose hr {
        margin: 2rem 0;
        border-color: #2a303c;
      }
      .docs-prose .table-wrap {
        margin: 1.25rem 0;
        overflow-x: auto;
      }
      .docs-prose .table-settings th:nth-child(2),
      .docs-prose .table-settings td:nth-child(2),
      .docs-prose .table-settings th:nth-child(3),
      .docs-prose .table-settings td:nth-child(3) {
        white-space: nowrap;
      }
      .docs-prose table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }
      .docs-prose th,
      .docs-prose td {
        border: 1px solid #2a303c;
        padding: 0.5rem 0.75rem;
        text-align: left;
        vertical-align: top;
      }
      .docs-prose th {
        background: #1e232c;
        color: #e9ecf2;
        font-weight: 600;
      }
      .docs-prose td {
        color: #9aa4b5;
      }
      .docs-prose .docs-group-row td {
        background: #161a21;
        color: #e9ecf2;
      }
      .docs-prose h1,
      .docs-prose h2,
      .docs-prose h3,
      .docs-prose [id] {
        scroll-margin-top: 6rem;
      }
      .docs-prose section[data-operator]:first-of-type h2 {
        margin-top: 2rem;
      }
    </style>`
}

function renderShell(page, lang, content) {
  const ui = UI[lang]
  const suffix = lang === 'zh' ? '-zh' : ''
  const landing = `../index${suffix}.html`
  const other = otherLang(lang)
  const toc = tocHtml(content.toc, lang, page)
  const mobileToc = tocEntries(content.toc, page).length
    ? `<details class="mt-4 rounded-xl border border-border bg-panel p-4 xl:hidden"><summary class="cursor-pointer text-sm font-medium text-ink">${escapeHtml(ui.onThisPage)}</summary><nav class="mt-3 space-y-1">${tocLinks(content.toc, page)}</nav></details>`
    : ''
  const breadcrumb =
    page.slug === 'index'
      ? `<span class="text-muted">${escapeHtml(ui.docs)}</span>`
      : `<a href="${outputName(PAGES[0], lang)}" class="transition-colors hover:text-ink">${escapeHtml(ui.docs)}</a><span>/</span><span class="text-muted">${escapeHtml(page.nav[lang])}</span>`
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
  <head>
    ${pageHead(page, lang)}
  </head>
  <body class="bg-bg text-ink font-sans antialiased">
    <nav class="fixed top-0 left-0 right-0 z-50 border-b border-border bg-bg/80 backdrop-blur-md">
      <div class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <a href="${landing}" class="flex shrink-0 items-center gap-3">
          <img src="../icons/icon-32.png" alt="" class="h-8 w-8 shrink-0" />
          <span class="whitespace-nowrap text-base font-semibold text-ink sm:text-lg">Browser Copilot</span>
        </a>
        <div class="flex items-center gap-3 sm:gap-5 md:gap-6">
          <a href="${outputName(PAGES[0], lang)}" class="text-sm text-ink">${escapeHtml(ui.docs)}</a>
          <a href="${landing}#features" class="hidden text-sm text-muted transition-colors hover:text-ink md:inline">${escapeHtml(ui.features)}</a>
          <a href="${landing}#how-it-works" class="hidden text-sm text-muted transition-colors hover:text-ink md:inline">${escapeHtml(ui.howItWorks)}</a>
          <a href="${outputName(page, other)}" class="text-sm text-muted transition-colors hover:text-ink">${escapeHtml(ui.switchTo)}</a>
          <a href="https://github.com/dcc123456/browser-copilot" target="_blank" rel="noopener noreferrer" class="hidden rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-ink sm:inline-flex">${escapeHtml(ui.github)}</a>
        </div>
      </div>
    </nav>
    <div class="mx-auto grid max-w-7xl gap-10 px-6 pb-16 pt-24 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_220px]">
      <aside class="hidden lg:block">
        <div class="sticky top-24 space-y-6">${sidebarHtml(page, lang)}</div>
      </aside>
      <main class="min-w-0">
        <details class="mb-6 rounded-xl border border-border bg-panel p-4 lg:hidden">
          <summary class="cursor-pointer text-sm font-medium text-ink">${escapeHtml(ui.menu)}</summary>
          <div class="mt-4 space-y-4">${sidebarHtml(page, lang)}</div>
        </details>
        <div class="mb-6 flex items-center gap-2 text-xs text-faint">${breadcrumb}</div>
        <article class="docs-prose">${content.article}</article>
        ${mobileToc}
        <div class="mt-12 border-t border-border pt-6 text-sm text-muted">
          <a href="${MANIFEST.repoBlob}/${page.source[lang]}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${escapeHtml(ui.editOnGithub)}</a>
          <span class="mx-2 text-faint">·</span>
          <span>${escapeHtml(ui.generated)}</span>
        </div>
        <div class="mt-8 grid gap-4 sm:grid-cols-2">${pagerHtml(page, lang)}</div>
      </main>
      <aside class="hidden xl:block">
        <div class="sticky top-24">${toc}</div>
      </aside>
    </div>
    <footer class="border-t border-border py-10">
      <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 md:flex-row">
        <div class="flex items-center gap-3">
          <img src="../icons/icon-16.png" alt="" class="h-5 w-5" />
          <span class="text-sm text-muted">Browser Copilot</span>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-6 text-sm text-muted">
          <a href="${outputName(PAGES[0], lang)}" class="transition-colors hover:text-ink">${escapeHtml(ui.docs)}</a>
          <a href="https://github.com/dcc123456/browser-copilot" target="_blank" rel="noopener noreferrer" class="transition-colors hover:text-ink">${escapeHtml(ui.github)}</a>
          <a href="https://github.com/dcc123456/browser-copilot/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="transition-colors hover:text-ink">License</a>
          <span class="text-faint">${escapeHtml(ui.license)}</span>
        </div>
      </div>
    </footer>
  </body>
</html>`
}

async function formatHtml(html, outName) {
  const outPath = path.join(OUTPUT_DIR, outName)
  const config = (await prettier.resolveConfig(outPath)) ?? {}
  return prettier.format(html, { ...config, parser: 'html' })
}

async function listGeneratedHtml() {
  try {
    return (await fs.readdir(OUTPUT_DIR)).filter((name) => name.endsWith('.html'))
  } catch {
    return []
  }
}

function validateOutputLinks(outputs) {
  const errors = []
  const idsOf = (name) => {
    const ids = new Set()
    for (const match of outputs.get(name)?.matchAll(/\sid="([^"]+)"/g) ?? []) {
      ids.add(match[1])
    }
    return ids
  }
  const cache = new Map()
  const targetIds = (name) => {
    if (!cache.has(name)) cache.set(name, idsOf(name))
    return cache.get(name)
  }
  // marked percent-encodes non-ASCII fragments; the ids it writes for CJK
  // headings stay literal UTF-8, so compare on the decoded form.
  const decodeFragment = (fragment) => {
    try {
      return decodeURIComponent(fragment)
    } catch {
      return fragment
    }
  }
  for (const [name, html] of outputs) {
    for (const match of html.matchAll(/<a\s[^>]*href="([^"]*)"/g)) {
      const href = decodeEntities(match[1])
      if (!href || /^(https?:|mailto:|tel:)/.test(href)) continue
      const [target, fragment] = href.split('#')
      const anchor = fragment === undefined ? '' : decodeFragment(fragment)
      if (!target) {
        if (anchor && !targetIds(name).has(anchor)) {
          errors.push(`${name}: missing anchor #${anchor}`)
        }
        continue
      }
      const targetName = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
      if (outputs.has(targetName)) {
        if (anchor && !targetIds(targetName).has(anchor)) {
          errors.push(`${name}: ${href} points at a missing anchor in ${targetName}`)
        }
      } else if (!existsSync(path.join(OUTPUT_DIR, targetName))) {
        errors.push(`${name}: ${href} points at a missing file ${targetName}`)
      }
    }
  }
  if (errors.length) {
    console.error(`Broken links:\n${errors.join('\n')}`)
    process.exit(1)
  }
}

async function main() {
  const outputs = new Map()
  for (const page of PAGES) {
    for (const lang of LANGS) {
      const outName = outputName(page, lang)
      const content = renderContent(page, lang)
      outputs.set(outName, await formatHtml(renderShell(page, lang, content), outName))
    }
  }
  validateOutputLinks(outputs)

  if (CHECK) {
    const drifted = []
    for (const [name, html] of outputs) {
      let current = null
      try {
        current = await fs.readFile(path.join(OUTPUT_DIR, name), 'utf8')
      } catch {
        current = null
      }
      if (current !== html) drifted.push(name)
    }
    for (const name of await listGeneratedHtml()) {
      if (!outputs.has(name)) drifted.push(`${name} (stale)`)
    }
    if (drifted.length) {
      console.error(`Docs output is out of date:\n${drifted.map((name) => `  ${name}`).join('\n')}`)
      console.error('Run `pnpm docs:build` and commit the result.')
      process.exit(1)
    }
    console.log(`Docs output is up to date (${outputs.size} files).`)
    return
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  for (const [name, html] of outputs) {
    await fs.writeFile(path.join(OUTPUT_DIR, name), html)
  }
  let removed = 0
  for (const name of await listGeneratedHtml()) {
    if (!outputs.has(name)) {
      await fs.unlink(path.join(OUTPUT_DIR, name))
      removed += 1
    }
  }
  console.log(`Generated ${outputs.size} docs pages${removed ? `, removed ${removed} stale` : ''}.`)
}

await main()

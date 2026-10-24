import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '../scripts/docs-manifest.json'
import { isCustomBlock } from '../src/lib/workflow/blocks/custom'
import { PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'
import { operatorDocsUrl } from '../src/lib/workflow/docs-links'
import { BLOCK_NAMES_ZH } from '../src/workflow-editor/block-i18n'

const ROOT = process.cwd()
const SOURCE_DIR = path.join(ROOT, 'docs', 'workflow')
const OUTPUT_DIR = path.join(ROOT, 'website', 'docs')
const LANGS = ['en', 'zh'] as const
const MARKER_RE = /^<!--\s*operator:([a-z0-9-]+)(?:\s+status:([a-z0-9-]+))?\s*-->\s*$/gm
const EXPECTED_STATUSES = new Map([
  ['proxy', 'mv3-unsupported'],
  ['save-assets', 'not-implemented'],
  ['browser-event', 'placeholder'],
  ['switch-to', 'placeholder'],
  ['ocr', 'requires-ocr'],
])

type Lang = (typeof LANGS)[number]
type DocPage = (typeof manifest.pages)[number]
type Section = {
  id: string
  status: string | null
  heading: string
  body: string
  page: DocPage
}

function readPage(page: DocPage, lang: Lang): string {
  return fs.readFileSync(path.join(SOURCE_DIR, page.source[lang]), 'utf8')
}

function categoryPage(category: string): DocPage {
  const page = manifest.pages.find((entry) => entry.category === category)
  if (!page) throw new Error(`No docs page is registered for category ${category}`)
  return page
}

function parseSections(page: DocPage, lang: Lang): Section[] {
  const markdown = readPage(page, lang)
  const matches = [...markdown.matchAll(MARKER_RE)]
  return matches.map((match, index) => {
    const id = match[1]
    if (!id) throw new Error(`${page.source[lang]}: operator marker without an id`)
    const start = (match.index ?? 0) + match[0].length
    const end =
      index + 1 < matches.length ? (matches[index + 1]?.index ?? markdown.length) : markdown.length
    const body = markdown.slice(start, end)
    const heading = /^##\s+(.+)$/m.exec(body.trimStart())?.[1]?.trim() ?? ''
    return { id, status: match[2] ?? null, heading, body, page }
  })
}

function allSections(lang: Lang): Section[] {
  return manifest.pages.filter((page) => page.category).flatMap((page) => parseSections(page, lang))
}

describe('workflow docs coverage', () => {
  it('covers exactly the palette operators in both languages', () => {
    expect(PALETTE_BLOCKS).toHaveLength(63)
    const paletteIds = new Set(PALETTE_BLOCKS.map((block) => block.id))
    for (const lang of LANGS) {
      const sections = allSections(lang)
      expect(sections).toHaveLength(PALETTE_BLOCKS.length)
      expect(new Set(sections.map((section) => section.id))).toEqual(paletteIds)
    }
  })

  it('places each operator on exactly one category page', () => {
    for (const lang of LANGS) {
      const placements = new Map<string, string>()
      for (const page of manifest.pages.filter((entry) => entry.category)) {
        for (const section of parseSections(page, lang)) {
          expect(placements.has(section.id), `${section.id} appears twice (${lang})`).toBe(false)
          placements.set(section.id, page.slug)
        }
      }
      for (const block of PALETTE_BLOCKS) {
        expect(placements.get(block.id)).toBe(categoryPage(block.category).slug)
      }
    }
  })

  it('leaves no unmarked H2 on category pages', () => {
    for (const page of manifest.pages.filter((entry) => entry.category)) {
      for (const lang of LANGS) {
        const markdown = readPage(page, lang)
        const h2Count = [...markdown.matchAll(/^##\s/gm)].length
        const markerCount = [...markdown.matchAll(MARKER_RE)].length
        expect(h2Count, `${page.source[lang]} has unmarked H2 headings`).toBe(markerCount)
      }
    }
  })

  it('uses the localized operator name as the section heading', () => {
    const blocks = new Map(PALETTE_BLOCKS.map((block) => [block.id, block]))
    for (const lang of LANGS) {
      for (const section of allSections(lang)) {
        const block = blocks.get(section.id)
        expect(block, `unknown operator ${section.id}`).toBeDefined()
        const expected = lang === 'en' ? block?.name : BLOCK_NAMES_ZH[section.id]
        expect(expected, `missing localized name for ${section.id}`).toBeTruthy()
        expect(section.heading).toBe(expected)
      }
    }
  })

  it('links to upstream Automa docs only when a page exists', () => {
    for (const lang of LANGS) {
      for (const section of allSections(lang)) {
        const upstream = `https://www.goautoma.com/extension/docs/blocks/${section.id}.html`
        const linkCount = section.body.split(upstream).length - 1
        if (manifest.noUpstream.includes(section.id)) {
          expect(linkCount, `${section.id} must not link upstream`).toBe(0)
        } else {
          expect(linkCount, `${section.id} needs exactly one upstream link`).toBe(1)
        }
        if (isCustomBlock(section.id)) {
          expect(manifest.noUpstream, `${section.id} is custom`).toContain(section.id)
        }
      }
    }
  })

  it('marks only the documented unsupported/placeholder operators', () => {
    for (const lang of LANGS) {
      for (const section of allSections(lang)) {
        expect(section.status).toBe(EXPECTED_STATUSES.get(section.id) ?? null)
      }
    }
    for (const status of EXPECTED_STATUSES.values()) {
      expect(Object.keys(manifest.statuses)).toContain(status)
    }
  })

  it('keeps the English and Chinese marker order identical', () => {
    for (const page of manifest.pages.filter((entry) => entry.category)) {
      expect(parseSections(page, 'zh').map((section) => section.id)).toEqual(
        parseSections(page, 'en').map((section) => section.id),
      )
    }
  })

  it('ships generated pages with stable anchors and index links', () => {
    for (const page of manifest.pages) {
      for (const lang of LANGS) {
        const out = path.join(OUTPUT_DIR, `${page.slug}${lang === 'zh' ? '-zh' : ''}.html`)
        expect(fs.existsSync(out), `${out} is missing; run pnpm docs:build`).toBe(true)
      }
    }
    for (const lang of LANGS) {
      const suffix = lang === 'zh' ? '-zh' : ''
      const indexHtml = fs.readFileSync(path.join(OUTPUT_DIR, `index${suffix}.html`), 'utf8')
      expect(indexHtml).toContain(`<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">`)
      const expectedHref = (section: Section) =>
        `href="${section.page.slug}${suffix}.html#operator-${section.id}"`
      for (const section of allSections(lang)) {
        const pageHtml = fs.readFileSync(
          path.join(OUTPUT_DIR, `${section.page.slug}${suffix}.html`),
          'utf8',
        )
        expect(pageHtml).toContain(`id="operator-${section.id}"`)
        expect(indexHtml).toContain(expectedHref(section))
      }
    }
  })

  it('deep-links every palette operator from the editor to its published section', () => {
    for (const block of PALETTE_BLOCKS) {
      const page = categoryPage(block.category)
      for (const lang of LANGS) {
        const suffix = lang === 'zh' ? '-zh' : ''
        expect(operatorDocsUrl(block.id, lang)).toBe(
          `${manifest.siteUrl}/docs/${page.slug}${suffix}.html#operator-${block.id}`,
        )
      }
    }
    expect(operatorDocsUrl('ai-workflow', 'en')).toBeUndefined()
  })

  it('sends the editor to this reference instead of upstream Automa docs', () => {
    for (const file of [
      'src/workflow-editor/sidebar/BlockEditForm.tsx',
      'src/workflow-editor/sidebar/BlockPalette.tsx',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).not.toContain(
        'docs.extension.automa.site',
      )
    }
  })
})

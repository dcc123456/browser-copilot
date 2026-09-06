/**
 * Block icon integrity.
 *
 * Block icons are lucide icons referenced by `lucide:<PascalName>` spec
 * strings and resolved through a static map in `blocks/icons.tsx` — explicit
 * imports, so the bundle only ships the glyphs the catalog uses. These tests
 * pin three invariants:
 *
 *  1. every palette block's spec resolves to a lucide name (never the
 *     fallback), and that name is a real lucide-react export — checked against
 *     the installed package, so a renamed icon fails here instead of
 *     rendering a blank or default glyph;
 *  2. specs persisted by the pre-lucide versions still resolve: the RemixIcon
 *     names in both Pascal (`riFlowChart`) and webfont-kebab form
 *     (`ri-flow-chart`), plus `path:` and `http` specs;
 *  3. truly unknown specs fall back to the default icon instead of throwing.
 */
import { describe, it, expect } from 'vitest'
import * as lucide from 'lucide-react'
import { resolveIconName } from '../src/lib/workflow/blocks/icons'
import { PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'

describe('palette block icons', () => {
  it('every palette block resolves to a real lucide-react export', () => {
    for (const block of PALETTE_BLOCKS) {
      const icon = block.icon
      expect(icon, `${block.id} has an icon`).toBeTruthy()
      if (icon.startsWith('path:') || icon.startsWith('http')) continue
      const name = resolveIconName(icon)
      expect(name, `${block.id} icon "${icon}" resolves (not the fallback)`).toBeTruthy()
      expect(
        (lucide as Record<string, unknown>)[name!],
        `${block.id} icon "${icon}" -> "${name}" is exported by lucide-react`,
      ).toBeTruthy()
    }
  })

  it('the distinct block glyphs stay distinct', () => {
    const byId = new Map(PALETTE_BLOCKS.map((b) => [b.id, resolveIconName(b.icon)]))
    // A few representative blocks that previously shared a family of glyphs.
    expect(byId.get('new-tab')).toBe('Globe')
    expect(byId.get('webhook')).toBe('Webhook')
    expect(byId.get('take-screenshot')).toBe('Camera')
    expect(byId.get('save-assets')).toBe('Image')
    expect(byId.get('javascript-code')).toBe('CodeXml')
    expect(byId.get('create-element')).toBe('SquarePlus')
    expect(byId.get('blocks-group')).toBe('FolderArchive')
  })
})

describe('legacy icon spec compatibility', () => {
  it('maps pre-lucide RemixIcon names (Pascal and kebab form)', () => {
    expect(resolveIconName('riFlowChart')).toBe('Workflow')
    expect(resolveIconName('ri-flow-chart')).toBe('Workflow')
    expect(resolveIconName('riFlashlightLine')).toBe('Zap')
    expect(resolveIconName('ri-delete-bin-7-line')).toBe('Trash2')
    expect(resolveIconName('riCodeSSlashLine')).toBe('CodeXml')
    expect(resolveIconName('riAB')).toBe('GitBranch')
  })

  it('accepts bare lucide names and unknown specs fall back', () => {
    expect(resolveIconName('lucide:Zap')).toBe('Zap')
    expect(resolveIconName('Zap')).toBe('Zap')
    expect(resolveIconName('lucide:NoSuchIcon')).toBeNull()
    expect(resolveIconName('ri-entirely-made-up')).toBeNull()
  })
})

/**
 * Block icon integrity.
 *
 * RemixIcon names are stored in Pascal form (`riFlashlightLine`) and converted
 * to webfont kebab classes at render time. The converter historically only
 * dashed camelCase boundaries, so names with a version/number suffix —
 * `riWindow2Line`, `riDeleteBin7Line`, `riRobot2Line`, … — produced a class
 * with no matching glyph and the node showed no icon. These tests pin the
 * conversion for the digit-suffixed / special-cased names, and assert that
 * every block the palette offers resolves to a supported icon spec whose
 * RemixIcon class actually exists in the bundled font.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { remixClass } from '../src/lib/workflow/blocks/icons'
import { PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'

describe('remixClass name -> webfont class', () => {
  it('dashes plain camelCase', () => {
    expect(remixClass('riFlashlightLine')).toBe('ri-flashlight-line')
    expect(remixClass('riIncreaseDecreaseLine')).toBe('ri-increase-decrease-line')
  })

  it('dashes before a version/number suffix (previously blank icons)', () => {
    expect(remixClass('riWindow2Line')).toBe('ri-window-2-line')
    expect(remixClass('riRepeat2Line')).toBe('ri-repeat-2-line')
    expect(remixClass('riFocus3Line')).toBe('ri-focus-3-line')
    expect(remixClass('riDatabase2Line')).toBe('ri-database-2-line')
    expect(remixClass('riChat3Line')).toBe('ri-chat-3-line')
    expect(remixClass('riDeleteBin7Line')).toBe('ri-delete-bin-7-line')
    expect(remixClass('riNotification3Line')).toBe('ri-notification-3-line')
    expect(remixClass('riSettings3Line')).toBe('ri-settings-3-line')
    expect(remixClass('riRobot2Line')).toBe('ri-robot-2-line')
  })

  it('handles the non-obvious aliases', () => {
    // Html5 keeps its digit attached; SS is two s-tokens; AB has no glyph.
    expect(remixClass('riHtml5Line')).toBe('ri-html5-line')
    expect(remixClass('riCodeSSlashLine')).toBe('ri-code-s-slash-line')
    expect(remixClass('riAB')).toBe('ri-git-branch-line')
  })
})

describe('palette block icons', () => {
  // The webfont stylesheet ships the complete class list; read it so the test
  // fails if a block's RemixIcon name no longer maps to a shipped glyph.
  const css = readFileSync(resolve(__dirname, '../node_modules/remixicon/fonts/remixicon.css'), 'utf8')
  const classExists = (cls: string): boolean => css.includes(`.${cls}:before`)

  it('every palette block uses a supported icon spec with a real glyph', () => {
    for (const block of PALETTE_BLOCKS) {
      const icon = block.icon
      expect(icon, `${block.id} has an icon`).toBeTruthy()
      if (icon.startsWith('path:') || icon.startsWith('http')) continue
      const cls = remixClass(icon)
      const leaf = cls.startsWith('ri-') ? cls.slice(3) : cls
      const exists = classExists(cls) || classExists(`ri-${leaf}-line`) || classExists(`ri-${leaf}-fill`)
      expect(exists, `${block.id} icon "${icon}" -> "${cls}" resolves in the RemixIcon font`).toBe(true)
    }
  })

  it('the digit-suffixed operator blocks render non-blank glyphs', () => {
    const byId = new Map(PALETTE_BLOCKS.map((b) => [b.id, b.icon]))
    // new-window / repeat-task / javascript-code use the digit/SSlash remix names;
    // cookie uses an inline `path:` SVG (handled separately, no font class).
    expect(classExists(remixClass(byId.get('new-window')!))).toBe(true)
    expect(classExists(remixClass(byId.get('repeat-task')!))).toBe(true)
    expect(classExists(remixClass(byId.get('javascript-code')!))).toBe(true)
    expect(byId.get('cookie')!.startsWith('path:')).toBe(true)
  })
})

/**
 * Pure helpers of the CDP trusted-typing fallback (cdp-typing).
 *
 * These events are what makes Zhihu-style DraftJS editors accept input when
 * the in-page simulation is ignored: `Input.dispatchKeyEvent` keyDown with
 * `text` performs a REAL insertion (Playwright-style typing) and
 * `Input.insertText` commits like an IME. Wrong virtual key codes or a
 * missing `text` field silently do nothing in Chromium, hence the strict
 * assertions.
 */
import { describe, it, expect } from 'vitest'
import { charKeyEvent, enterKeyEvent, splitParagraphs } from '../src/background/cdp-typing'

describe('splitParagraphs', () => {
  it('splits on every newline variant', () => {
    expect(splitParagraphs('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps empty paragraphs so blank lines become empty blocks', () => {
    expect(splitParagraphs('一\n\n二')).toEqual(['一', '', '二'])
  })

  it('returns one paragraph for text without newlines', () => {
    expect(splitParagraphs('整段')).toEqual(['整段'])
  })
})

describe('charKeyEvent', () => {
  it('builds a keyDown with text and a proper virtual key code', () => {
    expect(charKeyEvent('a', true)).toEqual({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      text: 'a',
    })
  })

  it('builds a keyUp without text', () => {
    const up = charKeyEvent('a', false)
    expect(up).toEqual({
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    })
    expect('text' in up).toBe(false)
  })

  it('maps digits and punctuation', () => {
    expect(charKeyEvent('1', true)).toMatchObject({ code: 'Digit1', windowsVirtualKeyCode: 49 })
    expect(charKeyEvent('.', true)).toMatchObject({ code: '.', windowsVirtualKeyCode: 46 })
  })

  it('treats CJK characters as text-only (no virtual key code)', () => {
    const down = charKeyEvent('知', true)
    expect(down).toMatchObject({ key: '知', text: '知', windowsVirtualKeyCode: 0, code: '' })
  })
})

describe('enterKeyEvent', () => {
  it('carries text \\r on keyDown so Chromium performs the block split', () => {
    expect(enterKeyEvent(true)).toEqual({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
    })
  })

  it('releases without text on keyUp', () => {
    const up = enterKeyEvent(false)
    expect(up).toEqual({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
    expect('text' in up).toBe(false)
  })
})

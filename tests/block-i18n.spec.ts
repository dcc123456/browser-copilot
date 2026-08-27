import { describe, it, expect } from 'vitest'
import { blockDisplayName, categoryDisplayName, BLOCK_NAMES_ZH } from '../src/workflow-editor/block-i18n'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'

describe('block display-name localization', () => {
  it('returns English in the en locale', () => {
    expect(blockDisplayName('event-click', 'Click element', 'en')).toBe('Click element')
  })

  it('returns the Chinese name when available', () => {
    expect(blockDisplayName('event-click', 'Click element', 'zh')).toBe('点击元素')
    expect(blockDisplayName('forms', 'Forms', 'zh')).toBe('填写表单')
  })

  it('falls back to English for untranslated blocks', () => {
    expect(blockDisplayName('some-untranslated-x', 'Exotic Block', 'zh')).toBe('Exotic Block')
  })

  it('every Chinese block-name key exists in the catalog', () => {
    for (const id of Object.keys(BLOCK_NAMES_ZH)) {
      expect(BLOCK_BY_ID.get(id), `block name key "${id}" is not a catalog id`).toBeDefined()
    }
  })

  it('localizes known categories and falls back otherwise', () => {
    expect(categoryDisplayName('interaction', 'Interaction', 'zh')).toBe('页面交互')
    expect(categoryDisplayName('weird', 'Weird', 'zh')).toBe('Weird')
    expect(categoryDisplayName('interaction', 'Interaction', 'en')).toBe('Interaction')
  })
})

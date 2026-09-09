import { describe, it, expect } from 'vitest'
import {
  makeTranslate,
  makeBlockTranslate,
  resolveEditorLocale,
  EDITOR_STRINGS,
  BLOCK_FORM_STRINGS_ZH,
} from '../src/workflow-editor/i18n'
import { BLOCK_DESCRIPTIONS_ZH } from '../src/workflow-editor/block-i18n'
import { BLOCK_CATALOG } from '../src/lib/workflow/blocks/catalog'
import { CUSTOM_BLOCKS } from '../src/lib/workflow/blocks/custom'

describe('editor i18n', () => {
  it('resolves stored locale to editor locale', () => {
    expect(resolveEditorLocale('en')).toBe('en')
    expect(resolveEditorLocale('zh-CN')).toBe('zh')
  })

  it('auto falls back by navigator language', () => {
    // jsdom navigator.language is usually 'en'; result must be valid.
    const loc = resolveEditorLocale('auto')
    expect(['en', 'zh']).toContain(loc)
  })

  it('every key exists in both locales', () => {
    const enKeys = Object.keys(EDITOR_STRINGS.en)
    for (const key of enKeys) {
      expect(EDITOR_STRINGS.zh[key as keyof typeof EDITOR_STRINGS.zh], `zh missing ${key}`).toBeDefined()
    }
    expect(enKeys.length).toBe(Object.keys(EDITOR_STRINGS.zh).length)
  })

  it('translate returns localized string and falls back to en', () => {
    const tZh = makeTranslate('zh')
    const tEn = makeTranslate('en')
    expect(tZh('run')).toBe('运行')
    expect(tEn('run')).toBe('Run')
    expect(tEn('editor')).toBe('Editor')
    expect(tZh('logs')).toBe('日志')
  })
})

describe('block-form translator (bt)', () => {
  it('returns Chinese for known form labels in zh', () => {
    const bt = makeBlockTranslate('zh')
    expect(bt('Description')).toBe('描述')
    expect(bt('JavaScript code')).toBe('JavaScript 代码')
    expect(bt('Variable name')).toBe('变量名')
    expect(bt('Timeout (milliseconds)')).toBe('超时（毫秒）')
    expect(bt('Select multiple elements')).toBe('选择多个元素')
  })

  it('returns the English source unchanged in en or when untranslated', () => {
    const btEn = makeBlockTranslate('en')
    const btZh = makeBlockTranslate('zh')
    expect(btEn('Description')).toBe('Description')
    // Unknown key falls back verbatim so nothing renders blank.
    expect(btZh('Some brand new label')).toBe('Some brand new label')
  })

  it('zh form dictionary has no empty translations', () => {
    for (const [key, value] of Object.entries(BLOCK_FORM_STRINGS_ZH)) {
      expect(value.trim().length, `empty zh translation for "${key}"`).toBeGreaterThan(0)
    }
  })

  it('describes every palette block in zh', () => {
    const all = [...BLOCK_CATALOG, ...CUSTOM_BLOCKS]
    const missing = all
      .filter((b) => !(b.id in BLOCK_DESCRIPTIONS_ZH))
      .map((b) => `${b.id} (${b.name})`)
    expect(missing, `missing zh descriptions: ${missing.join(', ')}`).toEqual([])
    // And no description entry dangles without a block.
    const ids = new Set(all.map((b) => b.id))
    const dangling = Object.keys(BLOCK_DESCRIPTIONS_ZH).filter((id) => !ids.has(id))
    expect(dangling, `zh descriptions without a block: ${dangling.join(', ')}`).toEqual([])
  })
})

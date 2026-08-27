import { describe, it, expect } from 'vitest'
import { makeTranslate, resolveEditorLocale, EDITOR_STRINGS } from '../src/workflow-editor/i18n'

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

import { describe, expect, it } from 'vitest'
import {
  LOCALES,
  LOCALE_LABELS,
  effectiveLocale,
  messagesFor,
  resolveLocale,
  type Messages,
} from '../src/lib/i18n'

describe('resolveLocale', () => {
  it('maps English tags to en', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'EN']) {
      expect(resolveLocale(tag)).toBe('en')
    }
  })

  // Serving an imperfect Chinese match beats falling back to English for a reader
  // who cannot read English at all.
  it('maps every Chinese variant to zh-CN, including Traditional', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant', 'ZH-tw']) {
      expect(resolveLocale(tag)).toBe('zh-CN')
    }
  })

  it('falls back to en for unsupported and missing tags', () => {
    for (const tag of ['fr', 'de-DE', 'ja', '', undefined]) {
      expect(resolveLocale(tag)).toBe('en')
    }
  })
})

describe('effectiveLocale', () => {
  it('follows the browser when set to auto', () => {
    expect(effectiveLocale('auto', 'zh-CN')).toBe('zh-CN')
    expect(effectiveLocale('auto', 'en-US')).toBe('en')
  })

  // The whole reason for not using chrome.i18n: an explicit choice must win over
  // the browser's own language.
  it('honours an explicit choice regardless of the browser language', () => {
    expect(effectiveLocale('zh-CN', 'en-US')).toBe('zh-CN')
    expect(effectiveLocale('en', 'zh-CN')).toBe('en')
  })

  it('falls back to en for a corrupted stored value', () => {
    expect(effectiveLocale('klingon' as 'en', 'en-US')).toBe('en')
  })
})

describe('dictionaries', () => {
  it('covers every declared locale', () => {
    for (const locale of LOCALES) {
      expect(messagesFor(locale)).toBeDefined()
      expect(LOCALE_LABELS[locale]).toBeTruthy()
    }
  })

  /**
   * Guards against a key added to one dictionary and forgotten in the other.
   *
   * `tsc` catches a *missing* key, but not one whose value was left as the English
   * text, and not a key present only in `en`. Comparing key sets at runtime closes
   * that gap.
   */
  it('has identical key sets across locales', () => {
    const [first, ...rest] = LOCALES.map((locale) => Object.keys(messagesFor(locale)).sort())
    for (const keys of rest) {
      expect(keys).toEqual(first)
    }
  })

  it('leaves no message empty', () => {
    for (const locale of LOCALES) {
      const messages = messagesFor(locale) as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value === 'string') {
          expect(value.trim(), `${locale}.${key} is empty`).not.toBe('')
        } else if (Array.isArray(value)) {
          expect(value.length, `${locale}.${key} is an empty array`).toBeGreaterThan(0)
        } else {
          expect(typeof value, `${locale}.${key} has an unexpected type`).toBe('function')
        }
      }
    }
  })

  it('renders parameterised messages in both languages', () => {
    for (const locale of LOCALES) {
      const t: Messages = messagesFor(locale)
      expect(t.settingsModelsAvailable({ count: 7 })).toContain('7')
      expect(t.skillsSaved({ name: 'Recap' })).toContain('Recap')
      expect(t.chatConfirmTitle({ name: 'read_current_page' })).toContain('read_current_page')
      expect(t.settingsPageReadable({ title: 'Example' })).toContain('Example')
    }
  })

  // A Chinese dictionary that still reads as English would defeat the feature, so
  // spot-check that the translation actually happened.
  it('actually translates the Chinese dictionary', () => {
    const zh = messagesFor('zh-CN')
    const en = messagesFor('en')
    expect(zh.tabChat).not.toBe(en.tabChat)
    expect(zh.tabSkills).not.toBe(en.tabSkills)
    expect(zh.save).not.toBe(en.save)
    // CJK range check: a stray English value would fail this.
    expect(zh.tabSettings).toMatch(/[\u4e00-\u9fff]/)
  })
})

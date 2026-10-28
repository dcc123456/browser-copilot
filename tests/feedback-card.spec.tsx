// @vitest-environment jsdom
/**
 * The settings entry is a card plus a button; the dialog is mounted only after
 * the click, so the settings page itself never reads credentials or network.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { messagesFor, type Locale } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import FeedbackCard from '../src/sidepanel/FeedbackCard'

function render(locale: Locale = 'en'): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(FeedbackCard),
    ),
  )
}

describe('feedback card', () => {
  it('offers the entry without opening the dialog', () => {
    const markup = render()
    expect(markup).toContain('Feedback &amp; suggestions')
    expect(markup).toContain('Send feedback…')
    expect(markup).not.toContain('role="dialog"')
  })

  it('is translated on the Chinese panel', () => {
    const markup = render('zh-CN')
    expect(markup).toContain('反馈与建议')
    expect(markup).toContain('发送反馈…')
  })
})

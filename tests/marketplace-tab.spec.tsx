/**
 * The marketplace tab's first paint: with no snapshot loaded yet it must show
 * the empty state (not an error), and every control must be translated.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/sidepanel/i18n'
import MarketplaceTab from '../src/sidepanel/MarketplaceTab'
import { messagesFor, type Locale } from '../src/lib/i18n'

function render(locale: Locale = 'en'): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(MarketplaceTab, { active: false }),
    ),
  )
}

describe('marketplace tab', () => {
  it('shows the empty state instead of an error before anything is published', () => {
    const markup = render()
    expect(markup).toContain('No workflows have been published yet.')
    expect(markup).toContain('Publish one from the Workflows tab')
    expect(markup).not.toContain('Could not load the marketplace.')
    expect(markup).toContain('placeholder="Search workflows"')
    expect(markup).toContain('All categories')
    expect(markup).toContain('Most liked')
  })

  it('is translated on the Chinese panel', () => {
    const markup = render('zh-CN')
    expect(markup).toContain('工作流广场')
    expect(markup).toContain('搜索工作流')
  })
})

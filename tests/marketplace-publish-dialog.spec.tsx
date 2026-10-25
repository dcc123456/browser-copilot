/**
 * The publish dialog's gating contract: without a GitHub connection it stops
 * at the connection panel, and the form only exists once a token is stored.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/sidepanel/i18n'
import PublishWorkflowDialog from '../src/sidepanel/PublishWorkflowDialog'
import { messagesFor, type Locale } from '../src/lib/i18n'
import type { Workflow } from '../src/lib/workflow/types'

function makeWorkflow(): Workflow {
  return {
    id: 'local-1',
    name: 'Scrape orders',
    description: 'Open the orders page and copy every row.',
    createdAt: 1,
    updatedAt: 2,
    trigger: { type: 'manual' },
    settings: { saveLog: true, debugMode: true, notification: true, reuseLastState: true },
    drawflow: { nodes: [], edges: [] },
  }
}

function render(
  initialAuth: { token: string; login: string } | null,
  locale: Locale = 'en',
): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(PublishWorkflowDialog, {
        workflow: makeWorkflow(),
        onClose: () => {},
        initialAuth,
      }),
    ),
  )
}

describe('publish dialog', () => {
  it('stops at the connection panel without a token', () => {
    const markup = render(null)
    expect(markup).toContain('GitHub connection')
    expect(markup).toContain('Create a token on GitHub')
    expect(markup).not.toContain('shop, orders, export')
    expect(markup).toContain('disabled')
  })

  it('shows the form once connected, prefilled from the workflow', () => {
    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' })
    expect(markup).toContain('Connected as @octocat')
    expect(markup).not.toContain('Create a token on GitHub')
    expect(markup).toContain('value="Scrape orders"')
    expect(markup).toContain('Open the orders page and copy every row.')
    expect(markup).toContain('E-commerce')
  })

  it('is translated on the Chinese panel', () => {
    const markup = render(null, 'zh-CN')
    expect(markup).toContain('GitHub 连接')
    expect(markup).toContain('去 GitHub 创建令牌')
  })
})

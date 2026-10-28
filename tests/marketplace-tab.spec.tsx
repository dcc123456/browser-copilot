/**
 * The marketplace tab's first paint: with no snapshot loaded yet it must show
 * the empty state (not an error), every control must be translated, and the
 * team view must cope with zero, one and several connected repositories.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/sidepanel/i18n'
import MarketplaceTab from '../src/sidepanel/MarketplaceTab'
import { messagesFor, type Locale } from '../src/lib/i18n'
import type { TeamConnection, TeamRepoConfig } from '../src/lib/marketplace/team'

const TOKEN = `ghp_${'a'.repeat(36)}`

function render(
  locale: Locale = 'en',
  initial?: { source: 'public' | 'team'; teamConnections: TeamConnection[] },
): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(MarketplaceTab, { active: false, initial }),
    ),
  )
}

function teamConfig(overrides: Partial<TeamRepoConfig> = {}): TeamRepoConfig {
  return {
    owner: 'acme',
    repo: 'workflows',
    branch: 'main',
    canPush: true,
    isPublic: false,
    ...overrides,
  }
}

function connection(overrides: Partial<TeamRepoConfig> = {}, login = 'octocat'): TeamConnection {
  return { config: teamConfig(overrides), auth: { token: TOKEN, login } }
}

describe('marketplace tab', () => {
  it('shows the empty state instead of an error before anything is published', () => {
    const markup = render()
    expect(markup).toContain('No workflows have been published yet.')
    expect(markup).toContain('Publish one from the Workflows tab')
    expect(markup).not.toContain('Could not load the marketplace.')
    expect(markup).toContain('placeholder="Search workflows"')
    expect(markup).toContain('All categories')
    expect(markup).toContain('Orders &amp; fulfillment')
    expect(markup).toContain('Most liked')
  })

  it('is translated on the Chinese panel', () => {
    const markup = render('zh-CN')
    expect(markup).toContain('工作流广场')
    expect(markup).toContain('搜索工作流')
  })

  it('offers a public/team switch above the catalog', () => {
    const markup = render()
    expect(markup).toContain('>Public</button>')
    expect(markup).toContain('>Team</button>')
    expect(markup).toContain('role="tablist"')
  })

  it('points at Settings when no team repository is connected', () => {
    const markup = render('en', { source: 'team', teamConnections: [] })
    expect(markup).toContain('Team sharing is not connected.')
    expect(markup).toContain('Settings → Team sharing')
    expect(markup).not.toContain('No workflows have been published yet.')
    expect(markup).not.toContain('All team repositories')
  })

  it('explains a read-only team token in the team view', () => {
    const markup = render('en', {
      source: 'team',
      teamConnections: [connection({ canPush: false }, 'reader')],
    })
    expect(markup).toContain('Only collaborators on that repository can read them.')
    expect(markup).toContain('acme/workflows · This token can read the repository but cannot push')
    // A single team needs no filter: the dropdown only appears with several.
    expect(markup).not.toContain('All teams')
  })

  it('merges several teams and offers a per-repository filter', () => {
    const markup = render('en', {
      source: 'team',
      teamConnections: [
        connection(),
        connection({ owner: 'beta', repo: 'automations', canPush: false }, 'beta-dev'),
      ],
    })
    expect(markup).toContain('aria-label="Team repository"')
    expect(markup).toContain('<option value="all" selected="">All teams</option>')
    expect(markup).toContain('<option value="acme/workflows">acme/workflows</option>')
    expect(markup).toContain('<option value="beta/automations">beta/automations</option>')
    // Each repository's warning is labelled with its own address.
    expect(markup).toContain(
      'beta/automations · This token can read the repository but cannot push',
    )
    expect(markup).not.toContain('acme/workflows · This token')
  })
})

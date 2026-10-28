// @vitest-environment jsdom
/**
 * The settings card that connects the panel to private team repositories.
 *
 * Pinned here: nothing connected, one connection, several connections at once,
 * and the two warnings that change what a member may do.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TeamSharingCard from '../src/sidepanel/TeamSharingCard'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor, type Locale } from '../src/lib/i18n'
import type { TeamConnection, TeamRepoConfig } from '../src/lib/marketplace/team'

const TOKEN = `ghp_${'a'.repeat(36)}`

function connection(overrides: Partial<TeamRepoConfig> = {}, login = 'octocat'): TeamConnection {
  return {
    config: {
      owner: 'acme',
      repo: 'workflows',
      branch: 'main',
      canPush: true,
      isPublic: false,
      ...overrides,
    },
    auth: { token: TOKEN, login },
  }
}

function render(connections: TeamConnection[], locale: Locale = 'en'): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(TeamSharingCard, { initialConnections: connections }),
    ),
  )
}

describe('team sharing settings card', () => {
  it('asks for a repository and a token when nothing is connected', () => {
    const markup = render([])

    expect(markup).toContain('Team sharing')
    expect(markup).toContain('your-team/workflows')
    expect(markup).toContain('Create a token')
    expect(markup).toContain('https://github.com/settings/tokens/new?scopes=repo')
    // Both fields empty: connecting is not offered yet.
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Connect<\/button>/)
    expect(markup).not.toContain('Connect another repository')
  })

  it('shows the connected repository and account, and keeps the form for one more', () => {
    const markup = render([connection()])

    expect(markup).toContain('Connected to acme/workflows as @octocat.')
    expect(markup).toContain('Disconnect')
    expect(markup).toContain('Connect another repository')
    expect(markup).not.toContain(TOKEN)
  })

  it('lists every connected repository when the user belongs to several teams', () => {
    const markup = render([
      connection(),
      connection({ owner: 'beta', repo: 'automations' }, 'beta-dev'),
    ])

    expect(markup).toContain('Connected to acme/workflows as @octocat.')
    expect(markup).toContain('Connected to beta/automations as @beta-dev.')
    expect(markup.match(/Disconnect/g)).toHaveLength(2)
  })

  it('warns when the repository is public', () => {
    const markup = render([connection({ isPublic: true })])
    expect(markup).toContain('readable by anyone on GitHub')
  })

  it('warns a read-only member that publishing is unavailable', () => {
    const markup = render([connection({ canPush: false })])
    expect(markup).toContain('publishing needs write access')
    expect(markup).not.toContain('readable by anyone on GitHub')
  })

  it('renders the Chinese copy', () => {
    const markup = render([connection({ isPublic: true })], 'zh-CN')
    expect(markup).toContain('团队共享')
    expect(markup).toContain('已连接到 acme/workflows，身份 @octocat。')
    expect(markup).toContain('该仓库是公开的')
    expect(markup).toContain('再连接一个仓库')
  })
})

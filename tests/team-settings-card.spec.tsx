// @vitest-environment jsdom
/**
 * The settings card that connects the panel to a private team repository.
 *
 * Only the three durable states are pinned: nothing connected, connected,
 * and the two warnings that change what a member may do.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TeamSharingCard from '../src/sidepanel/TeamSharingCard'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor, type Locale } from '../src/lib/i18n'
import type { TeamRepoConfig } from '../src/lib/marketplace/team'

const TOKEN = `ghp_${'a'.repeat(36)}`

function render(
  config: TeamRepoConfig | null,
  locale: Locale = 'en',
  login: string | null = 'octocat',
): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(TeamSharingCard, {
        initial: { config, auth: login ? { token: TOKEN, login } : null },
      }),
    ),
  )
}

function connected(overrides: Partial<TeamRepoConfig> = {}): TeamRepoConfig {
  return {
    owner: 'acme',
    repo: 'workflows',
    branch: 'main',
    canPush: true,
    isPublic: false,
    ...overrides,
  }
}

describe('team sharing settings card', () => {
  it('asks for a repository and a token when nothing is connected', () => {
    const markup = render(null)

    expect(markup).toContain('Team sharing')
    expect(markup).toContain('your-team/workflows')
    expect(markup).toContain('Create a token')
    expect(markup).toContain('https://github.com/settings/tokens/new?scopes=repo')
    // Both fields empty: connecting is not offered yet.
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Connect<\/button>/)
  })

  it('shows the connected repository and account, without the token field', () => {
    const markup = render(connected())

    expect(markup).toContain('Connected to acme/workflows as @octocat.')
    expect(markup).toContain('Disconnect')
    expect(markup).not.toContain('GitHub token')
    expect(markup).not.toContain('ghp_')
  })

  it('warns when the repository is public', () => {
    const markup = render(connected({ isPublic: true }))
    expect(markup).toContain('readable by anyone on GitHub')
  })

  it('warns a read-only member that publishing is unavailable', () => {
    const markup = render(connected({ canPush: false }))
    expect(markup).toContain('publishing needs write access')
    expect(markup).not.toContain('readable by anyone on GitHub')
  })

  it('renders the Chinese copy', () => {
    const markup = render(connected({ isPublic: true }), 'zh-CN')
    expect(markup).toContain('团队共享')
    expect(markup).toContain('已连接到 acme/workflows，身份 @octocat。')
    expect(markup).toContain('该仓库是公开的')
  })
})

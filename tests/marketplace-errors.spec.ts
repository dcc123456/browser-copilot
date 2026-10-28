/**
 * Failure copy for every GitHub surface that connects a token or writes to a
 * repository — shared so a rejected token reads the same in both dialogs.
 */
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../src/lib/i18n'
import { MarketplaceError } from '../src/lib/marketplace/types'
import { connectFailureText } from '../src/sidepanel/marketplace-errors'

describe('connect failure text', () => {
  it('keeps the translated reason and appends the client detail', () => {
    const text = connectFailureText(
      messagesFor('en'),
      new MarketplaceError('network', 'GitHub request failed: Failed to fetch'),
    )
    expect(text).toContain('Could not reach GitHub')
    expect(text).toContain('Failed to fetch')
  })

  it('tells an invalid token apart from a network failure', () => {
    const text = connectFailureText(
      messagesFor('zh-CN'),
      new MarketplaceError('unauthorized', 'GitHub rejected the token: Bad credentials', 401),
    )
    expect(text).toContain('判定令牌无效')
    expect(text).toContain('Bad credentials')
  })

  it('explains a non-classic token instead of the generic invalid copy', () => {
    const error = new MarketplaceError(
      'invalid',
      'Only classic GitHub tokens (ghp_…) are supported',
    )
    expect(connectFailureText(messagesFor('en'), error)).toBe(
      messagesFor('en').marketplaceConnectInvalid,
    )
    expect(connectFailureText(messagesFor('zh-CN'), error)).toBe(
      messagesFor('zh-CN').marketplaceConnectInvalid,
    )
  })

  it('falls back to a plain error message', () => {
    expect(connectFailureText(messagesFor('en'), new Error('boom'))).toBe('boom')
  })
})

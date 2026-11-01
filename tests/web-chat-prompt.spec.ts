import { describe, expect, it } from 'vitest'

import {
  WEB_CHAT_PROMPT_MAX_CHARS,
  WebChatPromptError,
  buildWebChatPrompt,
} from '../src/background/web-chat/prompt'

const user = (content: string) => ({ role: 'user' as const, content })
const assistant = (content: string) => ({ role: 'assistant' as const, content })

describe('buildWebChatPrompt', () => {
  it('keeps roles, order and the closing instruction', () => {
    const prompt = buildWebChatPrompt([
      { role: 'system', content: 'You are terse.' },
      user('First question'),
      assistant('First answer'),
      user('Final question'),
    ])

    expect(prompt).toContain('[Instructions]\nYou are terse.')
    expect(prompt.indexOf('First question')).toBeLessThan(prompt.indexOf('First answer'))
    expect(prompt.indexOf('First answer')).toBeLessThan(prompt.indexOf('Final question'))
    expect(prompt).toContain('Answer the final [User] message only.')
  })

  it('rejects image or file attachments rather than silently dropping them', () => {
    expect(() =>
      buildWebChatPrompt([
        {
          role: 'user',
          content: 'Look at this',
          attachments: [
            {
              id: 'a1',
              name: 'shot.png',
              mimeType: 'image/png',
              size: 12,
              dataUrl: 'data:image/png;base64,AAAA',
            },
          ],
        },
      ]),
    ).toThrow(WebChatPromptError)
  })

  it('trims old assistant turns before user turns when over budget', () => {
    const huge = 'x'.repeat(WEB_CHAT_PROMPT_MAX_CHARS)
    const prompt = buildWebChatPrompt([
      user('old user turn'),
      assistant(huge),
      assistant(huge),
      user('new question'),
    ])

    expect(prompt.length).toBeLessThanOrEqual(WEB_CHAT_PROMPT_MAX_CHARS)
    expect(prompt).toContain('new question')
    expect(prompt).toContain('old user turn')
    expect(prompt).toContain('Earlier conversation was truncated')
  })
})

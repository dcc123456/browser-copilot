import { describe, expect, it } from 'vitest'

import { adapterFor, cssTarget } from '../src/background/web-chat/adapters'

describe('web-chat adapters', () => {
  it('points each site at its free chat root', () => {
    expect(adapterFor('deepseek').url).toBe('https://chat.deepseek.com/')
    expect(adapterFor('chatgpt').url).toBe('https://chatgpt.com/')
  })

  it('keeps a fallback for every primary selector', () => {
    for (const site of ['deepseek', 'chatgpt'] as const) {
      const adapter = adapterFor(site)
      for (const list of [adapter.composer, adapter.reply, adapter.stop, adapter.login]) {
        expect(list.length).toBeGreaterThan(0)
      }
    }
  })

  it('turns candidates into an ordered kernel locator', () => {
    const target = cssTarget(['#a', '#b', '#c'])
    expect(target.primary).toEqual({ how: 'css', value: '#a' })
    expect(target.fallbacks).toEqual([
      { how: 'css', value: '#b' },
      { how: 'css', value: '#c' },
    ])
  })
})

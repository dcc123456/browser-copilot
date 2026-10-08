/**
 * Tests for the size bound on one persisted transcript (`lib/storage` +
 * `lib/llm`):
 *
 *  - a megabyte data URL in a turn (an attached image, or an image a step handed
 *    back) is shed, while the descriptor and every real text value survive;
 *  - the whole `conv:<id>` key stays inside the budget the storage fallback can
 *    carry, shrinking from the oldest turn and never opening on a tool result
 *    (a provider rejects a transcript whose first turn is an orphan result);
 *  - a turn whose attachment bytes are gone is sent as a note, not as an empty
 *    multimodal content array and not as a broken `image_url`.
 *
 * `chrome.storage.local` is stubbed with an in-process map; with no directory
 * handle in a plain Node run, `fileStorageArea()` falls back to exactly that
 * mirror. No chrome, no filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConversation, saveConversation } from '../src/lib/storage'
import { toApiMessages } from '../src/lib/llm'
import type { WireMessage } from '../src/lib/llm'

const data = new Map<string, unknown>()
const KEY = 'conv:c-1'

beforeEach(() => {
  data.clear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (!keys) return Object.fromEntries(data)
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of list) if (data.has(key)) out[key] = data.get(key)
          return out
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) data.set(key, value)
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
        },
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function imageAttachment(name: string, chars: number) {
  return {
    id: name,
    name,
    mimeType: 'image/png',
    size: chars,
    dataUrl: `data:image/png;base64,${'A'.repeat(chars)}`,
  }
}

describe('transcript size bound', () => {
  it('sheds a megabyte attachment and keeps a small one', async () => {
    await saveConversation('c-1', [
      {
        role: 'user',
        content: '用这张封面图',
        attachments: [imageAttachment('cover.png', 3 * 1024 * 1024), imageAttachment('logo.png', 200)],
      },
    ])

    const stored = (data.get(KEY) as WireMessage[])
    const attachments = (stored[0] as { attachments?: { name: string; dataUrl?: string }[] })
      .attachments!
    // The turn keeps its shape — name, mime type and the text the user typed.
    expect(attachments.map((a) => a.name)).toEqual(['cover.png', 'logo.png'])
    expect(attachments[0]!.dataUrl).toBeUndefined()
    expect(attachments[1]!.dataUrl).toContain('data:image/png;base64,')
    expect((await loadConversation('c-1')).length).toBe(1)
  })

  it('replaces a tool result that is nothing but a data URL', async () => {
    await saveConversation('c-1', [
      { role: 'user', content: '生成 3 张图' },
      { role: 'tool', tool_call_id: 't1', content: `data:image/png;base64,${'B'.repeat(4 * 1024 * 1024)}` },
    ] as WireMessage[])

    const stored = data.get(KEY) as { role: string; content: string }[]
    expect(stored[1]!.content).toContain('omitted from history')
    expect(stored[1]!.content.length).toBeLessThan(1024)
    expect(JSON.stringify(stored)).not.toContain('BBBB')
  })

  it('shrinks from the oldest turn without opening on a tool result', async () => {
    const filler = 'x'.repeat(120_000)
    const messages: WireMessage[] = []
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `turn ${i} ${filler}` })
      // An assistant turn that answered by calling a tool, and that tool's
      // result: dropping the pair's first half must not strand the result.
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: `call-${i}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      } as WireMessage)
      messages.push({ role: 'tool', tool_call_id: `call-${i}`, content: `result ${i} ${filler}` })
    }

    await saveConversation('c-1', messages)
    const stored = data.get(KEY) as WireMessage[]
    expect(JSON.stringify(stored).length).toBeLessThan(1_600_000)
    expect(stored.length).toBeLessThan(messages.length)
    expect(stored[0]!.role).not.toBe('tool')
    // The newest turn is never the victim.
    expect(stored[stored.length - 1]!.role).toBe('tool')
  })

  it('sends a note for a turn whose attachment bytes are gone', () => {
    const [request] = toApiMessages([
      {
        role: 'user',
        content: '',
        attachments: [{ id: 'a', name: 'a.png', mimeType: 'image/png', size: 0 }],
      } as WireMessage,
    ]) as { role: string; content: unknown }[]

    const parts = request!.content as { type: string; text?: string; image_url?: unknown }[]
    expect(parts).toHaveLength(1)
    expect(parts[0]!.type).toBe('text')
    expect(parts[0]!.text).toContain('no longer available')
    expect(JSON.stringify(request)).not.toContain('image_url')
  })

  it('still folds a surviving small image into an image_url part', () => {
    const [request] = toApiMessages([
      {
        role: 'user',
        content: 'look',
        attachments: [imageAttachment('small.png', 200)],
      } as WireMessage,
    ]) as { content: { type: string; image_url?: { url: string } }[] }[]
    const imagePart = request!.content.find((part) => part.type === 'image_url')
    expect(imagePart?.image_url?.url).toContain('data:image/png;base64,')
  })
})

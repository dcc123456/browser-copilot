// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  fileToDraft,
  isImageAttachment,
  isTextAttachment,
  rejectionMessage,
  sanitizeAttachments,
  toAttachmentSummaries,
  validateAttachmentMeta,
} from '../src/lib/attachments'
import { toApiMessages, type WireMessage } from '../src/lib/llm'
import { toRestoreMessages } from '../src/background/restore'

function imageAttachment(): Extract<WireMessage, { role: 'user' }> {
  return {
    role: 'user',
    content: '',
    attachments: [],
  }
}

describe('toApiMessages', () => {
  it('passes messages without attachments through by reference', () => {
    const messages: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ]
    const out = toApiMessages(messages)
    expect(out).toEqual(messages)
    expect(out[0]).toBe(messages[0])
    expect(out[1]).toBe(messages[1])
    expect(JSON.stringify(out)).not.toContain('attachments')
  })

  it('treats an empty attachments array as no attachments', () => {
    const user: WireMessage = { role: 'user', content: 'plain', attachments: [] }
    const out = toApiMessages([user])
    expect(out[0]).toBe(user)
  })

  it('builds text + image_url parts for an image attachment', () => {
    const out = toApiMessages([
      {
        role: 'user',
        content: 'What is in this picture?',
        attachments: [
          {
            id: 'a1',
            name: 'pic.png',
            mimeType: 'image/png',
            size: 4,
            dataUrl: 'data:image/png;base64,AAAA',
          },
        ],
      },
    ])
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  it('inlines a text attachment behind a four-backtick fence', () => {
    const out = toApiMessages([
      {
        role: 'user',
        content: 'Summarize',
        attachments: [
          {
            id: 'a2',
            name: 'notes.md',
            mimeType: 'text/markdown',
            size: 20,
            content: 'line with a ```code``` fence',
          },
        ],
      },
    ])
    const content = (out[0] as { content: { type: string; text: string }[] }).content
    expect(content).toHaveLength(2)
    expect(content[0]!).toEqual({ type: 'text', text: 'Summarize' })
    expect(content[1]!.type).toBe('text')
    // The labelled fence uses four backticks so embedded ``` cannot break out.
    expect(content[1]!.text).toBe(
      '[Attachment: notes.md]\n````\nline with a ```code``` fence\n````',
    )
  })

  it('emits no empty text part for attachment-only turns', () => {
    const out = toApiMessages([
      {
        role: 'user',
        content: '',
        attachments: [
          { id: 'a3', name: 'data.csv', mimeType: 'text/csv', size: 6, content: 'a,b,c' },
        ],
      },
    ])
    const content = (out[0] as { content: { type: string }[] }).content
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect((out[0] as Record<string, unknown>).attachments).toBeUndefined()
  })

  it('skips unknown attachment payloads instead of failing the request', () => {
    const out = toApiMessages([
      {
        role: 'user',
        content: '',
        attachments: [{ id: 'a4', name: 'x.bin', mimeType: 'application/octet-stream', size: 2 }],
      },
    ])
    const content = (out[0] as { content: unknown[] }).content
    expect(content).toHaveLength(0)
  })
})

describe('validateAttachmentMeta', () => {
  const textMeta = { name: 'a.txt', mimeType: 'text/plain', size: 10 }

  it('accepts a supported file with room to spare', () => {
    expect(validateAttachmentMeta(textMeta, [])).toBeNull()
    expect(
      validateAttachmentMeta({ name: 'p.png', mimeType: 'image/png', size: MAX_IMAGE_BYTES }, []),
    ).toBeNull()
  })

  it('rejects the fifth file on one message', () => {
    const four = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => ({
      id: `a${index}`,
      name: `f${index}.txt`,
      mimeType: 'text/plain',
      size: 1,
      content: 'x',
    }))
    expect(validateAttachmentMeta(textMeta, four)).toBe('too-many')
  })

  it('rejects unsupported types', () => {
    expect(
      validateAttachmentMeta(
        { name: 'x.exe', mimeType: 'application/octet-stream', size: 10 },
        [],
      ),
    ).toBe('unsupported')
  })

  it('rejects oversized images and text files at the byte boundary', () => {
    expect(
      validateAttachmentMeta(
        { name: 'p.png', mimeType: 'image/png', size: MAX_IMAGE_BYTES + 1 },
        [],
      ),
    ).toBe('too-large-image')
    expect(
      validateAttachmentMeta(
        { name: 'big.txt', mimeType: 'text/plain', size: MAX_TEXT_BYTES + 1 },
        [],
      ),
    ).toBe('too-large-text')
  })

  it('rejects when the combined size would exceed the total cap', () => {
    const fourMb = { id: 'h', name: 'h.png', mimeType: 'image/png', size: MAX_IMAGE_BYTES, dataUrl: 'data:image/png;base64,A' }
    // Each image is within its own cap, but the message total crosses 8MB.
    expect(
      validateAttachmentMeta(
        { name: 'p2.png', mimeType: 'image/png', size: 1024 },
        [fourMb, { ...fourMb, id: 'h2' }],
      ),
    ).toBe('total-too-large')
    // Exactly at the total cap is still acceptable.
    expect(
      validateAttachmentMeta(
        { name: 'p2.png', mimeType: 'image/png', size: MAX_IMAGE_BYTES },
        [fourMb],
      ),
    ).toBeNull()
  })
})

describe('fileToDraft', () => {
  it('decodes a text file into inline content', async () => {
    const file = new File(['hello world'], 'note.txt', { type: 'text/plain' })
    const draft = await fileToDraft(file)
    expect(draft.name).toBe('note.txt')
    expect(draft.mimeType).toBe('text/plain')
    expect(draft.size).toBe(file.size)
    expect(draft.content).toBe('hello world')
    expect(draft.dataUrl).toBeUndefined()
    expect(isTextAttachment(draft)).toBe(true)
    expect(isImageAttachment(draft)).toBe(false)
  })

  it('keeps an image as a data URL without inline text', async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'p.png', {
      type: 'image/png',
    })
    const draft = await fileToDraft(file)
    expect(draft.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(draft.content).toBeUndefined()
    expect(isImageAttachment(draft)).toBe(true)
  })

  it('guesses a missing MIME type from the extension', async () => {
    const file = new File(['{}'], 'settings.json', { type: '' })
    const draft = await fileToDraft(file)
    expect(draft.mimeType).toBe('application/json')
    expect(draft.content).toBe('{}')
  })
})

describe('toAttachmentSummaries', () => {
  it('strips text content but keeps identity and preview data', () => {
    const summaries = toAttachmentSummaries([
      {
        id: 'a1',
        name: 'n.txt',
        mimeType: 'text/plain',
        size: 5,
        content: 'secret',
      },
      {
        id: 'a2',
        name: 'p.png',
        mimeType: 'image/png',
        size: 9,
        dataUrl: 'data:image/png;base64,BBBB',
      },
    ])
    expect(summaries[0]).toEqual({ id: 'a1', name: 'n.txt', mimeType: 'text/plain', size: 5 })
    expect(summaries[1]).toEqual({
      id: 'a2',
      name: 'p.png',
      mimeType: 'image/png',
      size: 9,
      dataUrl: 'data:image/png;base64,BBBB',
    })
    expect(JSON.stringify(summaries)).not.toContain('secret')
  })
})

describe('sanitizeAttachments', () => {
  it('keeps valid descriptors in order and drops malformed ones', () => {
    const good = { id: 'a1', name: 'a.txt', mimeType: 'text/plain', size: 3, content: 'abc' }
    const { kept, rejected } = sanitizeAttachments([
      good,
      { name: 'no-bytes', size: 1 },
      { name: 'bad-url', size: 1, dataUrl: 'http://example.com/x.png' },
      { name: 'b.txt', mimeType: 'text/plain', size: 3, content: 'zzz' },
    ])
    expect(kept.map((attachment) => attachment.name)).toEqual(['a.txt', 'b.txt'])
    expect(rejected.map((entry) => entry.name)).toEqual(['no-bytes', 'bad-url'])
    expect(rejected.every((entry) => entry.code === 'unsupported')).toBe(true)
  })

  it('drops over-limit files without failing the batch', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => ({
      name: `f${index}.txt`,
      mimeType: 'text/plain',
      size: 2,
      content: 'x',
    }))
    const { kept, rejected } = sanitizeAttachments(files)
    expect(kept).toHaveLength(MAX_ATTACHMENTS)
    expect(rejected).toEqual([{ name: `f${MAX_ATTACHMENTS}.txt`, code: 'too-many' }])
  })

  it('treats a missing list as empty', () => {
    expect(sanitizeAttachments(undefined)).toEqual({ kept: [], rejected: [] })
  })
})

describe('rejectionMessage', () => {
  it('mentions the file for type and size problems', () => {
    expect(rejectionMessage('x.exe', 'unsupported')).toContain('x.exe')
    expect(rejectionMessage('big.txt', 'too-large-text')).toContain('big.txt')
    expect(rejectionMessage('p.png', 'too-large-image')).toContain('p.png')
  })

  it('covers the count and total-size codes', () => {
    expect(rejectionMessage('a.txt', 'too-many')).toMatch(/\d/)
    expect(rejectionMessage('a.txt', 'total-too-large')).toMatch(/\d/)
  })
})

describe('toRestoreMessages', () => {
  it('maps user attachments to summaries and labels tool results', () => {
    const history: WireMessage[] = [
      {
        role: 'user',
        content: 'look at this',
        attachments: [
          { id: 'a1', name: 'pic.png', mimeType: 'image/png', size: 5, dataUrl: 'data:image/png;base64,A' },
          { id: 'a2', name: 'n.txt', mimeType: 'text/plain', size: 11, content: 'plain text' },
        ],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_current_page', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        name: 'read_current_page',
        content: JSON.stringify({ ok: true, title: 'Example', text: 'body' }),
      },
    ]
    const out = toRestoreMessages(history)
    expect(out).toHaveLength(3)
    expect(out[0]!.role).toBe('user')
    expect(out[0]!.text).toBe('look at this')
    expect(out[0]!.attachments?.[0]).toEqual({
      id: 'a1',
      name: 'pic.png',
      mimeType: 'image/png',
      size: 5,
      dataUrl: 'data:image/png;base64,A',
    })
    // The inline text content must never reach the replay.
    expect(JSON.stringify(out[0]!.attachments)).not.toContain('plain text')
    expect(out[1]!.role).toBe('assistant')
    expect(out[1]!.text).toBe('')
    expect(out[2]!.role).toBe('tool')
    expect(out[2]!.text).toContain('read_current_page')
  })

  it('passes plain user and assistant turns through unchanged', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ]
    expect(toRestoreMessages(history)).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello there' },
    ])
  })

  it('handles a non-string assistant content defensively', () => {
    const history: WireMessage[] = [{ role: 'assistant', content: null }]
    expect(toRestoreMessages(history)).toEqual([{ role: 'assistant', text: '' }])
  })
})

describe('descriptor shape guards', () => {
  it('image and text guards agree with the payloads they inspect', () => {
    expect(isImageAttachment({ dataUrl: 'data:image/webp;base64,A' })).toBe(true)
    expect(isImageAttachment({ dataUrl: 'data:text/plain;base64,A' })).toBe(false)
    expect(isImageAttachment({})).toBe(false)
    expect(isTextAttachment({ content: '' })).toBe(true)
    expect(isTextAttachment({})).toBe(false)
  })

  it('keeps the image helper unused-warning-free for future callers', () => {
    // imageAttachment() exists to anchor the WireMessage user-attachment shape;
    // a user turn with attachments must typecheck and round-trip untouched.
    const turn = imageAttachment()
    turn.attachments = [
      { id: 'x', name: 'x.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,x' },
    ]
    expect(toApiMessages([turn])[0]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
    })
  })
})

/**
 * Pre-flight for the goal's own scenario, measured against every durable writer
 * at once.
 *
 * The round that died had 27 nodes and three script-drawn PNGs, and its data
 * directory was unreachable, so ALL of that traffic landed in
 * `chrome.storage.local`: the transcript, the per-run checkpoints, the finished
 * run log, the draft — and all of it also parked in the write outbox, which is
 * one key rewritten whole on every enqueue. The last WAL entry measured 571 MB
 * under a single key. These writers each got a size bound separately; this file
 * runs the composite, because the failure was never one key, it was several
 * bounded things arriving at the same place at the same time.
 *
 * The pass condition is not "each writer stays small" but "the store as a whole
 * stays inside the limit where the next boot must discard rather than read" —
 * i.e. this scenario can never again leave a buffer a service worker dies
 * trying to deserialize.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OUTBOX_KEY, enqueueOutbox, readOutboxMap } from '../src/lib/fs-outbox'
import { createChromeCheckpointStore, readPersistedCheckpoints } from '../src/background/checkpoint-store'
import { recordFinishedRun } from '../src/lib/task-store'
import { loadDraft, saveDraft } from '../src/lib/workflow/draft-storage'
import { getWorkflow, saveWorkflow } from '../src/lib/workflow/storage'
import { saveConversation } from '../src/lib/storage'
import type { StorageArea } from '../src/lib/fs-store'
import type { WireMessage } from '../src/lib/llm'

/** Everything the round put on disk at once: 27 steps, 3 images of ~1.4 MB each. */
const NODES = 27
const IMAGE_CHARS = 1_400_000
/** `OUTBOX_DISCARD_LIMIT` in fs-outbox — past this the next boot throws the buffer away. */
const DISCARD_LIMIT = 24 * 1024 * 1024

const dataUrl = (tag: string): string => `data:image/png;base64,${tag.repeat(IMAGE_CHARS / 2)}`.slice(0, IMAGE_CHARS)

const store = new Map<string, unknown>()
/** Every durable write, as the storage layer actually saw it. */
let writes: { key: string; bytes: number }[] = []

const sizeOf = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

beforeEach(() => {
  store.clear()
  writes = []
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (!keys) return Object.fromEntries(store)
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of list) if (store.has(key)) out[key] = store.get(key)
          return out
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value)
            writes.push({ key, bytes: sizeOf(value) })
          }
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
        },
        async getBytesInUse(key?: string | null) {
          const value = typeof key === 'string' ? store.get(key) : undefined
          return value === undefined ? 0 : sizeOf(value)
        },
      },
    },
  })
})

/** A fake area that records its writes the same way, for the checkpoint store. */
function fakeArea(): StorageArea {
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const key of list) if (store.has(key)) out[key] = store.get(key)
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value)
        writes.push({ key, bytes: sizeOf(value) })
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
    },
  }
}

const biggest = (key: string): number =>
  writes.filter((w) => w.key === key).reduce((max, w) => Math.max(max, w.bytes), 0)

const resident = (): number =>
  [...store.entries()].reduce((sum, [, value]) => sum + sizeOf(value), 0)

function transcript(): WireMessage[] {
  const messages: WireMessage[] = [
    { role: 'user', content: '结合 readme 去小红书生成图文推广文章，用脚本画 3 张图，保存成草稿' },
  ]
  for (let step = 0; step < NODES; step += 1) {
    const image = dataUrl('ab')
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `call-${step}`,
          type: 'function',
          function: { name: 'run_javascript', arguments: JSON.stringify({ code: `draw(${image})` }) },
        },
      ],
    } as WireMessage)
    // The generated image comes back as a tool result, then travels into the
    // upload step's arguments — the exact path that put base64 in every key.
    messages.push({ role: 'tool', tool_call_id: `call-${step}`, content: image } as WireMessage)
  }
  messages.push({
    role: 'user',
    content: '封面用这张',
    attachments: [{ id: 'a1', name: 'cover.png', mimeType: 'image/png', size: IMAGE_CHARS, dataUrl: dataUrl('cd') }],
  } as WireMessage)
  return messages
}

describe('the goal scenario leaves no buffer the next boot cannot read', () => {
  it('bounds the transcript even when every step returns a generated image', async () => {
    await saveConversation('c-1', transcript())

    expect(store.has('conv:c-1')).toBe(true)
    expect(biggest('conv:c-1')).toBeLessThanOrEqual(1_600_000)
  })

  it('bounds each run checkpoint and keeps the newest suffix resumable', async () => {
    const area = fakeArea()
    const checkpoints = createChromeCheckpointStore({ area })
    const image = dataUrl('ef')
    for (let step = 0; step < NODES; step += 1) {
      checkpoints.save({
        runId: 'run-1',
        stepIndex: step,
        nodeId: `n${step}`,
        status: 'ok',
        at: step,
        variables: { cover: image, title: '推广文案', steps: step },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(biggest('cp:run-1')).toBeLessThanOrEqual(2_100_000)
    const resumed = await readPersistedCheckpoints('run-1', area)
    expect(resumed.length).toBeGreaterThan(0)
    expect(resumed[resumed.length - 1]?.stepIndex).toBe(NODES - 1)
  })

  it('bounds the finished run log whose steps each carried a variable bag', async () => {
    await recordFinishedRun({
      runId: 'run-1',
      source: 'manual',
      workflowId: 'wf-1',
      outcome: 'ok',
      steps: Array.from({ length: NODES }, (_, step) => ({
        at: step,
        kind: 'node',
        text: `generated cover.png (${dataUrl('gh').length} chars) into the bag`,
        nodeId: `n${step}`,
        vars: { cover: dataUrl('ij') },
      })) as never,
    })

    expect(biggest('runs')).toBeLessThanOrEqual(1_600_000)
  })

  it('bounds the draft the replay just sealed, without corrupting its graph', async () => {
    // A generated graph can inline the PNG its code node drew into that node's
    // own `code` literal — 27 of those is the 36 MB single write that was
    // measured. The bulk payload goes; the real script does not.
    const script = `const c = document.createElement('canvas')\n${'// paint\n'.repeat(2000)}`
    expect(script.length).toBeGreaterThan(8 * 1024)
    await saveDraft({
      conversationId: 'c-1',
      name: '小红书图文推广',
      nodes: Array.from({ length: NODES }, (_, step) => ({
        id: `n${step}`,
        label: step === 0 ? 'trigger' : 'code',
        position: { x: step * 220, y: 0 },
        data:
          step === 0
            ? { blockId: 'trigger', type: 'manual' }
            : { blockId: 'code', code: step === 1 ? script : `draw('${dataUrl('kl')}')` },
      })),
      edges: [],
      tail: `n${NODES - 1}`,
      source: 'chat-generate',
      variables: { cover: dataUrl('mn') },
    } as never)

    expect(biggest('workflow-drafts')).toBeLessThanOrEqual(1_600_000)
    const sealed = await loadDraft('c-1')
    const code = (sealed?.nodes as { data?: { code?: string } }[]).find(
      (node) => node?.data?.code,
    )!.data!.code!
    expect(code).toBe(script)
    expect(JSON.stringify(sealed)).not.toContain('base64,klkl')
  })

  it('bounds the saved graph itself, which is one key rewritten whole on every save', async () => {
    await saveWorkflow({
      id: 'wf-1',
      name: '小红书图文推广',
      drawflow: {
        nodes: Array.from({ length: NODES }, (_, step) => ({
          id: `n${step}`,
          label: step === 0 ? 'trigger' : 'code',
          position: { x: step * 220, y: 0 },
          data:
            step === 0
              ? { blockId: 'trigger', type: 'manual' }
              : { blockId: 'code', code: `upload('${dataUrl('wx')}')` },
        })),
        edges: [],
      },
    } as never)

    expect(biggest('workflows')).toBeLessThanOrEqual(1_600_000)
    const saved = await getWorkflow('wf-1')
    expect((saved?.drawflow?.nodes ?? []).length).toBe(NODES)
    expect(JSON.stringify(saved)).not.toContain('base64,wxwx')
  })

  it('keeps the whole store under the size where a boot must discard a buffer', async () => {
    // Drive the four writers first, then take WHAT THEY PERSISTED and park it in
    // the outbox — the shape of an outage where the data directory handle sat at
    // 'prompt' and every content key the directory could not receive landed in
    // one key rewritten whole. The old assertion ("raw payloads are small")
    // would prove nothing; this one asks whether the shared buffer can survive
    // the real, already-bounded outputs of a run like this.
    await saveConversation('c-1', transcript())
    const area = fakeArea()
    const checkpoints = createChromeCheckpointStore({ area })
    const image = dataUrl('uv')
    for (let step = 0; step < NODES; step += 1) {
      checkpoints.save({
        runId: 'run-1',
        stepIndex: step,
        nodeId: `n${step}`,
        status: 'ok',
        at: step,
        variables: { cover: image },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await recordFinishedRun({
      runId: 'run-1',
      source: 'manual',
      outcome: 'ok',
      steps: [{ at: 0, kind: 'node', text: 'drew cover.png', vars: { cover: image } }] as never,
    })
    await saveDraft({
      conversationId: 'c-1',
      name: '小红书图文推广',
      nodes: [{ id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger', type: 'manual' } }],
      edges: [],
      tail: 't',
      source: 'chat-generate',
      variables: { cover: image },
    } as never)

    const parked = [...store.keys()].filter((key) => !key.startsWith('fs-'))
    expect(parked.length).toBeGreaterThan(2)

    // Two passes: the second is the read-modify-write of a run that keeps writing
    // while the buffer is already full — where the growth came from.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const key of parked) {
        await enqueueOutbox(key, store.get(key))
        expect(sizeOf(await readOutboxMap())).toBeLessThanOrEqual(9 * 1024 * 1024)
      }
    }

    expect(store.has(OUTBOX_KEY)).toBe(true)
    expect(sizeOf(store.get(OUTBOX_KEY))).toBeLessThan(DISCARD_LIMIT)
    expect(resident()).toBeLessThan(DISCARD_LIMIT)
  })
})

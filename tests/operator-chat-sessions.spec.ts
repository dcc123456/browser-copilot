/**
 * Saved AI-assistant chats of a workflow: the per-workflow key, stale-write
 * protection, and the cascade that removes chats when the workflow is deleted.
 *
 * `chrome.storage.local` is stubbed with an in-process map; with no directory
 * handle in a plain Node run, `fileStorageArea()` falls back to that mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  deleteOperatorChatSession,
  deleteOperatorChatSessionsForWorkflow,
  listOperatorChatSessions,
  operatorChatSessionsKey,
  saveOperatorChatSession,
  type OperatorChatSession,
} from '../src/lib/workflow/operator-chat-sessions'
import { deleteWorkflow, deleteWorkflows } from '../src/lib/workflow/storage'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key)
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) store.delete(key)
    }),
  }
  return { store, storage: { local: { get: local.get, set: local.set, remove: local.remove } } }
}

function session(
  workflowId: string,
  overrides: Partial<OperatorChatSession> = {},
): OperatorChatSession {
  return {
    id: 'chat-1',
    workflowId,
    title: 'Open the site',
    createdAt: 1_000,
    updatedAt: 1_000,
    turns: [{ role: 'user', content: 'Open the site' }],
    ...overrides,
  }
}

describe('operator chat sessions', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts empty and keys the sessions by workflow id', async () => {
    expect(await listOperatorChatSessions('wf-1')).toEqual([])
    expect(operatorChatSessionsKey('wf-1')).toBe('operatorChat:wf-1')
  })

  it('saves one chat and returns it with its opaque transcript intact', async () => {
    const turns = [
      { role: 'user', content: 'Add a click block' },
      { role: 'assistant', content: 'Done', proposals: [{ blockId: 'click-element' }] },
    ]
    await saveOperatorChatSession('wf-1', session('wf-1', { turns }))

    const list = await listOperatorChatSessions('wf-1')
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe('Open the site')
    expect(list[0]!.workflowId).toBe('wf-1')
    expect(list[0]!.turns).toEqual(turns)
  })

  it('updates a chat in place instead of duplicating it, newest first', async () => {
    await saveOperatorChatSession('wf-1', session('wf-1', { updatedAt: 1_000 }))
    await saveOperatorChatSession(
      'wf-1',
      session('wf-1', { updatedAt: 2_000, title: 'Open the site (edited)' }),
    )
    await saveOperatorChatSession(
      'wf-1',
      session('wf-1', { id: 'chat-2', updatedAt: 3_000, title: 'Second chat' }),
    )

    const list = await listOperatorChatSessions('wf-1')
    expect(list.map((entry) => entry.id)).toEqual(['chat-2', 'chat-1'])
    expect(list[1]!.title).toBe('Open the site (edited)')
  })

  it('never lets an out-of-order older snapshot win', async () => {
    const newer = session('wf-1', {
      updatedAt: 5_000,
      turns: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
    })
    const stale = session('wf-1', {
      updatedAt: 4_000,
      turns: [{ role: 'user', content: 'first' }],
    })
    await saveOperatorChatSession('wf-1', newer)
    await saveOperatorChatSession('wf-1', stale)

    const list = await listOperatorChatSessions('wf-1')
    expect(list[0]!.updatedAt).toBe(5_000)
    expect(list[0]!.turns).toHaveLength(2)
  })

  it('drops unusable records instead of trusting a stale file', async () => {
    const key = operatorChatSessionsKey('wf-1')
    mocks.store.set(key, [
      { id: '', turns: [] },
      null,
      'not a session',
      { id: 'no-turns' },
      session('wf-1', { id: 'good' }),
    ])

    const list = await listOperatorChatSessions('wf-1')
    expect(list.map((entry) => entry.id)).toEqual(['good'])
  })

  it('deletes one chat and removes the key when the last one goes', async () => {
    await saveOperatorChatSession('wf-1', session('wf-1'))
    await saveOperatorChatSession('wf-1', session('wf-1', { id: 'chat-2', updatedAt: 2_000 }))
    await deleteOperatorChatSession('wf-1', 'chat-2')
    expect((await listOperatorChatSessions('wf-1')).map((entry) => entry.id)).toEqual(['chat-1'])

    await deleteOperatorChatSession('wf-1', 'chat-1')
    expect(await listOperatorChatSessions('wf-1')).toEqual([])
    expect(mocks.store.has(operatorChatSessionsKey('wf-1'))).toBe(false)
  })

  it('keeps chats of different workflows apart', async () => {
    await saveOperatorChatSession('wf-1', session('wf-1'))
    await saveOperatorChatSession('wf-2', session('wf-2', { id: 'chat-2' }))

    expect((await listOperatorChatSessions('wf-1')).map((entry) => entry.id)).toEqual(['chat-1'])
    expect((await listOperatorChatSessions('wf-2')).map((entry) => entry.id)).toEqual(['chat-2'])
  })

  it('cascades every saved chat when a workflow is deleted', async () => {
    await saveOperatorChatSession('wf-1', session('wf-1'))
    await saveOperatorChatSession('wf-1', session('wf-1', { id: 'chat-2' }))
    await saveOperatorChatSession('wf-2', session('wf-2'))

    await deleteWorkflow('wf-1')

    expect(await listOperatorChatSessions('wf-1')).toEqual([])
    expect(mocks.store.has(operatorChatSessionsKey('wf-1'))).toBe(false)
    expect(await listOperatorChatSessions('wf-2')).toHaveLength(1)
  })

  it('cascades for a bulk delete too', async () => {
    await saveOperatorChatSession('wf-1', session('wf-1'))
    await saveOperatorChatSession('wf-2', session('wf-2'))
    await saveOperatorChatSession('wf-3', session('wf-3'))

    await deleteWorkflows(['wf-1', 'wf-2'])

    expect(await listOperatorChatSessions('wf-1')).toEqual([])
    expect(await listOperatorChatSessions('wf-2')).toEqual([])
    expect(await listOperatorChatSessions('wf-3')).toHaveLength(1)
  })

  it('ignores empty and missing ids', async () => {
    await saveOperatorChatSession('', session(''))
    await saveOperatorChatSession('wf-1', session('wf-1', { id: '' }))
    await deleteOperatorChatSessionsForWorkflow('')
    await deleteOperatorChatSession('wf-1', '')
    expect(await listOperatorChatSessions('wf-1')).toEqual([])
  })
})

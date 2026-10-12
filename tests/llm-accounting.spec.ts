/**
 * Capture-layer tests: how a completed request becomes a ledger record.
 *
 * This is the layer that decides *whose* spend a token was, so it is where the
 * dashboard's two credibility guarantees live (design §4.2, acceptance R2/R6/R7):
 *  - the conversation-id prefixes unattended runs already use map onto the
 *    right consumer and entity, so every feature has an owner in the ledger;
 *  - one request yields one record built from that request's usage, never from
 *    a cumulative per-turn snapshot;
 *  - accounting is a side channel: an unattributed request is not silently
 *    filed under some other bucket, and a throwing sink never breaks a call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { observeUsage, setUsageObserver, type TokenUsage, type UsageEvent } from '../src/lib/llm'
import { TOKEN_CONSUMERS } from '../src/lib/token-ledger'
import {
  buildRecord,
  installTokenAccounting,
  turnAttribution,
} from '../src/background/token-accounting'
import { readTokenUsage, touchConversation } from '../src/lib/storage'
import { createDraft } from '../src/lib/task-store'

const usage = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
})

describe('turnAttribution', () => {
  it('maps every unattended conversation prefix to its consumer and entity', () => {
    expect(turnAttribution('task:t-1')).toEqual({
      consumer: 'scheduled-task',
      entityKey: 'task:t-1',
    })
    expect(turnAttribution('workflow-replay:wf-1')).toEqual({
      consumer: 'workflow-run',
      entityKey: 'workflow:wf-1',
    })
    expect(turnAttribution('workflow-ai-agent:wf-1')).toEqual({
      consumer: 'workflow-run',
      entityKey: 'workflow:wf-1',
    })
    expect(turnAttribution('workflow-generation:wf-1')).toEqual({
      consumer: 'workflow-generation',
      entityKey: 'workflow:wf-1',
    })
    expect(turnAttribution('external:k-1')).toEqual({
      consumer: 'external-api',
      entityKey: 'external:k-1',
    })
    // A bridge-started generation run is keyed by its handle: `chat:` would
    // promise a conversation the panel can never open.
    expect(turnAttribution('external-gen:r7Kx')).toEqual({
      consumer: 'workflow-generation',
      entityKey: 'run:r7Kx',
    })
    expect(turnAttribution('feishu:u-1')).toEqual({
      consumer: 'external-api',
      entityKey: 'external:u-1',
    })
  })

  it('files an ordinary conversation as chat, and a workflow-mode turn as generation', () => {
    expect(turnAttribution('c-1')).toEqual({ consumer: 'chat', entityKey: 'chat:c-1' })
    expect(turnAttribution('c-1', 'workflow')).toEqual({
      consumer: 'workflow-generation',
      entityKey: 'chat:c-1',
    })
  })

  it('covers every consumer the dashboard can show', () => {
    const producers = new Set(
      [
        turnAttribution('c-1').consumer,
        turnAttribution('c-1', 'workflow').consumer,
        turnAttribution('task:t-1').consumer,
        turnAttribution('workflow-replay:wf-1').consumer,
        turnAttribution('workflow-generation:wf-1').consumer,
        turnAttribution('external:k-1').consumer,
        // Produced at the call site rather than from a conversation id.
        'ai-debug' as const,
        'auto-repair' as const,
        'context-compaction' as const,
        'vision' as const,
      ].filter(Boolean),
    )
    expect(TOKEN_CONSUMERS.filter((consumer) => !producers.has(consumer))).toEqual([])
  })
})

describe('buildRecord', () => {
  const data = new Map<string, unknown>()

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
        session: {
          async get() {
            return {}
          },
          async set() {},
          async remove() {},
        },
      },
      runtime: { sendMessage: async () => ({}) },
    })
  })

  afterEach(() => {
    setUsageObserver(null)
    vi.unstubAllGlobals()
  })

  it('names a chat row from the conversation title', async () => {
    await touchConversation('c-1', 'Debug the login form')
    const record = await buildRecord(
      { attribution: turnAttribution('c-1'), model: 'gpt-test', usage: usage(10, 4) },
      1_700_000_000_000,
    )
    expect(record).toMatchObject({
      at: 1_700_000_000_000,
      consumer: 'chat',
      entityKey: 'chat:c-1',
      entityLabel: 'Debug the login form',
      model: 'gpt-test',
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    })
  })

  it('keeps the caller-snapshot label for a workflow and falls back to the key', async () => {
    const named = await buildRecord(
      {
        attribution: {
          ...turnAttribution('workflow-replay:wf-1'),
          entityLabel: 'Nightly crawl',
        },
        model: 'gpt-test',
        usage: usage(1, 1),
      },
      1,
    )
    expect(named.entityLabel).toBe('Nightly crawl')

    const unknown = await buildRecord(
      { attribution: turnAttribution('task:gone'), model: 'gpt-test', usage: usage(1, 1) },
      1,
    )
    expect(unknown.entityLabel).toBe('task:gone')
  })

  it('names an unlabelled task or workflow row from its own store', async () => {
    data.set('scheduledTasks', [{ ...createDraft({ name: 'Nightly PR digest' }), id: 't-9' }])
    data.set('workflows', [{ id: 'wf-9', name: 'Crawl the shop' }])
    const task = await buildRecord(
      { attribution: turnAttribution('task:t-9'), model: 'gpt-test', usage: usage(1, 1) },
      1,
    )
    expect(task.entityLabel).toBe('Nightly PR digest')
    const workflow = await buildRecord(
      {
        attribution: turnAttribution('workflow-replay:wf-9'),
        model: 'gpt-test',
        usage: usage(1, 1),
      },
      1,
    )
    expect(workflow.entityLabel).toBe('Crawl the shop')
  })

  it('writes one record per observed request through the installed sink', async () => {
    installTokenAccounting()
    observeUsage({ attribution: turnAttribution('c-1'), model: 'gpt-test' }, usage(10, 4))
    observeUsage({ attribution: turnAttribution('c-1'), model: 'gpt-test' }, usage(20, 8))
    await vi.waitFor(async () => {
      const { records } = await readTokenUsage()
      expect(records).toHaveLength(2)
    })

    const { records, daily } = await readTokenUsage()
    // Two tool rounds of one turn are two records of per-request usage; a
    // cumulative snapshot would have made the second one 42 tokens.
    expect(records.map((record) => record.totalTokens)).toEqual([28, 14])
    expect(Object.values(daily)[0]?.totals.requests).toBe(2)
  })

  it('ignores unattributed requests and survives a throwing sink', () => {
    const seen: UsageEvent[] = []
    setUsageObserver((event) => {
      if (seen.length === 1) throw new Error('sink is broken')
      seen.push(event)
    })

    expect(() => observeUsage({ model: 'gpt-test' }, usage(1, 1))).not.toThrow()
    expect(seen).toEqual([])

    expect(() =>
      observeUsage({ attribution: turnAttribution('c-1'), model: 'gpt-test' }, usage(1, 1)),
    ).not.toThrow()
    expect(() =>
      observeUsage({ attribution: turnAttribution('c-1'), model: 'gpt-test' }, usage(1, 1)),
    ).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})

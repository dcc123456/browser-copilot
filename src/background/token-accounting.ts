/**
 * Token accounting sink for the service worker.
 *
 * Installs the one observer that turns every attributed LLM completion into a
 * ledger record (see `specs/2026-10-12-token-usage-dashboard-design.md` §4.2):
 * call sites only declare what a request is for, and this module owns the
 * storage semantics — so no feature can invent its own counting rule.
 *
 * Records are flushed per request rather than batched. A batch is cheaper to
 * write, but an MV3 worker can be evicted between any two events, and silently
 * losing the spend of a turn that already cost the user money is exactly the
 * failure this dashboard must not have.
 *
 * @module background/token-accounting
 */

import { setUsageObserver, type UsageEvent } from '../lib/llm'
import {
  entityKeyFor,
  recordOf,
  type TokenAttribution,
  type TokenConsumer,
  type TokenUsageRecord,
} from '../lib/token-ledger'
import { getConversationMeta, newId, recordTokenUsage } from '../lib/storage'
import type { AgentMode } from '../lib/types'

/** Conversation-id prefixes that identify who started an unattended turn. */
const TURN_CONSUMERS: {
  prefix: string
  consumer: TokenConsumer
  entity: 'task' | 'workflow' | 'external' | 'chat'
}[] = [
  { prefix: 'task:', consumer: 'scheduled-task', entity: 'task' },
  { prefix: 'workflow-replay:', consumer: 'workflow-run', entity: 'workflow' },
  { prefix: 'workflow-ai-agent:', consumer: 'workflow-run', entity: 'workflow' },
  { prefix: 'workflow-generation:', consumer: 'workflow-generation', entity: 'workflow' },
  { prefix: 'external:', consumer: 'external-api', entity: 'external' },
  { prefix: 'feishu:', consumer: 'external-api', entity: 'external' },
]

/**
 * Attributes one agent turn from its bounding conversation id and autonomy
 * mode.
 *
 * The synthetic conversation ids unattended runs already use (`task:<id>`,
 * `workflow-replay:<id>`, …) are the attribution source of truth — re-deriving
 * it from a new context object would let the two drift apart.
 */
export function turnAttribution(conversationId: string, mode?: AgentMode): TokenAttribution {
  const match = TURN_CONSUMERS.find((entry) => conversationId.startsWith(entry.prefix))
  if (match) {
    return {
      consumer: match.consumer,
      entityKey: entityKeyFor(match.entity, conversationId.slice(match.prefix.length)),
    }
  }
  return {
    consumer: mode === 'workflow' ? 'workflow-generation' : 'chat',
    entityKey: entityKeyFor('chat', conversationId),
  }
}

/** Conversation titles are re-read at most this often while a thread streams. */
const LABEL_TTL_MS = 60_000

/**
 * entityKey → resolved display name. A turn fires one request per tool round,
 * and each would otherwise re-read the conversation metadata.
 */
const labelCache = new Map<string, { label: string; at: number }>()

/**
 * Display name for an attribution: the caller's snapshot when it has one
 * (workflows and tasks hold their own name), else the conversation title.
 * Falls back to the entity key so an unresolvable id still yields a readable row.
 */
async function resolveLabel(attribution: TokenAttribution): Promise<string> {
  if (attribution.entityLabel?.trim()) return attribution.entityLabel.trim()
  const cached = labelCache.get(attribution.entityKey)
  if (cached && Date.now() - cached.at < LABEL_TTL_MS) return cached.label
  let label = attribution.entityKey
  if (attribution.entityKey.startsWith('chat:')) {
    const id = attribution.entityKey.slice('chat:'.length)
    try {
      label = (await getConversationMeta(id))?.title ?? label
    } catch {
      // A storage read that fails must not drop the spend — keep the raw key.
    }
  }
  labelCache.set(attribution.entityKey, { label, at: Date.now() })
  return label
}

/** Builds the ledger record for one observed completion. */
export async function buildRecord(event: UsageEvent, at = Date.now()): Promise<TokenUsageRecord> {
  return recordOf(event.usage, {
    id: newId(),
    at,
    consumer: event.attribution.consumer,
    entityKey: event.attribution.entityKey,
    entityLabel: await resolveLabel(event.attribution),
    model: event.model,
  })
}

/** Writes every attributed completion into the durable ledger. */
export function installTokenAccounting(): void {
  setUsageObserver((event) => {
    void buildRecord(event)
      .then((record) => recordTokenUsage([record]))
      .catch((error) => {
        console.warn('[token-accounting] could not persist usage', error)
      })
  })
}

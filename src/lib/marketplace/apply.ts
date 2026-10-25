/**
 * Turning a marketplace card into a local workflow record.
 *
 * Applying is a write into the user's own library, so it re-validates the
 * published JSON through the same normaliser storage uses and never trusts the
 * remote `id`. Updating keeps everything local that identifies the workflow for
 * the user (id, folder, creation time) and replaces the executable parts.
 *
 * @module lib/marketplace/apply
 */

import { newId } from '../storage'
import { commitWorkflowRevision } from '../workflow/workflow-revision'
import { migrateWorkflow } from '../workflow/migrate'
import { asWorkflow } from '../workflow/storage'
import type { Workflow, WorkflowMarketplaceRef } from '../workflow/types'
import { needsUpdate } from './meta'
import { MARKETPLACE_REPO_FULL, MarketplaceError, type MarketplaceCard } from './types'

export type ApplyStatus = 'new' | 'update' | 'up-to-date'

export interface ApplyPlan {
  status: ApplyStatus
  /** The record to save; identical to `existing` for `up-to-date`. */
  workflow: Workflow
}

/** Local workflow installed from `slug`, if any. */
export function findInstalled(workflows: readonly Workflow[], slug: string): Workflow | undefined {
  return workflows.find((workflow) => workflow.marketplace?.slug === slug)
}

/**
 * Workflow id → the catalog card its installed copy has not caught up with.
 *
 * The published version is the only comparison: a local edit does not make a
 * workflow stale, it is what an update is about to overwrite, and a workflow
 * that was never installed has nothing to update.
 */
export function pendingUpdates(
  workflows: readonly Workflow[],
  cards: readonly MarketplaceCard[],
): Record<string, MarketplaceCard> {
  const bySlug = new Map(cards.map((card) => [card.meta.slug, card]))
  const updates: Record<string, MarketplaceCard> = {}
  for (const workflow of workflows) {
    const card = workflow.marketplace ? bySlug.get(workflow.marketplace.slug) : undefined
    if (card && needsUpdate(card.meta, workflow.marketplace)) updates[workflow.id] = card
  }
  return updates
}

function marketplaceRef(card: MarketplaceCard, appliedAt: number): WorkflowMarketplaceRef {
  return {
    repo: MARKETPLACE_REPO_FULL,
    slug: card.meta.slug,
    version: card.meta.version,
    hash: card.meta.hash,
    author: card.meta.author,
    appliedAt,
  }
}

/**
 * Builds the local record for a card.
 *
 * `published` is the decoded `workflow.json`; invalid content throws instead of
 * producing a half-imported workflow. `existing` is the local copy found by
 * slug (not by id) — its presence is what makes the operation an update.
 */
export function planApply(
  card: MarketplaceCard,
  published: unknown,
  existing: Workflow | undefined,
  now = Date.now(),
): ApplyPlan {
  const raw = asWorkflow(published)
  if (!raw) throw new MarketplaceError('invalid', 'The published workflow is not readable')
  const incoming = migrateWorkflow(raw)
  const ref = marketplaceRef(card, now)

  if (existing) {
    if (existing.marketplace && existing.marketplace.version >= card.meta.version) {
      return { status: 'up-to-date', workflow: existing }
    }
    return {
      status: 'update',
      workflow: {
        ...existing,
        name: incoming.name,
        ...(incoming.description !== undefined
          ? { description: incoming.description }
          : { description: undefined }),
        drawflow: incoming.drawflow,
        // An update replaces the launch rule: keeping a local schedule while
        // the published graph has none would arm third-party code by itself.
        trigger: incoming.trigger ? { ...incoming.trigger, enabled: false } : undefined,
        settings: incoming.settings,
        marketplace: ref,
        updatedAt: now,
        ...commitWorkflowRevision(existing, { source: 'marketplace-update', at: now }),
      },
    }
  }

  return {
    status: 'new',
    workflow: {
      id: newId(),
      name: incoming.name,
      ...(incoming.description !== undefined ? { description: incoming.description } : {}),
      createdAt: now,
      updatedAt: now,
      drawflow: incoming.drawflow,
      ...(incoming.trigger ? { trigger: { ...incoming.trigger, enabled: false } } : {}),
      settings: incoming.settings,
      marketplace: ref,
      revision: 1,
      revisionHistory: [{ revision: 1, updatedAt: now, source: 'marketplace' }],
    },
  }
}

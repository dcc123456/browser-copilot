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
import type { PasswordEntry } from '../types'
import { commitWorkflowRevision } from '../workflow/workflow-revision'
import { migrateWorkflow } from '../workflow/migrate'
import { asWorkflow } from '../workflow/storage'
import type { Workflow, WorkflowMarketplaceRef } from '../workflow/types'
import { rewriteWorkflowCalls } from './dependencies'
import { dependencyFile, needsUpdate } from './meta'
import { planSecretImport, rewriteWorkflowSecrets } from './secrets'
import {
  MARKETPLACE_REPO_FULL,
  MarketplaceError,
  type MarketplaceCard,
  type MarketplaceDependency,
} from './types'

export type ApplyStatus = 'new' | 'update' | 'up-to-date'

export interface ApplyPlan {
  status: ApplyStatus
  /** The record to save; identical to `existing` for `up-to-date`. */
  workflow: Workflow
}

/** One called workflow as it was fetched from the bundle. */
export interface PublishedDependency {
  entry: MarketplaceDependency
  /** Decoded dependency file. */
  published: unknown
}

export interface BundlePlan extends ApplyPlan {
  /** Dependency records to save BEFORE the parent; empty when up-to-date. */
  dependencies: Workflow[]
  /**
   * Vault entries to save BEFORE the workflows: every `get-secret` step points
   * at these ids, so saving a workflow first would leave it unusable.
   */
  credentials: PasswordEntry[]
}

/**
 * Local workflow installed from `slug` in `repo`, if any.
 *
 * The repository is part of the identity: the team repo and the public
 * marketplace may both publish a workflow with the same slug, and they must
 * not be treated as the same listing.
 */
export function findInstalled(
  workflows: readonly Workflow[],
  slug: string,
  repo: string = MARKETPLACE_REPO_FULL,
): Workflow | undefined {
  return workflows.find(
    (workflow) => workflow.marketplace?.slug === slug && workflow.marketplace.repo === repo,
  )
}

/**
 * Workflow id → the catalog card its installed copy has not caught up with.
 *
 * A newer published version, or a changed hash at the same version, makes a
 * copy stale. A local edit does not: that is what an update is about to
 * overwrite, and a workflow that was never installed has nothing to update.
 * Copies from another repository are skipped: `cards` comes from one source.
 */
export function pendingUpdates(
  workflows: readonly Workflow[],
  cards: readonly MarketplaceCard[],
  repo: string = MARKETPLACE_REPO_FULL,
): Record<string, MarketplaceCard> {
  const bySlug = new Map(cards.map((card) => [card.meta.slug, card]))
  const updates: Record<string, MarketplaceCard> = {}
  for (const workflow of workflows) {
    const ref = workflow.marketplace
    if (!ref || ref.repo !== repo) continue
    const card = bySlug.get(ref.slug)
    if (card && needsUpdate(card.meta, ref)) updates[workflow.id] = card
  }
  return updates
}

/**
 * Workflow ids whose published slug is absent from a complete catalog.
 *
 * Only a complete, non-truncated snapshot can prove absence: a capped list or
 * a stale fallback would mark live workflows as removed. An unpublished source
 * changes nothing locally — the copy keeps working, it just stops receiving
 * updates.
 */
export function removedSources(
  workflows: readonly Workflow[],
  cards: readonly MarketplaceCard[],
  complete: boolean,
  repo: string = MARKETPLACE_REPO_FULL,
): Set<string> {
  const removed = new Set<string>()
  if (!complete) return removed
  const slugs = new Set(cards.map((card) => card.meta.slug))
  for (const workflow of workflows) {
    const ref = workflow.marketplace
    if (ref && ref.repo === repo && !slugs.has(ref.slug)) {
      removed.add(workflow.id)
    }
  }
  return removed
}

function marketplaceRef(
  card: MarketplaceCard,
  appliedAt: number,
  repo: string,
): WorkflowMarketplaceRef {
  return {
    repo,
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
  repo: string = MARKETPLACE_REPO_FULL,
): ApplyPlan {
  const raw = asWorkflow(published)
  if (!raw) throw new MarketplaceError('invalid', 'The published workflow is not readable')
  const incoming = migrateWorkflow(raw)
  const ref = marketplaceRef(card, now, repo)

  if (existing) {
    if (existing.marketplace && !needsUpdate(card.meta, existing.marketplace)) {
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

/**
 * Local id for a bundled dependency.
 *
 * Derived from the listing namespace and the dep file so a re-apply rewrites
 * the same copy instead of accumulating duplicates, and so two listings that
 * call the same workflow keep independent copies.
 */
export function bundleDependencyId(namespace: string, path: string): string {
  return `mkt-${namespace}-${dependencyFile(path) ?? 'workflow'}`
}

/**
 * Builds the parent record and the dependency records a bundle needs.
 *
 * Calls are rewritten to the ids this install is about to use, which is what
 * makes a published `execute-workflow` step work on someone else's machine.
 * `library` is the installed library, used to find a dependency copy from a
 * previous version so it is replaced rather than duplicated. `credentials` is
 * the local vault, used to reuse values the user already filled in instead of
 * overwriting them with the published defaults.
 */
export function planApplyBundle(
  card: MarketplaceCard,
  published: unknown,
  dependencies: readonly PublishedDependency[],
  library: readonly Workflow[],
  existing: Workflow | undefined,
  now = Date.now(),
  credentials: readonly PasswordEntry[] = [],
  repo: string = MARKETPLACE_REPO_FULL,
): BundlePlan {
  const declared = card.meta.dependencies ?? []
  if (declared.length !== dependencies.length) {
    throw new MarketplaceError('invalid', 'The published bundle is incomplete')
  }

  // Two sources may publish the same slug (a workflow shared both publicly and
  // to a team). The namespace keeps their bundled ids and imported credentials
  // apart; the public source keeps its historical ids unchanged.
  const namespace =
    repo === MARKETPLACE_REPO_FULL
      ? card.meta.slug
      : `${repo.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${card.meta.slug}`

  const ids = new Map<string, string>()
  for (const dependency of dependencies) {
    const declaredEntry = declared.find(
      (entry) => entry.id === dependency.entry.id && entry.path === dependency.entry.path,
    )
    if (!declaredEntry) {
      throw new MarketplaceError('invalid', 'A bundled workflow is not listed in meta.json')
    }
    ids.set(dependency.entry.id, bundleDependencyId(namespace, dependency.entry.path))
  }

  const parent = asWorkflow(published)
  if (!parent) throw new MarketplaceError('invalid', 'The published workflow is not readable')
  const imported = planSecretImport(namespace, card.meta.secrets, credentials, now)
  const plan = planApply(
    card,
    rewriteWorkflowSecrets(rewriteWorkflowCalls(parent, ids), imported.idMap),
    existing,
    now,
    repo,
  )
  if (plan.status === 'up-to-date') {
    return { ...plan, dependencies: [], credentials: [] }
  }

  const installedById = new Map(library.map((workflow) => [workflow.id, workflow]))
  const records: Workflow[] = dependencies.map((dependency): Workflow => {
    const raw = asWorkflow(dependency.published)
    if (!raw) {
      throw new MarketplaceError(
        'invalid',
        `The bundled workflow "${dependency.entry.name}" is not readable`,
      )
    }
    const incoming = rewriteWorkflowSecrets(
      rewriteWorkflowCalls(migrateWorkflow(raw), ids),
      imported.idMap,
    )
    const id = ids.get(dependency.entry.id)!
    const current = installedById.get(id)
    const trigger = incoming.trigger ? { ...incoming.trigger, enabled: false } : undefined
    if (current) {
      return {
        ...current,
        name: incoming.name,
        ...(incoming.description !== undefined
          ? { description: incoming.description }
          : { description: undefined }),
        drawflow: incoming.drawflow,
        trigger,
        settings: incoming.settings,
        updatedAt: now,
        ...commitWorkflowRevision(current, { source: 'marketplace-update', at: now }),
      }
    }
    return {
      id,
      name: incoming.name,
      ...(incoming.description !== undefined ? { description: incoming.description } : {}),
      createdAt: now,
      updatedAt: now,
      drawflow: incoming.drawflow,
      ...(trigger ? { trigger } : {}),
      settings: incoming.settings,
      revision: 1,
      revisionHistory: [{ revision: 1, updatedAt: now, source: 'marketplace' }],
    }
  })

  return { ...plan, dependencies: records, credentials: imported.entries }
}

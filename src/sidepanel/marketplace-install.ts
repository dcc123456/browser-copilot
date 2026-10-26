/**
 * The one write path a marketplace card takes into the local library.
 *
 * Both surfaces (the marketplace tab and the Workflows tab's update button)
 * go through here so "fetch the published files, validate them, plan, save"
 * cannot drift: a stale card that resolves to `up-to-date` must not rewrite the
 * local record, and a missing file must fail loudly instead of saving nothing.
 *
 * A listing may carry the workflows it calls. They are fetched and planned
 * before anything is written, so a bundle never lands half-installed, and the
 * dependencies are saved first — the parent's steps point at them.
 *
 * @module sidepanel/marketplace-install
 */

import {
  planApplyBundle,
  type ApplyPlan,
  type BundlePlan,
  type PublishedDependency,
} from '../lib/marketplace/apply'
import { assetRepoPath } from '../lib/marketplace/meta'
import { fetchPublishedWorkflow, fetchWorkflowAt } from '../lib/marketplace/raw'
import { MarketplaceError, type MarketplaceCard } from '../lib/marketplace/types'
import type { Workflow } from '../lib/workflow/types'
import { sendCommand } from '../lib/messages'

/**
 * Finds the group called `name`, creating it when absent.
 *
 * The worker answers each request with its own result type; the mismatched
 * branches cannot be reached and exist only to narrow that union.
 */
async function groupNamed(name: string): Promise<string> {
  const listing = await sendCommand({ type: 'workflowGroups.list' })
  if (listing.type !== 'workflowGroups.list') throw new Error('Unexpected group listing')
  const existing = listing.groups.find((group) => group.name === name)
  if (existing) return existing.id
  const saved = await sendCommand({ type: 'workflowGroups.save', name })
  if (saved.type !== 'workflowGroups.save') throw new Error('Unexpected group save')
  return saved.group.id
}

/**
 * Files a newly installed bundle into a group named after its parent workflow.
 *
 * The group id goes into the records before they are saved, so a failed save
 * leaves no half-filed bundle behind and a retry finds the same group instead
 * of creating a second one. An existing group with that name is reused, so
 * applying another bundle from the same author lands together.
 *
 * An update is exempt: re-applying must not pull a workflow back into a group
 * the user moved it out of.
 */
async function fileIntoBundleGroup(plan: BundlePlan): Promise<BundlePlan> {
  if (plan.status !== 'new' || plan.dependencies.length === 0) return plan
  const name = plan.workflow.name.trim()
  if (!name) return plan

  const groupId = await groupNamed(name)
  return {
    ...plan,
    workflow: { ...plan.workflow, folderId: groupId },
    dependencies: plan.dependencies.map((dependency) => ({ ...dependency, folderId: groupId })),
  }
}

export async function installFromCard(
  card: MarketplaceCard,
  existing: Workflow | undefined,
  library: readonly Workflow[],
): Promise<ApplyPlan> {
  const published = await fetchPublishedWorkflow(card.meta.slug)
  if (published === null) {
    throw new MarketplaceError('not-found', `The published file for ${card.meta.slug} is missing`)
  }
  const dependencies = await Promise.all(
    (card.meta.dependencies ?? []).map(async (entry): Promise<PublishedDependency> => {
      const body = await fetchWorkflowAt(assetRepoPath(card.meta.slug, entry.path))
      if (body === null) {
        throw new MarketplaceError('not-found', `The bundled workflow "${entry.name}" is missing`)
      }
      return { entry, published: body }
    }),
  )
  const plan = await fileIntoBundleGroup(
    planApplyBundle(card, published, dependencies, library, existing),
  )
  for (const dependency of plan.dependencies) {
    await sendCommand({ type: 'workflows.save', workflow: dependency })
  }
  if (plan.status !== 'up-to-date') {
    await sendCommand({ type: 'workflows.save', workflow: plan.workflow })
  }
  return plan
}

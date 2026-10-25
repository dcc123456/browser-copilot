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

import { planApplyBundle, type ApplyPlan, type PublishedDependency } from '../lib/marketplace/apply'
import { assetRepoPath } from '../lib/marketplace/meta'
import { fetchPublishedWorkflow, fetchWorkflowAt } from '../lib/marketplace/raw'
import { MarketplaceError, type MarketplaceCard } from '../lib/marketplace/types'
import type { Workflow } from '../lib/workflow/types'
import { sendCommand } from '../lib/messages'

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
  const plan = planApplyBundle(card, published, dependencies, library, existing)
  for (const dependency of plan.dependencies) {
    await sendCommand({ type: 'workflows.save', workflow: dependency })
  }
  if (plan.status !== 'up-to-date') {
    await sendCommand({ type: 'workflows.save', workflow: plan.workflow })
  }
  return plan
}

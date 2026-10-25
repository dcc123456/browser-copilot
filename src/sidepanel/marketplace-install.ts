/**
 * The one write path a marketplace card takes into the local library.
 *
 * Both surfaces (the marketplace tab and the Workflows tab's update button)
 * go through here so "fetch the published file, validate it, plan, save" cannot
 * drift: a stale card that resolves to `up-to-date` must not rewrite the local
 * record, and a missing file must fail loudly instead of saving nothing.
 *
 * @module sidepanel/marketplace-install
 */

import { planApply, type ApplyPlan } from '../lib/marketplace/apply'
import { fetchPublishedWorkflow } from '../lib/marketplace/raw'
import { MarketplaceError, type MarketplaceCard } from '../lib/marketplace/types'
import type { Workflow } from '../lib/workflow/types'
import { sendCommand } from '../lib/messages'

export async function installFromCard(
  card: MarketplaceCard,
  existing: Workflow | undefined,
): Promise<ApplyPlan> {
  const published = await fetchPublishedWorkflow(card.meta.slug)
  if (published === null) {
    throw new MarketplaceError('not-found', `The published file for ${card.meta.slug} is missing`)
  }
  const plan = planApply(card, published, existing)
  if (plan.status !== 'up-to-date') {
    await sendCommand({ type: 'workflows.save', workflow: plan.workflow })
  }
  return plan
}

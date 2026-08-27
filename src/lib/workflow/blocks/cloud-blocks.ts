/**
 * Cloud-only Automa blocks that Browser Copilot does not implement.
 *
 * These blocks depend on Automa's cloud services (OAuth, hosted packages,
 * AI-workflow backend) and are intentionally **hidden from the block
 * palette**. They remain in the generated catalog (flagged `cloud: true`) so
 * that old workflows importing them can be detected and reported with a clear
 * "unsupported" error at edit/run time instead of failing silently.
 *
 * @module lib/workflow/blocks/cloud-blocks
 */

export const CLOUD_BLOCK_IDS = [
  'ai-workflow',
  'block-package',
  'google-sheets',
  'google-sheets-drive',
  'google-drive',
] as const

/** Whether a block id refers to a cloud-only (unsupported) block. */
export function isCloudBlock(id: string): boolean {
  return (CLOUD_BLOCK_IDS as readonly string[]).includes(id)
}

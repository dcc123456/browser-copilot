/**
 * Public documentation URL for a palette operator.
 *
 * The docs site renders one page per palette category with a stable
 * `#operator-<id>` anchor per operator (see `docs/workflow/`), so the editor
 * can deep-link the block it is configuring without a per-operator table.
 * Cloud blocks have no section in the reference, hence `undefined`.
 *
 * @module lib/workflow/docs-links
 */

import { BLOCK_BY_ID } from './blocks/palette'
import type { BlockCategory } from './blocks/types'

const DOCS_BASE = 'https://dcc123456.github.io/browser-copilot/docs'

const CATEGORY_PAGE: Partial<Record<BlockCategory, string>> = {
  interaction: 'operators-interaction',
  browser: 'operators-browser',
  general: 'operators-general',
  data: 'operators-data',
  conditions: 'operators-conditions',
}

/** Deep link to the operator's section, or `undefined` when it is not documented. */
export function operatorDocsUrl(blockId: string, locale: 'en' | 'zh'): string | undefined {
  const block = BLOCK_BY_ID.get(blockId)
  const page = block ? CATEGORY_PAGE[block.category] : undefined
  if (!page) return undefined
  const suffix = locale === 'zh' ? '-zh' : ''
  return `${DOCS_BASE}/${page}${suffix}.html#operator-${blockId}`
}

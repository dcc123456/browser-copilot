/**
 * 面向调色板的目录选择器。
 *
 * 目录包含全部块（含被隐藏的云端块）；编辑器/调色板消费的是此处过滤、
 * 排序后的视图，云端块因此不会出现在界面中。
 *
 * @module lib/workflow/blocks/palette
 */

import { BLOCK_CATALOG, CATEGORY_META } from './catalog'
import { CUSTOM_BLOCKS } from './custom'
import type { BlockCategory, BlockCatalogEntry } from './types'

/**
 * 调色板中展示、可插入画布的块：目录中所有非云端块，加上 Browser Copilot
 * 自有的扩展块（见 `custom.ts`）。云端块保持隐藏。
 */
export const PALETTE_BLOCKS: BlockCatalogEntry[] = [
  ...BLOCK_CATALOG.filter((b) => !b.cloud),
  ...CUSTOM_BLOCKS,
]

/** 按块 id 查询调色板块（云端块有意不包含在内）。 */
export const BLOCK_BY_ID: Map<string, BlockCatalogEntry> = new Map(
  PALETTE_BLOCKS.map((b) => [b.id, b]),
)

/**
 * 全量目录查询，含云端块（用于识别不受支持的 id，以及在迁移期间解析显示名）。
 * 扩展块同样合并进来，因此诸如 `ai-agent` 的 id 也能像任何目录块一样解析。
 */
export const CATALOG_BY_ID: Map<string, BlockCatalogEntry> = new Map([
  ...BLOCK_CATALOG.map((b) => [b.id, b] as const),
  ...CUSTOM_BLOCKS.map((b) => [b.id, b] as const),
])

/** 分类展示顺序，对应调色板的分组顺序。 */
const CATEGORY_ORDER: BlockCategory[] = [
  'general',
  'browser',
  'interaction',
  'data',
  'conditions',
  'onlineServices',
  'package',
]

/** 当前至少包含一个调色板块的分类，按展示顺序排列。 */
export const PALETTE_CATEGORIES: BlockCategory[] = CATEGORY_ORDER.filter((cat) =>
  PALETTE_BLOCKS.some((b) => b.category === cat),
)

/** 按分类分组的调色板块（有序，空分类被省略）。 */
export function blocksByCategory(): { category: BlockCategory; blocks: BlockCatalogEntry[] }[] {
  return PALETTE_CATEGORIES.map((category) => ({
    category,
    blocks: PALETTE_BLOCKS.filter((b) => b.category === category),
  }))
}

export { CATEGORY_META }

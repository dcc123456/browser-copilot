/**
 * Block palette — React port of Automa's WorkflowBlockList.
 *
 * Blocks are grouped by category in collapsible sections; each block is a
 * 2-column card showing its icon and English name, draggable onto the canvas.
 * Pinned blocks (stored in localStorage) float to the top. Cloud blocks never
 * appear here (filtered out in PALETTE_BLOCKS).
 *
 * @module workflow-editor/sidebar/BlockPalette
 */

import { Info, Minus, Pin, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { blocksByCategory, CATEGORY_META } from '../../lib/workflow/blocks/palette'
import { OCR_SUPPORTED } from '../../lib/ocr-support'
import { BlockIcon } from '../../lib/workflow/blocks/icons'
import type { BlockCatalogEntry } from '../../lib/workflow/blocks/types'
import { useEditorLocale } from '../locale-context'

const PINNED_KEY = 'bc.palette.pinned'

function loadPinned(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function BlockCard({
  block,
  pinned,
  onTogglePin,
}: {
  block: BlockCatalogEntry
  pinned: boolean
  onTogglePin: () => void
}) {
  const { t, blockName } = useEditorLocale()
  // no-ocr build: OCR-only operators are shown grayed out and cannot be
  // dragged onto the canvas (Tailwind utilities — see ui/design-system.css).
  const ocrUnavailable = block.requiresOcr === true && !OCR_SUPPORTED
  return (
    <div
      className={`wf-palette-card ${
        ocrUnavailable ? 'cursor-not-allowed opacity-50 grayscale select-none' : ''
      }`}
      draggable={!ocrUnavailable}
      title={
        ocrUnavailable ? t('ocrUnavailable') : block.description || blockName(block.id, block.name)
      }
      style={{ ['--cat-color' as string]: `var(--cat-${block.category})` }}
      onDragStart={(e) => {
        if (ocrUnavailable) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData('application/workflow-block', block.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div className="wf-palette-card-hover">
        <a
          href={`https://docs.extension.automa.site/blocks/${block.id}.html`}
          target="_blank"
          rel="noreferrer"
          title="Docs"
          onClick={(e) => e.stopPropagation()}
        >
          <Info size={14} />
        </a>
        <span
          title={pinned ? 'Unpin block' : 'Pin block'}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
        >
          <Pin size={14} fill={pinned ? 'currentColor' : 'none'} />
        </span>
      </div>
      {block.tag && <div className="wf-palette-tag">{block.tag}</div>}
      <span className="wf-palette-card-icon">
        <BlockIcon icon={block.icon} size={20} />
      </span>
      <p>{blockName(block.id, block.name)}</p>
    </div>
  )
}

function CategorySection({
  categoryId,
  blocks,
  pinned,
  onTogglePin,
}: {
  categoryId: string
  blocks: BlockCatalogEntry[]
  pinned: string[]
  onTogglePin: (id: string) => void
}) {
  const { categoryName } = useEditorLocale()
  const [open, setOpen] = useState(true)
  const meta = CATEGORY_META[categoryId as keyof typeof CATEGORY_META]
  return (
    <div className="wf-palette-section">
      <button type="button" className="wf-palette-header" onClick={() => setOpen(!open)}>
        <span
          className="wf-palette-dot"
          style={{ ['--cat-dot' as string]: `var(--cat-${categoryId})` }}
        />
        <span className="wf-palette-title">
          {categoryName(categoryId, meta?.name ?? categoryId)}
        </span>
        {open ? <Minus size={14} /> : <Plus size={14} />}
      </button>
      {open && (
        <div className="wf-palette-grid">
          {blocks.map((b) => (
            <BlockCard
              key={b.id}
              block={b}
              pinned={pinned.includes(b.id)}
              onTogglePin={() => onTogglePin(b.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function BlockPalette() {
  const [pinned, setPinned] = useState<string[]>(loadPinned)
  const groups = useMemo(() => blocksByCategory(), [])

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      localStorage.setItem(PINNED_KEY, JSON.stringify(next))
      return next
    })
  }

  const pinnedBlocks = groups.flatMap((g) => g.blocks).filter((b) => pinned.includes(b.id))

  return (
    <div className="wf-sidebar-scroll">
      {pinnedBlocks.length > 0 && (
        <CategorySection
          categoryId="general"
          blocks={pinnedBlocks}
          pinned={pinned}
          onTogglePin={togglePin}
        />
      )}
      {groups.map((g) => (
        <CategorySection
          key={g.category}
          categoryId={g.category}
          blocks={g.blocks.filter((b) => !pinned.includes(b.id))}
          pinned={pinned}
          onTogglePin={togglePin}
        />
      ))}
    </div>
  )
}

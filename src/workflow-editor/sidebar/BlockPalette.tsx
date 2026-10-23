/**
 * Block palette — React port of Automa's WorkflowBlockList.
 *
 * Blocks are grouped by category in collapsible sections; each block is a
 * 2-column card showing its icon and English name, draggable onto the canvas.
 * Pinned blocks (stored in localStorage) float to the top. The search box above
 * the list filters across localized names/descriptions and raw ids; while a
 * query is active the results form one flat grid. Cloud blocks never appear
 * here (filtered out in PALETTE_BLOCKS).
 *
 * @module workflow-editor/sidebar/BlockPalette
 */

import { Info, Minus, Pin, Plus, Search } from 'lucide-react'
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
  const { t, bt, blockName, blockDesc: btDesc } = useEditorLocale()
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
        ocrUnavailable
          ? t('ocrUnavailable')
          : btDesc(block.id, block.description) || blockName(block.id, block.name)
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
          title={bt('Docs')}
          onClick={(e) => e.stopPropagation()}
        >
          <Info size={14} />
        </a>
        <span
          title={pinned ? bt('Unpin block') : bt('Pin block')}
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
  const { t, blockName, blockDesc } = useEditorLocale()
  const [pinned, setPinned] = useState<string[]>(loadPinned)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => blocksByCategory(), [])

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      localStorage.setItem(PINNED_KEY, JSON.stringify(next))
      return next
    })
  }

  const pinnedBlocks = groups.flatMap((g) => g.blocks).filter((b) => pinned.includes(b.id))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return []
    return groups
      .flatMap((g) => g.blocks)
      .filter((block) =>
        [
          block.id,
          block.name,
          block.description ?? '',
          blockName(block.id, block.name),
          blockDesc(block.id, block.description),
        ].some((field) => field.toLocaleLowerCase().includes(normalizedQuery)),
      )
  }, [blockDesc, blockName, groups, normalizedQuery])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-2 pt-1">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchBlocks')}
            aria-label={t('searchBlocks')}
            className="w-full rounded-lg border border-border bg-panel-2 py-1.5 pl-8 pr-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-7 pt-1">
        {normalizedQuery ? (
          searchResults.length > 0 ? (
            <div className="wf-palette-grid">
              {searchResults.map((block) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  pinned={pinned.includes(block.id)}
                  onTogglePin={() => togglePin(block.id)}
                />
              ))}
            </div>
          ) : (
            <p className="px-1 py-6 text-center text-sm text-muted">{t('noMatches')}</p>
          )
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}

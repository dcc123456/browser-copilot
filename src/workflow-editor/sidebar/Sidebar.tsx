/**
 * Editor sidebar — React port of Automa's resizable/collapsible editor panel.
 *
 * Hosts editor content on either side: the BLOCK PALETTE on the left (Automa's
 * block list) and workflow details / block edit forms / logs on the right. It
 * is collapsible and can be drag-resized from its inner edge; width persists
 * per side in localStorage.
 *
 * @module workflow-editor/sidebar/Sidebar
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const DEFAULT_WIDTH = 320
const MIN_WIDTH = 220
const MAX_WIDTH = 620

function widthKey(side: 'left' | 'right'): string {
  return side === 'left' ? 'bc.editor.paletteWidth' : 'bc.editor.sidebarWidth'
}

function loadWidth(side: 'left' | 'right'): number {
  const stored = Number(localStorage.getItem(widthKey(side)))
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH
}

export type SidebarView = 'details' | 'edit' | 'palette' | 'logs'

export default function Sidebar({
  open,
  width,
  onWidthChange,
  side = 'right',
  children,
}: {
  open: boolean
  width: number
  onWidthChange: (w: number) => void
  side?: 'left' | 'right'
  children: ReactNode
}) {
  const startX = useRef(0)
  const startW = useRef(width)
  const [dragging, setDragging] = useState(false)

  // Left panel grows when the drag moves right; right panel grows when it
  // moves left.
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const delta = e.clientX - startX.current
      const next =
        side === 'left'
          ? startW.current + delta
          : startW.current - delta
      onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
    },
    [onWidthChange, side],
  )
  const onMouseUp = useCallback(() => {
    setDragging(false)
    localStorage.setItem(widthKey(side), String(startW.current))
  }, [side])

  useEffect(() => {
    if (!dragging) return
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragging, onMouseMove, onMouseUp])

  if (!open) return null

  return (
    <aside className={`wf-sidebar wf-sidebar-${side}`} style={{ width }}>
      <div
        className={`wf-sidebar-drag wf-sidebar-drag-${side} ${dragging ? 'wf-sidebar-drag-active' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          startX.current = e.clientX
          startW.current = width
          setDragging(true)
        }}
      />
      <div className="wf-sidebar-content">{children}</div>
    </aside>
  )
}

export { loadWidth }

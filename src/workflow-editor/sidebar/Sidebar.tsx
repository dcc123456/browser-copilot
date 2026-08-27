/**
 * Right sidebar — React port of Automa's resizable/collapsible editor sidebar.
 *
 * Hosts three views (workflow details / block edit form / block palette), is
 * collapsible via the toolbar button, and can be drag-resized from its left
 * edge (Automa's custom-drag handle). Width persists in localStorage.
 *
 * @module workflow-editor/sidebar/Sidebar
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const WIDTH_KEY = 'bc.editor.sidebarWidth'
const DEFAULT_WIDTH = 320
const MIN_WIDTH = 240
const MAX_WIDTH = 560

function loadWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH
}

export type SidebarView = 'details' | 'edit' | 'palette' | 'logs'

export default function Sidebar({
  open,
  width,
  onWidthChange,
  children,
}: {
  open: boolean
  width: number
  onWidthChange: (w: number) => void
  children: ReactNode
}) {
  const startX = useRef(0)
  const startW = useRef(width)
  const [dragging, setDragging] = useState(false)

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, startW.current + (startX.current - e.clientX)),
      )
      onWidthChange(next)
    },
    [onWidthChange],
  )
  const onMouseUp = useCallback(() => {
    setDragging(false)
    localStorage.setItem(WIDTH_KEY, String(startW.current))
  }, [])

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
    <aside className="wf-sidebar" style={{ width }}>
      <div
        className={`wf-sidebar-drag ${dragging ? 'wf-sidebar-drag-active' : ''}`}
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

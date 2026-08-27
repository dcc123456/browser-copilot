/**
 * Bottom canvas controls — React port of Automa's EditorSearchBlocks (left)
 * and the zoom/fit controls (right).
 *
 * Search operates on the nodes already on the canvas (not the palette):
 * selecting a result centers that node and highlights it.
 *
 * @module workflow-editor/toolbar/CanvasControls
 */

import { useMemo, useState } from 'react'
import { useReactFlow, type Node } from '@xyflow/react'

export interface SearchTarget {
  id: string
  name: string
  description: string
  position: { x: number; y: number }
}

function SearchBlocks({ nodes }: { nodes: SearchTarget[] }) {
  const [active, setActive] = useState(false)
  const [query, setQuery] = useState('')
  const { getZoom, setCenter } = useReactFlow()

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return nodes.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.description.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q),
    )
  }, [query, nodes])

  const goTo = (n: SearchTarget) => {
    const zoom = getZoom()
    void setCenter(n.position.x + 120, n.position.y + 40, { zoom, duration: 300 })
    document
      .querySelectorAll('.wf-search-hit')
      .forEach((el) => el.classList.remove('wf-search-hit'))
    document.querySelector(`[data-id="${n.id}"]`)?.classList.add('wf-search-hit')
  }

  return (
    <div className="wf-search">
      <button
        type="button"
        className="wf-icon-btn"
        title="Search nodes (Ctrl+Shift+F)"
        onClick={() => setActive(!active)}
      >
        <i className="ri-search-2-line" />
      </button>
      {active && (
        <div className="wf-search-pop">
          <input
            autoFocus
            type="search"
            placeholder="Search nodes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <div className="wf-search-results">
              {results.length === 0 && <p className="wf-search-empty">No matches</p>}
              {results.slice(0, 8).map((n) => (
                <button key={n.id} type="button" onClick={() => goTo(n)}>
                  <span className="wf-search-name">{n.name}</span>
                  {n.description && <span className="wf-search-desc">{n.description}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <div className="wf-zoom">
      <button type="button" className="wf-icon-btn" title="Reset view" onClick={() => fitView({ duration: 200 })}>
        <i className="ri-fullscreen-line" />
      </button>
      <div className="wf-zoom-seg">
        <button type="button" className="wf-icon-btn" title="Zoom out" onClick={() => zoomOut()}>
          <i className="ri-subtract-line" />
        </button>
        <button type="button" className="wf-icon-btn" title="Zoom in" onClick={() => zoomIn()}>
          <i className="ri-add-line" />
        </button>
      </div>
    </div>
  )
}

export default function CanvasControls({ nodes }: { nodes: Node[] }) {
  const targets: SearchTarget[] = nodes.map((n) => {
    const data = n.data as unknown as {
      block?: { name?: string }
      blockData?: { description?: string }
      label?: string
    }
    return {
      id: n.id,
      name: data.label || data.block?.name || n.id,
      description: data.blockData?.description ?? '',
      position: n.position,
    }
  })
  return (
    <>
      <div className="wf-canvas-bottom wf-canvas-bottom-left">
        <SearchBlocks nodes={targets} />
      </div>
      <div className="wf-canvas-bottom wf-canvas-bottom-right">
        <ZoomControls />
      </div>
    </>
  )
}

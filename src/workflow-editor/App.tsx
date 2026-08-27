/**
 * Workflow editor (standalone popup window) — React port of Automa's editor
 * (newtab/pages/workflows/[id].vue + WorkflowEditor.vue).
 *
 * Layout: full-bleed React Flow canvas with left->right nodes; a floating top
 * toolbar (name card / tabs / save-run-record); search (bottom-left) and zoom
 * (bottom-right) controls; a MiniMap; and a resizable right sidebar that shows
 * the workflow details, the selected block's edit form, or the block palette.
 *
 * Node data uses the Automa shape: the catalog block's `data` defaults cloned
 * per node, plus `blockId`. Legacy workflows are migrated on load.
 *
 * @module workflow-editor/App
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  MiniMap,
  MarkerType,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { BLOCK_BY_ID } from '../lib/workflow/blocks/palette'
import { isCloudBlock } from '../lib/workflow/blocks/cloud-blocks'
import type { BlockCatalogEntry } from '../lib/workflow/blocks/types'
import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowSettings,
} from '../lib/workflow/types'
import { migrateWorkflow } from '../lib/workflow/migrate'
import { sendCommand } from '../lib/messages'
import { newId } from '../lib/storage'

import { nodeTypes, type BlockNodeData } from './flow/BlockNode'
import { edgeTypes } from './flow/CustomEdge'
import Sidebar, { loadWidth, type SidebarView } from './sidebar/Sidebar'
import BlockPalette from './sidebar/BlockPalette'
import BlockEditForm from './sidebar/BlockEditForm'
import WorkflowDetails, { type WorkflowMeta } from './sidebar/WorkflowDetails'
import TopToolbar, { type EditorTab } from './toolbar/TopToolbar'
import CanvasControls from './toolbar/CanvasControls'
import './editor.css'

const DEFAULT_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

type FlowNode = Node<BlockNodeData>

/** Build a React Flow node from a persisted workflow node. */
function toFlowNode(n: WorkflowNode): FlowNode {
  const blockId = (n.data.blockId as string) ?? n.label
  const block = BLOCK_BY_ID.get(blockId)
  const { blockId: _, ...blockData } = n.data as Record<string, unknown>
  return {
    id: n.id,
    type: blockId === 'note' ? 'NoteNode' : 'BlockNode',
    position: n.position,
    data: {
      block: block as BlockCatalogEntry,
      label: (n.data.description as string) || undefined,
      blockData: blockData as Record<string, unknown>,
    },
  }
}

/** Create a fresh node when a palette block is dropped. */
function newFlowNode(block: BlockCatalogEntry, position: { x: number; y: number }): FlowNode {
  return {
    id: newId(),
    type: block.id === 'note' ? 'NoteNode' : 'BlockNode',
    position,
    data: {
      block,
      blockData: { ...structuredClone(block.data), description: '' },
    },
  }
}

export default function EditorApp() {
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(loadWidth)
  const [view, setView] = useState<SidebarView>('details')
  const [tab, setTab] = useState<EditorTab>('editor')
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [recording, setRecording] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [meta, setMeta] = useState<WorkflowMeta>({
    name: 'New workflow',
    description: '',
    icon: 'ri-flow-chart',
    trigger: { type: 'manual', enabled: true },
    settings: DEFAULT_SETTINGS,
  })

  const reactFlow = useReactFlow()
  const loadedRef = useRef(false)

  // --- load -----------------------------------------------------------------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const editId = params.get('edit')
    if (editId) {
      void (async () => {
        const result = await sendCommand({ type: 'workflows.get', id: editId })
        if (result.type !== 'workflows.get' || !result.workflow) return
        const wf = migrateWorkflow(result.workflow)
        setWorkflowId(wf.id)
        setMeta((m) => ({
          ...m,
          name: wf.name,
          description: wf.description ?? '',
          trigger: wf.trigger ?? m.trigger,
          settings: wf.settings ?? m.settings,
        }))
        setNodes(wf.drawflow.nodes.map(toFlowNode))
        setEdges(
          wf.drawflow.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
            type: 'custom',
          })),
        )
        if (wf.drawflow.position && typeof wf.drawflow.zoom === 'number') {
          setTimeout(
            () =>
              reactFlow.setViewport({
                x: wf.drawflow.position?.x ?? 0,
                y: wf.drawflow.position?.y ?? 0,
                zoom: wf.drawflow.zoom ?? 1,
              }),
            0,
          )
        }
        loadedRef.current = true
      })()
    } else {
      setWorkflowId(newId())
      loadedRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // mark dirty on graph changes
  useEffect(() => {
    if (loadedRef.current) setDirty(true)
  }, [nodes, edges, meta])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((nds) => applyNodeChanges<FlowNode>(changes, nds))
    let next: string | null | undefined
    for (const c of changes) {
      if (c.type !== 'select') continue
      if (c.selected) next = c.id
      else if (next === undefined || next === c.id) next = null
    }
    if (next !== undefined) {
      setSelectedId(next)
      if (next) setView('edit')
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return
    setEdges((eds) => {
      if (eds.some((e) => e.target === conn.target && e.targetHandle === conn.targetHandle)) {
        return eds
      }
      return [
        ...eds,
        {
          id: newId(),
          source: conn.source,
          target: conn.target,
          sourceHandle: conn.sourceHandle,
          targetHandle: conn.targetHandle,
          type: 'custom',
        },
      ]
    })
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const blockId = event.dataTransfer.getData('application/workflow-block')
      if (!blockId) return
      const block = BLOCK_BY_ID.get(blockId)
      if (!block || isCloudBlock(blockId)) return
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setNodes((nds) => [...nds, newFlowNode(block, position)])
    },
    [reactFlow],
  )

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId), [nodes, selectedId])
  const selectedBlock = selectedNode?.data.block

  const patchSelected = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selectedId) return
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedId
            ? { ...n, data: { ...n.data, blockData: { ...n.data.blockData, ...patch } } }
            : n,
        ),
      )
    },
    [selectedId],
  )

  // --- save / run ------------------------------------------------------------
  const buildWorkflow = useCallback(async (): Promise<Workflow | null> => {
    if (!workflowId) return null
    const { x, y, zoom } = reactFlow.getViewport()
    const wfNodes: WorkflowNode[] = nodes.map((n) => ({
      id: n.id,
      label: n.data.block?.name ?? n.id,
      position: n.position,
      data: { ...n.data.blockData, blockId: n.data.block?.id ?? 'unknown' },
    }))
    const wfEdges: WorkflowEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
    }))
    return {
      id: workflowId,
      name: meta.name || 'Untitled workflow',
      description: meta.description,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      drawflow: { nodes: wfNodes, edges: wfEdges, position: { x, y }, zoom },
      trigger: meta.trigger,
      settings: meta.settings,
    }
  }, [workflowId, nodes, edges, meta, reactFlow])

  const handleSave = useCallback(async (): Promise<void> => {
    const wf = await buildWorkflow()
    if (!wf) return
    setSaving(true)
    setError(null)
    try {
      await sendCommand({ type: 'workflows.save', workflow: wf })
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [buildWorkflow])

  const handleRun = useCallback(async () => {
    if (!workflowId) return
    await handleSave()
    setRunning(true)
    try {
      const r = await sendCommand({ type: 'workflows.run', id: workflowId })
      if (r.type === 'workflows.run' && !r.outcome.ok) {
        setError(r.outcome.error ?? r.outcome.summary)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }, [workflowId, handleSave])

  const toggleRecording = useCallback(async () => {
    try {
      if (recording) {
        const r = await sendCommand({ type: 'record.stop' })
        setRecording(false)
        if (r.type === 'record.stop' && r.workflowId) {
          window.location.search = `?edit=${encodeURIComponent(r.workflowId)}`
          window.location.reload()
        }
      } else {
        await sendCommand({ type: 'record.start' })
        setRecording(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [recording])

  // --- keyboard shortcuts ----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void handleSave()
      } else if (mod && e.key === 'Enter') {
        e.preventDefault()
        void handleRun()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.querySelector<HTMLButtonElement>('.wf-search .wf-icon-btn')?.click()
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, handleRun])

  // highlight edges connected to the selected node
  const edgeWithHighlight = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        data: {
          ...(e.data as Record<string, unknown> | undefined),
          highlighted: selectedId ? e.source === selectedId || e.target === selectedId : false,
        },
      })),
    [edges, selectedId],
  )

  const sidebarContent =
    tab === 'logs' ? (
      <div className="wf-sidebar-scroll">
        <p className="wf-form-note">Run logs appear here after a run (see History tab).</p>
      </div>
    ) : view === 'palette' ? (
      <BlockPalette />
    ) : view === 'edit' && selectedNode && selectedBlock ? (
      <BlockEditForm
        block={selectedBlock}
        nodeName={String(selectedNode.data.blockData?.description ?? selectedBlock.name)}
        data={selectedNode.data.blockData}
        onChange={patchSelected}
        onBack={() => {
          setView('details')
          setSelectedId(null)
          setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
        }}
      />
    ) : (
      <WorkflowDetails
        meta={meta}
        onChange={(patch) => setMeta((m) => ({ ...m, ...patch }))}
      />
    )

  return (
    <div className="wf-editor">
      <ReactFlow
        nodes={nodes}
        edges={edgeWithHighlight}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onNodeDoubleClick={() => {
          if (selectedId) setView('edit')
        }}
        fitView
        deleteKeyCode="Delete"
        multiSelectionKeyCode="Control"
        defaultEdgeOptions={{
          type: 'custom',
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: 'var(--bc-edge)' },
        }}
      >
        <Background gap={16} color="var(--bc-border)" />
        <MiniMap
          pannable
          zoomable
          className="wf-minimap"
          nodeColor={(n) => {
            const block = (n.data as BlockNodeData).block
            return block ? `var(--cat-${block.category})` : 'var(--bc-border)'
          }}
          maskColor="rgba(0,0,0,0.08)"
          bgColor="var(--bc-bg-soft)"
        />
        <CanvasControls nodes={nodes} />
      </ReactFlow>

      <TopToolbar
        workflowName={meta.name}
        workflowIcon={meta.icon}
        tab={tab}
        onTabChange={setTab}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onTogglePalette={() => {
          setSidebarOpen(true)
          setView(view === 'palette' ? 'details' : 'palette')
        }}
        dirty={dirty}
        saving={saving}
        running={running}
        recording={recording}
        onSave={() => void handleSave()}
        onRun={() => void handleRun()}
        onToggleRecording={() => void toggleRecording()}
      />

      {error && <div className="wf-error-banner">{error}</div>}

      <Sidebar open={sidebarOpen && tab === 'editor'} width={sidebarWidth} onWidthChange={setSidebarWidth}>
        {sidebarContent}
      </Sidebar>
    </div>
  )
}

/**
 * Workflow editor (standalone popup window) — React port of Automa's editor.
 *
 * Layout: full-bleed React Flow canvas (left->right nodes); a BLOCK PALETTE
 * sidebar on the LEFT (Automa's block list), a DETAILS/EDIT/LOGS sidebar on
 * the RIGHT; a compact floating top toolbar (palette toggle + name /
 * editor-logs tabs / record-save-run); search (bottom-left) and zoom
 * (bottom-right) controls; and a MiniMap. Editor chrome is localized; block
 * names stay English.
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
  WorkflowTrigger,
  WorkflowSettings,
} from '../lib/workflow/types'
import { migrateWorkflow } from '../lib/workflow/migrate'
import { sendCommand } from '../lib/messages'
import { getSettings } from '../lib/storage'
import { newId } from '../lib/storage'

import { nodeTypes, type BlockNodeData } from './flow/BlockNode'
import { edgeTypes } from './flow/CustomEdge'
import Sidebar, { loadWidth } from './sidebar/Sidebar'
import BlockPalette from './sidebar/BlockPalette'
import BlockEditForm from './sidebar/BlockEditForm'
import WorkflowDetails from './sidebar/WorkflowDetails'
import EditorLogs from './sidebar/EditorLogs'
import TopToolbar, { type EditorTab } from './toolbar/TopToolbar'
import CanvasControls from './toolbar/CanvasControls'
import { useToast } from './toast'
import { makeTranslate, resolveEditorLocale } from './i18n'
import { EditorLocaleContext, makeEditorLocale, type EditorLocale as EditorLocaleValue } from './locale-context'
import './editor.css'

const DEFAULT_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

type FlowNode = Node<BlockNodeData>

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
  const [rightOpen, setRightOpen] = useState(true)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [rightWidth, setRightWidth] = useState(() => loadWidth('right'))
  const [paletteWidth, setPaletteWidth] = useState(() => loadWidth('left'))
  const [tab, setTab] = useState<EditorTab>('editor')
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [recording, setRecording] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorLocale, setEditorLocale] = useState<EditorLocaleValue>(() =>
    makeEditorLocale(resolveEditorLocale(undefined), makeTranslate(resolveEditorLocale(undefined))),
  )
  const t = editorLocale.t

  const toast = useToast()

  const [meta, setMeta] = useState<{
    name: string
    description: string
    icon: string
    trigger: WorkflowTrigger
    settings: WorkflowSettings
  }>({
    name: 'New workflow',
    description: '',
    icon: 'ri-flow-chart',
    trigger: { type: 'manual', enabled: true },
    settings: DEFAULT_SETTINGS,
  })

  const reactFlow = useReactFlow()
  const loadedRef = useRef(false)

  // Resolve language from the stored locale.
  useEffect(() => {
    void getSettings()
      .then((s) => {
        const loc = resolveEditorLocale((s as { locale?: string }).locale)
        setEditorLocale(makeEditorLocale(loc, makeTranslate(loc)))
      })
      .catch(() => {})
  }, [])

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
      if (next) {
        setTab('editor')
        setRightOpen(true)
      }
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return
    setEdges((eds) => {
      if (eds.some((e) => e.target === conn.target && e.targetHandle === conn.targetHandle)) return eds
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
      name: meta.name || t('untitled'),
      description: meta.description,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      drawflow: { nodes: wfNodes, edges: wfEdges, position: { x, y }, zoom },
      trigger: meta.trigger,
      settings: meta.settings,
    }
  }, [workflowId, nodes, edges, meta, reactFlow, t])

  const handleSave = useCallback(async (): Promise<void> => {
    const wf = await buildWorkflow()
    if (!wf) return
    setSaving(true)
    setError(null)
    try {
      await sendCommand({ type: 'workflows.save', workflow: wf })
      setDirty(false)
      toast.show(t('saved'), 'ok')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.show(`${t('saveFailed')}: ${msg}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [buildWorkflow, toast, t])

  const handleRun = useCallback(async () => {
    if (!workflowId) return
    await handleSave()
    setRunning(true)
    try {
      const r = await sendCommand({ type: 'workflows.run', id: workflowId })
      if (r.type === 'workflows.run') {
        if (r.outcome.ok) toast.show(t('runFinished'), 'ok')
        else {
          const msg = r.outcome.error ?? r.outcome.summary
          setError(msg)
          toast.show(`${t('runFailed')}: ${msg}`, 'error')
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.show(`${t('runFailed')}: ${msg}`, 'error')
    } finally {
      setRunning(false)
      setTab('logs')
      setRightOpen(true)
    }
  }, [workflowId, handleSave, toast, t])

  const toggleRecording = useCallback(async () => {
    try {
      if (recording) {
        const r = await sendCommand({ type: 'record.stop' })
        setRecording(false)
        toast.show(t('recordingStopped'), 'ok')
        if (r.type === 'record.stop' && r.workflowId) {
          window.location.search = `?edit=${encodeURIComponent(r.workflowId)}`
          window.location.reload()
        }
      } else {
        await sendCommand({ type: 'record.start' })
        setRecording(true)
        toast.show(t('recordingStarted'), 'info')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.show(`${t('recordStartFailed')}: ${msg}`, 'error')
    }
  }, [recording, toast, t])

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
        setRightOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, handleRun])

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

  const rightContent =
    tab === 'logs' ? (
      <EditorLogs workflowId={workflowId} t={t} />
    ) : selectedNode && selectedBlock ? (
      <BlockEditForm
        block={selectedBlock}
        nodeName={String(selectedNode.data.blockData?.description ?? selectedBlock.name)}
        data={selectedNode.data.blockData}
        onChange={patchSelected}
        t={t}
        onBack={() => {
          setSelectedId(null)
          setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
        }}
      />
    ) : (
      <WorkflowDetails meta={meta} onChange={(patch) => setMeta((m) => ({ ...m, ...patch }))} t={t} />
    )

  return (
    <EditorLocaleContext.Provider value={editorLocale}>
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
          if (selectedId) {
            setRightOpen(true)
            setTab('editor')
          }
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
        <CanvasControls nodes={nodes} t={t} />
      </ReactFlow>

      <TopToolbar
        workflowName={meta.name || t('untitled')}
        workflowIcon={meta.icon}
        tab={tab}
        onTabChange={setTab}
        sidebarOpen={rightOpen}
        paletteOpen={paletteOpen}
        onToggleSidebar={() => setRightOpen((o) => !o)}
        onTogglePalette={() => setPaletteOpen((o) => !o)}
        dirty={dirty}
        saving={saving}
        running={running}
        recording={recording}
        onSave={() => void handleSave()}
        onRun={() => void handleRun()}
        onToggleRecording={() => void toggleRecording()}
        t={t}
      />

      {error && <div className="wf-error-banner" onClick={() => setError(null)}>{error}</div>}
      {toast.node}

      {/* Left: block palette */}
      <Sidebar open={paletteOpen && tab === 'editor'} width={paletteWidth} onWidthChange={setPaletteWidth} side="left">
        <BlockPalette />
      </Sidebar>

      {/* Right: details / edit / logs */}
      <Sidebar open={rightOpen} width={rightWidth} onWidthChange={setRightWidth} side="right">
        {rightContent}
      </Sidebar>
    </div>
    </EditorLocaleContext.Provider>
  )
}

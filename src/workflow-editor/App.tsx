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
import BlockSettingsModal from './blocks/shared/BlockSettingsModal'
import LogsModal from './sidebar/LogsModal'
import { WorkflowMetaProvider } from './blocks/batchD/WorkflowInfoFields'
import TopToolbar from './toolbar/TopToolbar'
import CanvasControls from './toolbar/CanvasControls'
import { useToast } from './toast'
import { ToastHost } from '../ui/toast'
import { ConfirmHost } from '../ui/confirm'
import { makeTranslate, resolveEditorLocale } from './i18n'
import { EditorLocaleContext, makeEditorLocale, type EditorLocale as EditorLocaleValue } from './locale-context'
import { autoLayout } from './auto-layout'
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
  /** Node id whose block-settings modal is open (gear button in hover toolbar). */
  const [settingsForId, setSettingsForId] = useState<string | null>(null)
  /** Whether the run-logs / debug viewer modal is open. */
  const [logsOpen, setLogsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [paletteWidth, setPaletteWidth] = useState(() => loadWidth('left'))
  /** Node id being edited in the LEFT overlay (Automa: double-click opens the
   *  edit panel over the block palette; hidden while no node is being edited). */
  const [editingId, setEditingId] = useState<string | null>(null)
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
      const id = newId()
      setWorkflowId(id)
      // Seed every new workflow with a Trigger block (Automa always does): it is
      // where the workflow name, trigger type and run settings are edited.
      const triggerBlock = BLOCK_BY_ID.get('trigger')
      if (triggerBlock) {
        setNodes([newFlowNode(triggerBlock, { x: 120, y: 160 })])
      }
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

  // Double-clicking a connection removes it (matches Automa's edge behaviour).
  // Selecting the edge first and pressing Delete also works via the default
  // delete-key handling.
  const onEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id))
      toast.show(t('edgeDeleted'), 'info')
    },
    [toast, t],
  )

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

  // --- node hover-toolbar actions (Automa block-menu) ------------------------
  // Edit opens the LEFT overlay over the palette (Automa's edit panel).
  const openNodeEditor = useCallback((id: string) => {
    setSelectedId(id)
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
    setEditingId(id)
    setPaletteOpen(true)
  }, [])

  // Gear button: open the block settings + on-error modal (Automa BlockSettings).
  // Select the node too (without forcing the sidebar open) so the modal edits
  // the live node data.
  const openNodeSettings = useCallback((id: string) => {
    setSelectedId(id)
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
    setSettingsForId(id)
  }, [])

  // Patch an arbitrary node's block data (used by the settings modal, which may
  // target a node that is not the current sidebar selection).
  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, blockData: { ...n.data.blockData, ...patch } } }
          : n,
      ),
    )
  }, [])

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      // Remove edges that were attached to the deleted node.
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      setSelectedId((cur) => (cur === id ? null : cur))
      setEditingId((cur) => (cur === id ? null : cur))
      toast.show(t('nodeDeleted'), 'info')
    },
    [toast, t],
  )

  const duplicateNode = useCallback(
    (id: string) => {
      setNodes((nds) => {
        const src = nds.find((n) => n.id === id)
        if (!src) return nds
        const copy: FlowNode = {
          ...src,
          id: newId(),
          position: { x: src.position.x + 40, y: src.position.y + 40 },
          selected: false,
          data: {
            ...src.data,
            blockData: { ...structuredClone(src.data.blockData) },
          },
        }
        toast.show(t('nodeDuplicated'), 'ok')
        return [...nds, copy]
      })
    },
    [toast, t],
  )

  const toggleNodeDisabled = useCallback((id: string) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                blockData: { ...n.data.blockData, disableBlock: n.data.blockData.disableBlock !== true },
              },
            }
          : n,
      ),
    )
  }, [])

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

  const handleRun = useCallback(
    async (startNodeId?: string) => {
      if (!workflowId) return
      await handleSave()
      setRunning(true)
      try {
        const r = await sendCommand({ type: 'workflows.run', id: workflowId, startAt: startNodeId })
        if (r.type === 'workflows.run') {
          if (r.outcome.ok) toast.show(startNodeId ? t('runFromHereFinished') : t('runFinished'), 'ok')
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
        // Logs are viewed in a modal (Automa's log viewer), not the sidebar.
        setLogsOpen(true)
      }
    },
    [workflowId, handleSave, toast, t],
  )

  // Stable callbacks injected into every node's hover toolbar.
  const nodeActions = useMemo(
    () => ({
      onDelete: deleteNode,
      onDuplicate: duplicateNode,
      onSettings: openNodeSettings,
      onEdit: openNodeEditor,
      onToggleDisable: toggleNodeDisabled,
      onRunFromHere: (id: string) => void handleRun(id),
    }),
    [deleteNode, duplicateNode, openNodeSettings, openNodeEditor, toggleNodeDisabled, handleRun],
  )

  // Nodes as rendered: state nodes plus the injected toolbar callbacks.
  const flowNodes = useMemo(
    () => nodes.map((n) => ({ ...n, data: { ...n.data, actions: nodeActions } })),
    [nodes, nodeActions],
  )

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

  const handleAutoLayout = useCallback(() => {
    setNodes((nds) => {
      const layoutNodes = nds.map((n) => ({
        id: n.id,
        measured: { width: n.measured?.width, height: n.measured?.height },
      }))
      const positions = autoLayout(
        layoutNodes,
        edges.map((e) => ({ source: e.source, target: e.target })),
      )
      return nds.map((n) => {
        const p = positions.get(n.id)
        return p ? { ...n, position: p } : n
      })
    })
    // Fit view after React Flow re-renders the moved nodes.
    setTimeout(() => reactFlow.fitView({ duration: 300, padding: 0.2 }), 60)
    toast.show(t('autoLayoutDone'), 'ok')
  }, [edges, reactFlow, toast, t])

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
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, handleRun])

  // Node whose block-settings modal is open (gear in hover toolbar).
  const settingsNode = useMemo(
    () => (settingsForId ? nodes.find((n) => n.id === settingsForId) : undefined),
    [nodes, settingsForId],
  )
  const settingsBlock = settingsNode?.data.block ?? null

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

  // Edit overlay for the LEFT panel (Automa: the edit form replaces/overlays
  // the block palette while a node is being edited; hidden otherwise).
  const patchMeta = useCallback(
    (patch: Partial<{ name: string; description: string; settings: WorkflowSettings }>) =>
      setMeta((m) => ({ ...m, ...patch, settings: { ...m.settings, ...(patch.settings ?? {}) } })),
    [],
  )

  const editNode = useMemo(() => nodes.find((n) => n.id === editingId), [nodes, editingId])
  const editBlock = editNode?.data.block ?? null

  const editOverlay =
    editNode && editBlock ? (
      <div className="wf-edit-overlay">
        <WorkflowMetaProvider
          meta={{ name: meta.name, description: meta.description, settings: meta.settings }}
          onMeta={(p) =>
            patchMeta({
              ...(p.name !== undefined ? { name: p.name } : {}),
              ...(p.description !== undefined ? { description: p.description } : {}),
              ...(p.settings ? { settings: p.settings as WorkflowSettings } : {}),
            })
          }
        >
          <BlockEditForm
            block={editBlock}
            nodeName={String(editNode.data.blockData?.description ?? editBlock.name)}
            data={editNode.data.blockData}
            onChange={(patch) => patchNode(editNode.id, patch)}
            t={t}
            onBack={() => {
              setEditingId(null)
              setSelectedId(null)
              setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
            }}
          />
        </WorkflowMetaProvider>
      </div>
    ) : null

  return (
    <EditorLocaleContext.Provider value={editorLocale}>
    <div className="wf-editor">
      <TopToolbar
        workflowName={meta.name || t('untitled')}
        workflowIcon={meta.icon}
        paletteOpen={paletteOpen}
        onTogglePalette={() => setPaletteOpen((o) => !o)}
        onRename={(name) => setMeta((m) => ({ ...m, name }))}
        debugMode={meta.settings.debugMode}
        onToggleDebug={() =>
          setMeta((m) => ({ ...m, settings: { ...m.settings, debugMode: !m.settings.debugMode } }))
        }
        dirty={dirty}
        saving={saving}
        running={running}
        recording={recording}
        onSave={() => void handleSave()}
        onRun={() => void handleRun()}
        onOpenLogs={() => setLogsOpen(true)}
        onToggleRecording={() => void toggleRecording()}
        onAutoLayout={handleAutoLayout}
        t={t}
      />

      <div className="wf-canvas-wrap">
      <ReactFlow
        nodes={flowNodes}
        edges={edgeWithHighlight}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeDoubleClick={onEdgeDoubleClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onNodeDoubleClick={(_e, node) => {
          // Automa: double-click a block to edit it in the left panel. Note
          // nodes have no catalog block, so they don't open the editor.
          if ((node.data as BlockNodeData).block) openNodeEditor(node.id)
        }}
        fitView
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode="Control"
        defaultEdgeOptions={{
          type: 'custom',
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: 'var(--we-edge)' },
        }}
      >
        <Background gap={16} color="var(--we-border)" />
        <MiniMap
          pannable
          zoomable
          className="wf-minimap"
          nodeColor={(n) => {
            const block = (n.data as BlockNodeData).block
            return block ? `var(--cat-${block.category})` : 'var(--we-border)'
          }}
          maskColor="rgba(15,23,42,0.10)"
          bgColor="var(--we-bg-soft)"
        />
        <CanvasControls nodes={nodes} t={t} />
      </ReactFlow>

      {/* Left: block palette; the edit form OVERLAYS it while editing
          (Automa: double-click a node to edit, back arrow returns). */}
      <Sidebar open={paletteOpen} width={paletteWidth} onWidthChange={setPaletteWidth} side="left">
        <BlockPalette />
        {editOverlay}
      </Sidebar>
      </div>

      {error && <div className="wf-error-banner" onClick={() => setError(null)}>{error}</div>}
      {toast.node}
      <ToastHost />
      <ConfirmHost />

      {/* Block settings + on-error modal (gear button in node hover toolbar). */}
      <BlockSettingsModal
        open={settingsForId !== null && !!settingsBlock}
        onClose={() => setSettingsForId(null)}
        block={settingsBlock}
        data={settingsNode?.data.blockData ?? {}}
        onChange={(patch) => settingsForId && patchNode(settingsForId, patch)}
      />

      {/* Run-logs / debug viewer modal. */}
      <LogsModal
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        workflowId={workflowId}
        debugMode={meta.settings.debugMode}
        t={t}
      />
    </div>
    </EditorLocaleContext.Provider>
  )
}

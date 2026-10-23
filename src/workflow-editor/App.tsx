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
  SelectionMode,
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

import { BLOCK_BY_ID, CATALOG_BY_ID } from '../lib/workflow/blocks/palette'
import { OCR_SUPPORTED } from '../lib/ocr-support'
import { isCloudBlock } from '../lib/workflow/blocks/cloud-blocks'
import type { BlockCatalogEntry } from '../lib/workflow/blocks/types'
import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowTrigger,
  WorkflowSettings,
} from '../lib/workflow/types'
import { migrateWorkflow, triggerFromNodes } from '../lib/workflow/migrate'
import { readEdgeStyle, workflowEdgeOf } from '../lib/workflow/edge-data'
import { ensureSecretProducer, type SuggestionGraph } from '../lib/workflow/var-suggestions'
import {
  appendOperatorChain,
  applyOperatorAction,
  edgesAfterBatchRemoved,
  isOperatorChainAction,
  operatorBatchOf,
  operatorDigestOf,
  prependOperatorChain,
  selectedOperatorSpecOf,
  type OperatorBatch,
  type OperatorMissingParams,
  type OperatorNodeAction,
  type OperatorNodeSnapshot,
  type OperatorProposal,
  type OperatorPrunedPort,
} from '../lib/workflow/operator-advise'
import type { SecretFieldRef } from '../lib/workflow/secret-params'
import { withoutNodeAddedByAi } from '../lib/workflow/node-goal-contract'
import { nodeRunIssuesOf } from '../lib/workflow/validation'
import { sendCommand } from '../lib/messages'
import { editorUrl, hostWindowId } from './host-window'
import { getSettings } from '../lib/storage'
import { newId } from '../lib/storage'

import { nodeTypes as blockNodeTypes, type BlockNodeData } from './flow/BlockNode'
import { GroupNode, type GroupNodeActions } from './flow/GroupNode'
import {
  GROUP_BLOCK_ID,
  groupChildFromBlock,
  groupChildrenOf,
  groupChildProblemText,
  groupChildProblems,
  moveGroupChild,
  planGroupPack,
  removeGroupChild,
  unpackGroupNode,
  type GroupPackFailure,
  type WorkflowGroupChild,
} from '../lib/workflow/group'
import { edgeTypes } from './flow/CustomEdge'
import {
  applyConnection,
  edgeClosesCycle,
  healEdgeHandles,
  newEdge,
  pruneRemovedPortEdges,
} from './flow/connections'
import Sidebar, { loadWidth } from './sidebar/Sidebar'
import BlockPalette from './sidebar/BlockPalette'
import WorkflowSidebarHeader from './sidebar/WorkflowSidebarHeader'
import BlockEditForm from './sidebar/BlockEditForm'
import Modal from './ui/Modal'
import BlockSettingsModal from './blocks/shared/BlockSettingsModal'
import { isEditableTarget, useSpaceSelect } from './use-space-select'
import {
  nodeDragStep,
  pushCanvasSnapshot,
  removesAnything,
  type CanvasSnapshot,
} from './graph-history'
import { SlashMenuProvider } from './blocks/shared/SlashVariableMenu'
import LogsModal from './sidebar/LogsModal'
import { WorkflowMetaProvider } from './blocks/batchD/WorkflowInfoFields'
import TopToolbar from './toolbar/TopToolbar'
import DebugBar, { type DebugPause } from './debug/DebugBar'
import { useRepairEvents as useEditorRepairEvents } from './use-repair-events'
import CertificationModal from './sidebar/CertificationModal'
import type { VerificationReport } from '../background/workflow-engine/goal-verification'
import CanvasControls from './toolbar/CanvasControls'
import OperatorChatDock, {
  type OperatorApplyRequest,
  type OperatorChatContext,
  type OperatorLanding,
} from './ai/OperatorChatDock'
import { useToast } from './toast'
import { ToastHost } from '../ui/toast'
import { ConfirmHost, confirmDialog } from '../ui/confirm'
import { makeTranslate, resolveEditorLocale } from './i18n'
import {
  EditorLocaleContext,
  makeEditorLocale,
  type EditorLocale as EditorLocaleValue,
} from './locale-context'
import { autoLayout } from './auto-layout'
import './editor.css'

const DEFAULT_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

type FlowNode = Node<BlockNodeData>

/**
 * Which canvas renderer draws a block. A group is the one block that hosts its
 * own editor on the node (its children live in `data.blocks`, not on the canvas),
 * so it gets a renderer of its own instead of the generic block shell.
 */
function flowTypeOf(block: BlockCatalogEntry | undefined, blockId: string): string {
  if (block?.component === 'Group') return 'GroupNode'
  return blockId === 'note' ? 'NoteNode' : 'BlockNode'
}

/** The canvas' node renderer map: the block shells plus the group container. */
const nodeTypes = { ...blockNodeTypes, GroupNode }

function toFlowNode(n: WorkflowNode): FlowNode {
  const blockId = (n.data.blockId as string) ?? n.label
  // Fall back to the FULL catalog (cloud blocks included): a miss here makes
  // BlockNode render `null` (an invisible node with no handles, silently
  // dropping its edges) and buildWorkflow then persists `blockId: "unknown"`,
  // corrupting the workflow on the next save.
  const block = BLOCK_BY_ID.get(blockId) ?? CATALOG_BY_ID.get(blockId)
  const { blockId: _, ...blockData } = n.data as Record<string, unknown>
  return {
    id: n.id,
    type: flowTypeOf(block, blockId),
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
    type: flowTypeOf(block, block.id),
    position,
    data: {
      block,
      blockData: { ...structuredClone(block.data), description: '' },
    },
  }
}

/** A canvas node in the shape the workflow file (and the run gate) uses. */
function toWorkflowNode(n: FlowNode): WorkflowNode {
  return {
    id: n.id,
    label: n.data.block?.name ?? n.id,
    position: n.position,
    data: { ...n.data.blockData, blockId: n.data.block?.id ?? 'unknown' },
  }
}

/**
 * Re-draw an edge the group planner re-anchored. connections.ts owns what a
 * canvas edge looks like, so a folded or unfolded chain renders like a drawn one.
 */
function toCanvasEdge(e: WorkflowEdge): Edge {
  return newEdge({
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  })
}

/** What the assistant's last landing did, in the form 撤销 can put back: either
 *  the batch of nodes it added, or the one node it changed in place. */
type AiUndoRecord =
  { kind: 'chain'; batch: OperatorBatch } | { kind: 'node'; before: OperatorNodeSnapshot }

export default function EditorApp() {
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  /** Node id whose block-settings modal is open (gear button in hover toolbar). */
  const [settingsForId, setSettingsForId] = useState<string | null>(null)
  /** Group child whose block-settings modal is open (pencil in the group node). */
  const [childEditFor, setChildEditFor] = useState<{ nodeId: string; index: number } | null>(null)
  /** Whether the run-logs / debug viewer modal is open. */
  const [logsOpen, setLogsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [paletteWidth, setPaletteWidth] = useState(() => loadWidth('left'))
  /** Node id being edited in the LEFT overlay (Automa: double-click opens the
   *  edit panel over the block palette; hidden while no node is being edited). */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  /** Testing mode: run with breakpoint pauses (Automa's testingMode). */
  const [testingMode, setTestingMode] = useState(false)
  /** True while this editor's testing run is in flight (drives the poll). */
  const [testingRunActive, setTestingRunActive] = useState(false)
  const [debugPause, setDebugPause] = useState<
    | (DebugPause & {
        runId: string
        variables?: Record<string, unknown>
      })
    | null
  >(null)
  const [certReport, setCertReport] = useState<VerificationReport | null>(null)
  const [recording, setRecording] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Background AI repair for this workflow (started by the run path when the
  // user enabled it): progress chip + cancel in the toolbar.
  const { status: repairStatus, cancel: cancelRepair } = useEditorRepairEvents(
    workflowId ?? undefined,
  )
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
    icon: 'lucide:Workflow',
    trigger: { type: 'manual', enabled: true },
    settings: DEFAULT_SETTINGS,
  })

  const reactFlow = useReactFlow()
  const loadedRef = useRef(false)

  // --- undo -------------------------------------------------------------------
  // Ctrl+Z walks back the canvas STRUCTURE (design §D8): a mutation that adds,
  // removes, moves or rewires a node records the graph as it was first. Parameter
  // typing is deliberately not on the stack — it has no discrete boundary (one
  // record per keystroke would bury the structural steps), and a focused field
  // already owns its own undo, which the keydown guard hands back to it.
  const canvasRef = useRef({ nodes, edges })
  canvasRef.current = { nodes, edges }
  const historyRef = useRef<CanvasSnapshot[]>([])
  /** One node drag is one step, not one step per animation frame. */
  const dragStepOpen = useRef(false)

  const pushHistory = useCallback(() => {
    const { nodes: drawn, edges: wired } = canvasRef.current
    pushCanvasSnapshot(historyRef.current, {
      nodes: structuredClone(drawn.map(toWorkflowNode)),
      edges: structuredClone(wired.map(workflowEdgeOf)),
      selectedIds: drawn.filter((node) => node.selected).map((node) => node.id),
    })
  }, [])

  /**
   * Put one patched node back onto the canvas without disturbing what React Flow
   * owns per node (selection, measurement). `toFlowNode` resolves the catalog
   * entry, the node type and the label from the new `blockId`, which is what
   * makes a swapped operator render as the operator it became.
   */
  const installPatchedNode = useCallback((node: WorkflowNode) => {
    setNodes((nds) =>
      nds.map((current) => {
        if (current.id !== node.id) return current
        const next = toFlowNode(node)
        return { ...current, type: next.type, data: next.data }
      }),
    )
  }, [])

  /**
   * Put one node back exactly as a snapshot held it: its own renderer (a swapped
   * operator has to draw as the operator it became) plus every line that touched
   * it. What a swap left behind (re-hung and cut edges) exists nowhere else.
   */
  const restoreNodeSnapshot = useCallback(
    (snapshot: OperatorNodeSnapshot) => {
      installPatchedNode(snapshot.node)
      setEdges((eds) => {
        const owned = new Set(snapshot.edges.map((edge) => edge.id))
        const restored = snapshot.edges.map((edge) => {
          const existing = eds.find((candidate) => candidate.id === edge.id)
          if (!existing) return { ...edge, type: 'custom' }
          return {
            ...existing,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle,
            targetHandle: edge.targetHandle,
          }
        })
        // Cut lines come back too: a swap removed them, and React Flow would have
        // hidden them anyway, so the only trace left is this snapshot.
        return [...eds.filter((edge) => !owned.has(edge.id)), ...restored]
      })
      setMeta((m) => ({ ...m, settings: { ...m.settings, certificationStatus: 'unverified' } }))
    },
    [installPatchedNode],
  )

  const undoCanvasChange = useCallback(() => {
    const snapshot = historyRef.current.pop()
    if (!snapshot) {
      toast.show(t('editorUndoEmpty'), 'info')
      return
    }
    const selected = new Set(snapshot.selectedIds)
    setNodes(
      snapshot.nodes.map((node) => ({ ...toFlowNode(node), selected: selected.has(node.id) })),
    )
    setEdges(snapshot.edges.map((edge) => ({ ...edge, type: 'custom' })))
    // A step that removed the node being edited or inspected would otherwise leave
    // those panels open on a node that no longer exists.
    const keepPanelFor = (id: string | null) =>
      id && !snapshot.nodes.some((node) => node.id === id) ? null : id
    setEditingId(keepPanelFor)
    setSettingsForId(keepPanelFor)
    setMeta((m) => ({ ...m, settings: { ...m.settings, certificationStatus: 'unverified' } }))
    toast.show(t('editorUndone'), 'info')
  }, [setNodes, setEdges, toast, t])

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
    // Undo is per-workflow, and the stack holds nothing but unsaved canvas steps:
    // loading a graph starts it empty.
    historyRef.current = []
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
        const flowNodes = wf.drawflow.nodes.map(toFlowNode)
        setNodes(flowNodes)
        // healEdgeHandles: React Flow silently DROPS edges whose stored
        // source/target handle ids don't match a rendered Handle (nodes stay,
        // connections vanish, no console error). Re-anchor stale ids on load.
        setEdges(
          healEdgeHandles(
            flowNodes,
            wf.drawflow.edges.map((e) => {
              const style = readEdgeStyle(e)
              return {
                id: e.id,
                source: e.source,
                target: e.target,
                sourceHandle: e.sourceHandle,
                targetHandle: e.targetHandle,
                type: 'custom',
                ...(Object.keys(style).length > 0 ? { data: style } : {}),
              }
            }),
          ),
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
  }, [])

  useEffect(() => {
    if (loadedRef.current) setDirty(true)
  }, [nodes, edges, meta])

  // Holding Space box-selects on the canvas. React Flow cannot be asked to watch
  // the key itself here (a trusted Space never reaches its window-level handler,
  // see specs/2026-10-16-canvas-box-select-design.md), so the gesture is driven
  // from our own key state through `selectionOnDrag` below. Space inside a text
  // field stays a typed space.
  const spaceDown = useSpaceSelect()

  // Native beforeunload prompt: catches the browser's window-close button on
  // MV3 popup windows, which the in-app Ctrl+W interceptor can't reach.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // required for Chrome to surface the native prompt
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // Selection itself lives on the nodes (`n.selected`, see selectedIds) —
      // box-select / modifier+click / delete-key remove changes all flow through
      // applyNodeChanges.
      // Undo records one step per GESTURE: pressing Delete arrives here as a
      // `remove` change (it never goes through deleteNode), and a drag emits one
      // position change per frame — the first of the drag opens the step.
      const drag = nodeDragStep(changes, dragStepOpen.current)
      dragStepOpen.current = drag.dragStepOpen
      if (drag.push || removesAnything(changes)) pushHistory()
      setNodes((nds) => applyNodeChanges<FlowNode>(changes, nds))
    },
    [pushHistory],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (removesAnything(changes)) pushHistory()
      setEdges((eds) => applyEdgeChanges(changes, eds))
    },
    [pushHistory],
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      // See flow/connections.ts: a draw moves only the edge belonging to the
      // handle it starts from, so a second branch can land on an already-wired
      // node (a merge). A loop-back (branch routed to an earlier node) gets a
      // confirmation toast so the retry semantics are explicit.
      pushHistory()
      setEdges((eds) => {
        if (
          conn.source &&
          conn.target &&
          conn.source !== conn.target &&
          edgeClosesCycle(eds, conn.source, conn.target)
        ) {
          toast.show(t('loopBackConnected'), 'info')
        }
        return applyConnection(eds, conn)
      })
    },
    [pushHistory, toast, t],
  )

  // Double-clicking a connection removes it (matches Automa's edge behaviour).
  // Selecting the edge first and pressing Delete also works via the default
  // delete-key handling.
  const onEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      pushHistory()
      setEdges((eds) => eds.filter((e) => e.id !== edge.id))
      toast.show(t('edgeDeleted'), 'info')
    },
    [pushHistory, toast, t],
  )

  /**
   * Rewrite one group node's child list from its current children. Children are
   * not canvas nodes, so the list in `data.blocks` is the only place their order
   * exists — which is also the order the engine runs them in.
   */
  const setGroupChildren = useCallback(
    (nodeId: string, mutate: (children: WorkflowGroupChild[]) => WorkflowGroupChild[]) => {
      // The child list IS the group's flow, so adding, reordering or dropping a
      // child is a structural change and gets recorded like one.
      pushHistory()
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId || n.data.block?.id !== GROUP_BLOCK_ID) return n
          const groupNode = toWorkflowNode(n)
          return {
            ...n,
            data: {
              ...n.data,
              blockData: { ...n.data.blockData, blocks: mutate(groupChildrenOf(groupNode)) },
            },
          }
        }),
      )
    },
    [pushHistory, setNodes],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const blockId = event.dataTransfer.getData('application/workflow-block')
      if (!blockId) return
      const block = BLOCK_BY_ID.get(blockId)
      if (!block || isCloudBlock(blockId)) return
      // no-ocr build: OCR-only operators cannot be added (the palette card is
      // already inert; this also rejects drags from other sources).
      if (block.requiresOcr === true && !OCR_SUPPORTED) {
        toast.show(t('ocrUnavailable'), 'error')
        return
      }
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      // A drop landing inside a group adds the block to that group: its children
      // live in its own list, not on the canvas.
      const host = reactFlow
        .getNodes()
        .find(
          (n) =>
            n.type === 'GroupNode' &&
            position.x >= n.position.x &&
            position.x <= n.position.x + (n.measured?.width ?? 0) &&
            position.y >= n.position.y &&
            position.y <= n.position.y + (n.measured?.height ?? 0),
        )
      if (host) {
        const child = groupChildFromBlock(block, newId())
        const [problem] = groupChildProblems([child])
        if (problem) {
          toast.show(groupChildProblemText(problem), 'error')
          return
        }
        setGroupChildren(host.id, (children) => [...children, child])
        return
      }
      pushHistory()
      setNodes((nds) => [...nds, newFlowNode(block, position)])
    },
    [pushHistory, reactFlow, toast, t, setGroupChildren, setNodes],
  )

  // --- node hover-toolbar actions (Automa block-menu) ------------------------
  // Edit opens the LEFT overlay over the palette (Automa's edit panel).
  const openNodeEditor = useCallback((id: string) => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
    setEditingId(id)
    setPaletteOpen(true)
  }, [])

  // Gear button: open the block settings + on-error modal (Automa BlockSettings).
  // Select the node too (without forcing the sidebar open) so the modal edits
  // the live node data.
  const openNodeSettings = useCallback((id: string) => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
    setSettingsForId(id)
  }, [])

  // Patch an arbitrary node's block data (used by the settings modal, which may
  // target a node that is not the current sidebar selection). Every user edit
  // lands here, so it is also where an AI-added node stops being the assistant's.
  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                blockData: withoutNodeAddedByAi({ ...n.data.blockData, ...patch }),
              },
            }
          : n,
      ),
    )
  }, [])

  const deleteNode = useCallback(
    (id: string) => {
      pushHistory()
      setNodes((nds) => nds.filter((n) => n.id !== id))
      // Remove edges that were attached to the deleted node.
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      setEditingId((cur) => (cur === id ? null : cur))
      toast.show(t('nodeDeleted'), 'info')
    },
    [pushHistory, toast, t],
  )

  const duplicateNode = useCallback(
    (id: string) => {
      pushHistory()
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
    [pushHistory, toast, t],
  )

  const toggleNodeDisabled = useCallback(
    (id: string) => {
      pushHistory()
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  blockData: {
                    ...n.data.blockData,
                    disableBlock: n.data.blockData.disableBlock !== true,
                  },
                },
              }
            : n,
        ),
      )
    },
    [pushHistory],
  )

  // Automa's block-menu breakpoint dot: `$breakpoint` lives in block data, so
  // it saves, exports and undo like any other property.
  const toggleNodeBreakpoint = useCallback(
    (id: string) => {
      pushHistory()
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  blockData: {
                    ...n.data.blockData,
                    $breakpoint: n.data.blockData['$breakpoint'] !== true,
                  },
                },
              }
            : n,
        ),
      )
    },
    [pushHistory],
  )

  // Nodes the run gate proves cannot do their job (no locator, no key, no
  // url…). Recomputed from the live canvas on every edit, so a red badge never
  // lies and never lingers after the parameter is filled in. Same rule the
  // engine stops on — `validation.nodeRunIssuesOf` — so the badge and the run
  // log can never disagree about which step is at fault. Disabled blocks are
  // skipped by the engine before that check, so they stay unmarked here too.
  const blockedNodes = useMemo(() => {
    const out: Record<string, string> = {}
    for (const n of nodes) {
      if (!n.data.block || n.data.blockData['disableBlock'] === true) continue
      const first = nodeRunIssuesOf(toWorkflowNode(n)).find((issue) => issue.severity === 'error')
      if (first) out[n.id] = first.message
    }
    return out
  }, [nodes])

  const buildWorkflow = useCallback(async (): Promise<Workflow | null> => {
    if (!workflowId) return null
    const { x, y, zoom } = reactFlow.getViewport()
    const wfNodes: WorkflowNode[] = nodes.map(toWorkflowNode)
    const wfEdges: WorkflowEdge[] = edges.map(workflowEdgeOf)
    return {
      id: workflowId,
      name: meta.name || t('untitled'),
      description: meta.description,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      drawflow: { nodes: wfNodes, edges: wfEdges, position: { x, y }, zoom },
      // The trigger block is the source of truth edited on the canvas;
      // denormalize it into the top-level field so the workflows list chip
      // and background listeners see the current launch type right on save.
      trigger: triggerFromNodes(wfNodes) ?? meta.trigger,
      settings: meta.settings,
    }
  }, [workflowId, nodes, edges, meta, reactFlow, t])

  const handleSave = useCallback(async (): Promise<boolean> => {
    const wf = await buildWorkflow()
    if (!wf) return false
    setSaving(true)
    setError(null)
    try {
      await sendCommand({ type: 'workflows.save', workflow: wf })
      setDirty(false)
      toast.show(t('saved'), 'ok')
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.show(`${t('saveFailed')}: ${msg}`, 'error')
      return false
    } finally {
      setSaving(false)
    }
  }, [buildWorkflow, toast, t])

  const handleRun = useCallback(
    async (startNodeId?: string) => {
      if (!workflowId) return
      // Automa refuses a second testing run: two paused runs would compete for
      // one debug bar, and only one of them could be driven.
      if (testingMode) {
        const board = await sendCommand({ type: 'workflows.running', workflowId }).catch(() => null)
        if (board?.type === 'workflows.running' && board.runs.some((run) => run.testing === true)) {
          toast.show(t('testingAlreadyRunning'), 'error')
          return
        }
      }
      // Testing mode steps through the SAVED graph the background will load;
      // running on unsaved data would step a graph nobody can see.
      if (!(await handleSave())) return
      setRunning(true)
      const testing = testingMode
      if (testing) setTestingRunActive(true)
      try {
        // Run scoped to the window that opened this editor (see host-window).
        const windowId = hostWindowId()
        const r = await sendCommand({
          type: 'workflows.run',
          id: workflowId,
          startAt: startNodeId,
          ...(windowId !== undefined ? { windowId } : {}),
          ...(testing ? { testing: true } : {}),
        })
        if (r.type === 'workflows.run') {
          const cert = (r.outcome as { certification?: VerificationReport }).certification
          if (cert) setCertReport(cert)
          if (r.outcome.ok)
            toast.show(startNodeId ? t('runFromHereFinished') : t('runFinished'), 'ok')
          else if (Object.keys(blockedNodes).length > 0) {
            // The run stopped in front of a block that cannot work. Which block
            // is on the run log (one row per node) and red on the canvas — the
            // wall of contract prose this used to paste into a toast named no
            // node the user could find (specs/2026-10-06-run-preflight-log-design.md).
            toast.show(
              t('runBlockedNodes').replace('{count}', String(Object.keys(blockedNodes).length)),
              'error',
            )
          } else {
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
        if (testing) setTestingRunActive(false)
      }
    },
    [workflowId, handleSave, blockedNodes, toast, t, testingMode],
  )

  // While a testing run is alive, poll its pause. A run that vanishes from
  // `runs` but is absent from `finished` was lost with its worker — the run
  // request's own catch reports the failure; this only clears the debug bar
  // and says why, never silently resuming.
  useEffect(() => {
    if (!testingRunActive || !workflowId) return
    let disposed = false
    let observedRunId: string | null = null
    const poll = async (): Promise<void> => {
      try {
        const result = await sendCommand({ type: 'workflows.running', workflowId })
        if (disposed || result.type !== 'workflows.running') return
        const active = result.runs.find((run) => run.testing === true)
        if (!active) {
          setDebugPause((current) => (current === null ? current : null))
          if (
            observedRunId !== null &&
            !result.finished.some((run) => run.runId === observedRunId)
          ) {
            toast.show(t('debugRunLost'), 'error')
            setTestingRunActive(false)
          }
          return
        }
        observedRunId = active.runId
        const paused = active.debug?.paused
        if (!paused) {
          setDebugPause((current) => (current === null ? current : null))
          return
        }
        const snapshot = active.snapshots
          ? [...active.snapshots].reverse().find((entry) => entry.nodeId === paused.nodeId)
          : undefined
        setDebugPause((current) => {
          if (
            current &&
            current.runId === active.runId &&
            current.nodeId === paused.nodeId &&
            current.at === paused.at &&
            (current.variables !== undefined || snapshot === undefined)
          ) {
            return current
          }
          return {
            runId: active.runId,
            nodeId: paused.nodeId,
            label: paused.label,
            at: paused.at,
            ...(snapshot ? { variables: snapshot.variables } : {}),
          }
        })
      } catch {
        // The run request reports its own transport failure; keep polling so
        // the bar still follows a run that outlives one failed poll.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 800)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [testingRunActive, workflowId, toast, t])

  /** Answers a held pause. Stop is the ordinary cancel path in the background. */
  const controlDebug = useCallback(
    async (action: 'resume' | 'next' | 'stop'): Promise<void> => {
      const runId = debugPause?.runId
      if (!runId) return
      // Clear immediately: the next poll re-fills it only if the run pauses
      // again, so a stale bar can never issue a second resume.
      setDebugPause(null)
      try {
        const result = await sendCommand({ type: 'debug.control', runId, action })
        if (result.type === 'debug.control' && !result.ok && action !== 'stop') {
          toast.show(t('debugRunLost'), 'error')
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.show(`${t('runFailed')}: ${msg}`, 'error')
      }
    },
    [debugPause?.runId, toast, t],
  )

  /** Select a node and scroll the canvas to it (the run log's locate action). */
  const locateNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      const node = reactFlow.getNode(id)
      if (!node) return
      const width = node.measured?.width ?? 200
      const height = node.measured?.height ?? 60
      reactFlow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: Math.max(reactFlow.getZoom(), 1),
        duration: 400,
      })
    },
    [reactFlow],
  )

  // Stable callbacks injected into every node's hover toolbar.
  const nodeActions = useMemo(
    () => ({
      onDelete: deleteNode,
      onDuplicate: duplicateNode,
      onSettings: openNodeSettings,
      onEdit: openNodeEditor,
      onToggleDisable: toggleNodeDisabled,
      onToggleBreakpoint: toggleNodeBreakpoint,
      onRunFromHere: (id: string) => void handleRun(id),
    }),
    [
      deleteNode,
      duplicateNode,
      openNodeSettings,
      openNodeEditor,
      toggleNodeDisabled,
      toggleNodeBreakpoint,
      handleRun,
    ],
  )

  /** Why a selection cannot become a group, in the user's language. */
  const packFailureText = useCallback(
    (failure: GroupPackFailure): string => {
      if (failure.reason === 'too_few') {
        return t('groupPackTooFew').replace('{count}', String(failure.count))
      }
      if (failure.reason === 'forbidden_child') {
        return t('groupPackForbiddenChild').replace('{blockId}', failure.blockId)
      }
      return failure.reason === 'stray_connection'
        ? t('groupPackStrayConnection')
        : t('groupPackNotAChain')
    },
    [t],
  )

  /**
   * Turn a selected chain of nodes into one group node. The plan refuses anything
   * a linear child list cannot express, and the refusal is the message: folding
   * a fork away silently is how a step disappears.
   */
  const packSelection = useCallback(() => {
    const selectedIds = reactFlow
      .getNodes()
      .filter((n) => n.selected)
      .map((n) => n.id)
    const result = planGroupPack(
      nodes.map(toWorkflowNode),
      edges.map(workflowEdgeOf),
      selectedIds,
      newId(),
      t('groupDefaultName'),
    )
    if ('failure' in result) {
      toast.show(packFailureText(result.failure), 'error')
      return
    }
    const { plan } = result
    pushHistory()
    const removed = new Set(plan.removedIds)
    const dropped = new Set(plan.droppedEdgeIds)
    setNodes((nds) => [
      ...nds.filter((n) => !removed.has(n.id)),
      { ...toFlowNode(plan.group), selected: false },
    ])
    setEdges((eds) => [
      ...eds.filter((e) => !dropped.has(e.id) && !removed.has(e.source) && !removed.has(e.target)),
      ...plan.keptEdges.map(toCanvasEdge),
    ])
  }, [pushHistory, reactFlow, nodes, edges, t, toast, packFailureText, setNodes, setEdges])

  /** Spread a group's children back onto the canvas, re-threading the edges. */
  const unpackGroup = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return
      const { nodes: restored, edges: rewired } = unpackGroupNode(
        toWorkflowNode(node),
        edges.map(workflowEdgeOf),
        { idFactory: newId, takenIds: new Set(nodes.map((n) => n.id)) },
      )
      pushHistory()
      setNodes((nds) => [...nds.filter((n) => n.id !== nodeId), ...restored.map(toFlowNode)])
      setEdges((eds) => [
        ...eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
        ...rewired.map(toCanvasEdge),
      ])
      toast.show(t('groupUnpacked'), 'info')
    },
    [nodes, edges, pushHistory, setNodes, setEdges, toast, t],
  )

  // The group node edits its children in place: the name, the order, one child's
  // block form, and the way back out.
  const groupActions = useMemo<GroupNodeActions>(
    () => ({
      onGroupName: (nodeId, name) => patchNode(nodeId, { name }),
      onChildMove: (nodeId, index, delta) =>
        setGroupChildren(nodeId, (children) => moveGroupChild(children, index, delta)),
      onChildDelete: (nodeId, index) =>
        setGroupChildren(nodeId, (children) => removeGroupChild(children, index)),
      onChildEdit: (nodeId, index) => setChildEditFor({ nodeId, index }),
      onUnpack: unpackGroup,
    }),
    [patchNode, setGroupChildren, unpackGroup],
  )

  /** Write one child's parameters back into its group's list. */
  const patchGroupChild = useCallback(
    (nodeId: string, index: number, patch: Record<string, unknown>) => {
      setGroupChildren(nodeId, (children) =>
        children.map((child, position) =>
          position === index ? { ...child, data: { ...child.data, ...patch } } : child,
        ),
      )
    },
    [setGroupChildren],
  )

  // The open child form reads the LIVE list: editing must not freeze a snapshot
  // of the child the moment the pencil was clicked.
  const childEdit = useMemo(() => {
    if (!childEditFor) return null
    const node = nodes.find((n) => n.id === childEditFor.nodeId)
    if (!node) return null
    const child = groupChildrenOf(toWorkflowNode(node))[childEditFor.index]
    const block = child ? CATALOG_BY_ID.get(child.id) : undefined
    if (!child || !block) return null
    return { ...childEditFor, child, block }
  }, [childEditFor, nodes])

  // Nodes as rendered: state nodes plus the injected toolbar callbacks and the
  // run gate's red badge for a step that cannot work yet.
  const flowNodes = useMemo(
    () =>
      nodes.map((n) => {
        const reason = blockedNodes[n.id]
        return {
          ...n,
          data: {
            ...n.data,
            actions: nodeActions,
            // Only the group container edits a child list, so only it gets those
            // callbacks — every other node's data keeps its identity per render.
            ...(n.data.block?.id === GROUP_BLOCK_ID ? { groupActions } : {}),
            ...(reason === undefined ? {} : { runState: 'error' as const, blockedReason: reason }),
            // A paused testing run highlights its node with the same ring a
            // running node uses.
            ...(debugPause?.nodeId === n.id ? { running: true } : {}),
          },
        }
      }),
    [nodes, nodeActions, groupActions, blockedNodes, debugPause?.nodeId],
  )

  const toggleRecording = useCallback(async () => {
    try {
      // Recording is scoped to the window that opened this editor as well.
      const windowId = hostWindowId()
      const windowField = windowId !== undefined ? { windowId } : {}
      if (recording) {
        const r = await sendCommand({ type: 'record.stop', ...windowField })
        setRecording(false)
        toast.show(t('recordingStopped'), 'ok')
        if (r.type === 'record.stop' && r.workflowId) {
          // editorUrl() re-appends hostWindow so the reopened editor stays
          // bound to the same window after the reload.
          window.location.search = editorUrl(`?edit=${encodeURIComponent(r.workflowId)}`, windowId)
          window.location.reload()
        }
      } else {
        await sendCommand({ type: 'record.start', ...windowField })
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
    // Pack Z-shaped rows to the live canvas width so that, once the editor
    // fits the view, every node stays inside the viewport at a readable zoom.
    const rect = document.querySelector('.react-flow')?.getBoundingClientRect()
    const maxRowWidth = rect && rect.width > 320 ? rect.width - 24 : undefined
    pushHistory()
    setNodes((nds) => {
      const layoutNodes = nds.map((n) => ({
        id: n.id,
        measured: { width: n.measured?.width, height: n.measured?.height },
      }))
      const positions = autoLayout(
        layoutNodes,
        edges.map((e) => ({ source: e.source, target: e.target })),
        maxRowWidth ? { maxRowWidth } : undefined,
      )
      return nds.map((n) => {
        const p = positions.get(n.id)
        return p ? { ...n, position: p } : n
      })
    })
    // Fit view once React Flow has rendered the moved nodes. A bare timeout
    // can fire before the store picks up the new positions and leave nodes
    // outside the viewport, so wait for two animation frames instead.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void reactFlow.fitView({ duration: 400, padding: 0.2 })
      }),
    )
    toast.show(t('autoLayoutDone'), 'ok')
  }, [edges, pushHistory, reactFlow, toast, t])

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
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        // Ctrl+Z / Cmd+Z: walk the canvas back one step. While the user is typing
        // IN a field the key belongs to that field (its own undo history), so the
        // guard gives it back untouched rather than swallowing it.
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        undoCanvasChange()
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && e.key.toLowerCase() === 'w') {
        // Ctrl+W / Cmd+W: only intercept when there are unsaved changes;
        // otherwise let the browser handle window-close as usual.
        if (!dirty) return
        e.preventDefault()
        void closeWithUnsavedGuard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, handleRun, dirty, undoCanvasChange])

  // Save / Don't save / Cancel prompt for closing the popup window with
  // unsaved changes. Resolves the user's choice, then either saves and
  // closes, closes without saving, or does nothing.
  const closeWithUnsavedGuard = useCallback(async (): Promise<void> => {
    const choice = await confirmDialog({
      title: t('unsavedChanges'),
      message: t('unsavedChangesClosePrompt'),
      confirmText: t('dontSave'),
      cancelText: t('cancel'),
      extraText: t('save'),
    })
    if (choice === 'extra') {
      await handleSave()
      window.close()
    } else if (choice === true) {
      window.close()
    }
  }, [t, handleSave])

  // Node whose block-settings modal is open (gear in hover toolbar).
  const settingsNode = useMemo(
    () => (settingsForId ? nodes.find((n) => n.id === settingsForId) : undefined),
    [nodes, settingsForId],
  )
  const settingsBlock = settingsNode?.data.block ?? null

  const settingsLines = useMemo(() => {
    if (!settingsForId) return []
    return edges
      .filter((edge) => edge.source === settingsForId)
      .map((edge) => {
        const style = readEdgeStyle(edge.data)
        const target = nodes.find((node) => node.id === edge.target)
        return {
          id: edge.id,
          targetLabel: target?.data.block?.name ?? edge.target,
          label: style.label ?? '',
          animated: style.animated === true,
          color: style.color ?? '',
        }
      })
  }, [edges, nodes, settingsForId])

  const changeLineStyle = useCallback(
    (edgeId: string, patch: { label?: string; animated?: boolean; color?: string }): void => {
      setEdges((current) =>
        current.map((edge) =>
          edge.id === edgeId ? { ...edge, data: { ...(edge.data ?? {}), ...patch } } : edge,
        ),
      )
    },
    [],
  )

  // Every currently selected node id (box-select / modifier+click / shift-range).
  // Drives edge highlighting for the WHOLE selection — `selectedId` alone only
  // ever tracks the last node picked.
  const selectedIds = useMemo(
    () => new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    [nodes],
  )

  /**
   * Ids of edges that close a directed cycle (a branch looping back to an
   * earlier node). Computed from the live graph so a saved loop-back edge is
   * recognized on load too; used to render them as dashed "loop-back" lines.
   */
  const loopBackIds = useMemo(() => {
    const ids = new Set<string>()
    for (const e of edges) {
      if (edgeClosesCycle(edges, e.source, e.target)) ids.add(e.id)
    }
    return ids
  }, [edges])

  const edgeWithHighlight = useMemo(
    () =>
      edges.map((e) => {
        const loopBack = loopBackIds.has(e.id)
        return {
          ...e,
          // The dashed loop-back line uses the accent colour — give its arrow
          // marker the same colour (the global default marker is --we-edge).
          ...(loopBack
            ? {
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  width: 18,
                  height: 18,
                  color: 'var(--we-accent)',
                },
              }
            : {}),
          data: {
            ...(e.data as Record<string, unknown> | undefined),
            highlighted:
              selectedIds.size > 0 && (selectedIds.has(e.source) || selectedIds.has(e.target)),
            loopBack,
          },
        }
      }),
    [edges, selectedIds, loopBackIds],
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

  // — the `/` dynamic-variable menu (blocks/shared/SlashVariableMenu) —
  // A thunk, not a snapshot: a field that was already open when something
  // upstream changed must offer what exists at the moment of the pick.
  const suggestionGraph = useCallback((): SuggestionGraph => {
    const wfNodes = nodes.map(toWorkflowNode)
    return {
      nodes: wfNodes,
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
      })),
      trigger: triggerFromNodes(wfNodes) ?? meta.trigger,
    }
  }, [nodes, edges, meta.trigger])

  /**
   * Install a whole workflow-shaped edge list without losing what React Flow
   * tracks per edge: reconcile by id instead of swapping the array.
   */
  const applyEdgeList = useCallback((next: readonly WorkflowEdge[]) => {
    setEdges((eds) => {
      const previous = new Map(eds.map((e) => [e.id, e]))
      return next.map((e) => {
        const existing = previous.get(e.id)
        if (!existing) return { ...e, type: 'custom' }
        return {
          ...existing,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        }
      })
    })
  }, [])

  // Picking a credential secures its `get-secret` producer here; the pure patcher
  // decided the graph surgery, this applies it the way every other canvas edit
  // does — mutate, invalidate the certification, tell the user — and hands back
  // the variable name the field references. The secret value never passes through
  // any of it: only the credential id and field key.
  const insertSecretProducer = useCallback(
    (nodeId: string, ref: SecretFieldRef): Promise<string> => {
      const patch = ensureSecretProducer(suggestionGraph(), nodeId, ref, newId)
      if (patch.nodePatch) patchNode(patch.nodePatch.nodeId, patch.nodePatch.patch)
      const { added, edges: nextEdges } = patch
      if (added && nextEdges) {
        pushHistory()
        setNodes((nds) => [...nds, toFlowNode(added)])
        applyEdgeList(nextEdges)
        setMeta((m) => ({ ...m, settings: { ...m.settings, certificationStatus: 'unverified' } }))
      }
      if (patch.detached) toast.show(t('varMenuSecretDetached'), 'error')
      else if (added) toast.show(t('varMenuSecretAdded'), 'ok')
      return Promise.resolve(patch.variableName)
    },
    [applyEdgeList, patchNode, pushHistory, suggestionGraph, toast, t],
  )

  // — the floating AI operator assistant —
  // A reply lands only after the model call, and the user can keep editing the
  // canvas while it thinks. Both the context and the landing therefore read the
  // graph through this ref, never the snapshot the request went out with.
  const suggestionGraphRef = useRef(suggestionGraph)
  useEffect(() => {
    suggestionGraphRef.current = suggestionGraph
  }, [suggestionGraph])

  /** What the last landing changed: a batch of new nodes, or one node in place. */
  const aiUndoRef = useRef<AiUndoRecord | null>(null)

  const operatorChatContext = useCallback((): OperatorChatContext => {
    // Only a single selection is a target: with several picked there is no
    // unambiguous "this step", so a chain falls back to the flow's end and an
    // in-place answer has nothing to change.
    const picked = reactFlow
      .getNodes()
      .filter((node) => node.selected)
      .map((node) => node.id)
    const selectedNodeId = picked.length === 1 ? picked[0] : undefined
    const graph = suggestionGraphRef.current()
    const selectedSpec = selectedNodeId ? selectedOperatorSpecOf(graph, selectedNodeId) : ''
    // The window this editor was opened from: the assistant may only read a page
    // in it, never in some other window the user did not open it from.
    const hostWindow = hostWindowId()
    return {
      graphDigest: operatorDigestOf(graph, selectedNodeId),
      ...(selectedNodeId ? { selectedNodeId } : {}),
      ...(selectedSpec ? { selectedSpec } : {}),
      ...(hostWindow !== undefined ? { windowId: hostWindow } : {}),
      ...(meta.description ? { workflowGoal: meta.description } : {}),
      ...(workflowId ? { workflowId } : {}),
    }
  }, [meta.description, reactFlow, workflowId])

  /** Apply an `edit`/`replace` answer to the step the user had selected. */
  const applyNodeActionFromAi = useCallback(
    (
      graph: SuggestionGraph,
      action: OperatorNodeAction,
      targetNodeId: string | undefined,
      proposals: OperatorProposal[],
    ): OperatorLanding => {
      const landing = {
        kind: 'node' as const,
        added: 0,
        applied: false,
        skipped: [] as string[],
        pruned: [] as OperatorPrunedPort[],
        missing: [] as OperatorMissingParams[],
      }
      // The target is always the editor's own selection. Without one there is
      // nothing to change in place, and the assistant must not guess.
      if (!targetNodeId) return { ...landing, problem: 'no-selection' }
      const patch = applyOperatorAction(graph, targetNodeId, action, proposals)
      const patched = patch.nodes.find((node) => node.id === targetNodeId)
      if (patch.problem || !patched || !patch.before) {
        return { ...landing, ...(patch.problem ? { problem: patch.problem } : {}) }
      }
      pushHistory()
      installPatchedNode(patched)
      applyEdgeList(patch.edges)
      aiUndoRef.current = { kind: 'node', before: patch.before }
      setMeta((m) => ({ ...m, settings: { ...m.settings, certificationStatus: 'unverified' } }))
      requestAnimationFrame(() => locateNode(targetNodeId))
      toast.show(
        action === 'replace'
          ? t('operatorAiReplaced').replace('{name}', patched.label)
          : t('operatorAiEdited'),
        'ok',
      )
      return {
        ...landing,
        applied: true,
        pruned: patch.pruned,
        missing: patch.missing,
        changed: patch.changed,
        ...(patch.swapped ? { swapped: patch.swapped } : {}),
      }
    },
    [applyEdgeList, installPatchedNode, locateNode, pushHistory, toast, t],
  )

  const applyOperatorsFromAi = useCallback(
    (request: OperatorApplyRequest): OperatorLanding => {
      const graph = suggestionGraphRef.current()
      if (!isOperatorChainAction(request.action))
        return applyNodeActionFromAi(graph, request.action, request.targetNodeId, request.proposals)
      // Both splice next to the anchor; appending with no anchor falls back to the
      // end of the flow, while prepending has none — only a picked step has a front.
      const placeChain = request.action === 'prepend' ? prependOperatorChain : appendOperatorChain
      const patch = placeChain(graph, request.proposals, {
        ...(request.targetNodeId ? { anchorNodeId: request.targetNodeId } : {}),
        newId,
      })
      const landing: OperatorLanding = {
        kind: 'chain',
        added: patch.added.length,
        applied: patch.added.length > 0,
        skipped: patch.skipped,
        pruned: [],
        missing: patch.missing,
        ...(patch.problem ? { problem: patch.problem } : {}),
      }
      if (patch.added.length === 0) return landing
      pushHistory()
      setNodes((nds) => [...nds, ...patch.added.map(toFlowNode)])
      applyEdgeList(patch.edges)
      aiUndoRef.current = { kind: 'chain', batch: operatorBatchOf(patch) }
      setMeta((m) => ({ ...m, settings: { ...m.settings, certificationStatus: 'unverified' } }))
      const last = patch.added[patch.added.length - 1]
      // Center once React Flow has the node in its own store: same-tick it is
      // still unknown, and the jump would silently do nothing.
      if (last) requestAnimationFrame(() => locateNode(last.id))
      toast.show(t('operatorAiAdded').replace('{count}', String(patch.added.length)), 'ok')
      return landing
    },
    [applyEdgeList, applyNodeActionFromAi, locateNode, pushHistory, toast, t],
  )

  const undoAiBatch = useCallback(() => {
    const record = aiUndoRef.current
    aiUndoRef.current = null
    if (!record) return
    if (record.kind === 'chain') {
      const { batch } = record
      if (batch.nodeIds.length === 0) return
      const ids = new Set(batch.nodeIds)
      // The landing itself was a canvas step, so undoing it is one too: Ctrl+Z
      // after this button brings the batch back.
      pushHistory()
      // Same semantics as deleting a node by hand: its edges go with it — except the
      // continuation the batch borrowed, which has to go back to the anchor.
      setNodes((nds) => nds.filter((n) => !ids.has(n.id)))
      setEdges((eds) => edgesAfterBatchRemoved(eds, batch))
      setEditingId((cur) => (cur && ids.has(cur) ? null : cur))
      setSettingsForId((cur) => (cur && ids.has(cur) ? null : cur))
      setMeta((m) => ({ ...m, settings: { ...m.settings, certificationStatus: 'unverified' } }))
    } else {
      // The node as it was, plus every line that touched it: a swap re-hangs and
      // sometimes cuts edges, so restoring the data alone would not restore the flow.
      pushHistory()
      restoreNodeSnapshot(record.before)
    }
    toast.show(record.kind === 'chain' ? t('operatorAiUndone') : t('operatorAiNodeUndone'), 'info')
  }, [pushHistory, restoreNodeSnapshot, setEdges, setNodes, toast, t])

  const editOverlay =
    editNode && editBlock ? (
      <div className="wf-edit-overlay">
        <SlashMenuProvider
          nodeId={editNode.id}
          graph={suggestionGraph}
          insertSecret={insertSecretProducer}
        >
          <WorkflowMetaProvider
            meta={{
              // The id lets block forms exclude this workflow from their
              // "execute workflow" pickers (self-execution is a loop).
              ...(workflowId ? { id: workflowId } : {}),
              name: meta.name,
              description: meta.description,
              settings: meta.settings,
            }}
            onMeta={(p) =>
              patchMeta({
                ...(p.name !== undefined ? { name: p.name } : {}),
                ...(p.description !== undefined ? { description: p.description } : {}),
                ...(p.settings ? { settings: p.settings as WorkflowSettings } : {}),
              })
            }
          >
            <BlockEditForm
              // One form per node: block forms keep draft state (the credential
              // rows being filled in), which must not survive a switch to another
              // node.
              key={editNode.id}
              block={editBlock}
              nodeName={String(editNode.data.blockData?.description ?? editBlock.name)}
              data={editNode.data.blockData}
              onChange={(patch) => {
                patchNode(editNode.id, patch)
                // A deleted conditions path takes its wired edge with it.
                setEdges((eds) =>
                  pruneRemovedPortEdges(
                    editBlock,
                    { ...(editNode.data.blockData ?? {}), ...patch },
                    editNode.id,
                    eds,
                  ),
                )
                // Editing node data (including the Goal Contract) invalidates a
                // prior certification until L3 is re-run.
                setMeta((m) => ({
                  ...m,
                  settings: { ...m.settings, certificationStatus: 'unverified' },
                }))
              }}
              t={t}
              onBack={() => {
                setEditingId(null)
                setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
              }}
            />
          </WorkflowMetaProvider>
        </SlashMenuProvider>
      </div>
    ) : null

  return (
    <EditorLocaleContext.Provider value={editorLocale}>
      <div className="wf-editor">
        <TopToolbar
          paletteOpen={paletteOpen}
          onTogglePalette={() => setPaletteOpen((o) => !o)}
          debugMode={meta.settings.debugMode}
          onToggleDebug={() =>
            setMeta((m) => ({
              ...m,
              settings: { ...m.settings, debugMode: !m.settings.debugMode },
            }))
          }
          testingMode={testingMode}
          onToggleTesting={() => setTestingMode((on) => !on)}
          saving={saving}
          running={running}
          recording={recording}
          onSave={() => void handleSave()}
          onRun={() => void handleRun()}
          onOpenLogs={() => setLogsOpen(true)}
          onToggleRecording={() => void toggleRecording()}
          onAutoLayout={handleAutoLayout}
          selectedCount={selectedIds.size}
          onPackSelection={packSelection}
          repair={repairStatus}
          onCancelRepair={cancelRepair}
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
            // Additive pick: React Flow's own default is Meta on macOS and
            // Control elsewhere, and a hardcoded "Control" is unusable on macOS
            // (Ctrl+click is the OS context menu, so no click ever reaches the
            // node). Accept both so one prop works in every host.
            multiSelectionKeyCode={['Meta', 'Control']}
            // Shift + drag rubber-bands a selection box (Automa's own gesture, and
            // the one key React Flow reliably matches here). Space is the key we
            // advertise for box-select, but React Flow's selection-key handler does
            // not see a trusted Space in this app, so the gesture is driven from
            // our own key state instead: `selectionOnDrag` selects on a left-drag
            // while Space is held, and `panOnDrag` drops the left button so the
            // canvas stops panning under it. Node dragging is off for the same
            // window, because a box that begins over a node must not silently move
            // that node. Release the key, then drag one node to move the group.
            selectionKeyCode="Shift"
            selectionOnDrag={spaceDown}
            panOnDrag={spaceDown ? [1, 2] : true}
            nodesDraggable={spaceDown ? false : true}
            panActivationKeyCode={null}
            selectionMode={SelectionMode.Partial}
            defaultEdgeOptions={{
              type: 'custom',
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 18,
                height: 18,
                color: 'var(--we-edge)',
              },
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
          <Sidebar
            open={paletteOpen}
            width={paletteWidth}
            onWidthChange={setPaletteWidth}
            side="left"
          >
            <div className="flex h-full min-h-0 flex-col">
              <WorkflowSidebarHeader
                workflowName={meta.name}
                workflowIcon={meta.icon}
                dirty={dirty}
                onRename={(name) => setMeta((m) => ({ ...m, name }))}
              />
              <BlockPalette />
            </div>
            {editOverlay}
          </Sidebar>

          {/* Bottom-right: the AI operator assistant, above the zoom row. */}
          <OperatorChatDock
            getContext={operatorChatContext}
            onApply={applyOperatorsFromAi}
            onUndo={undoAiBatch}
            t={t}
          />

          {debugPause && (
            <DebugBar
              pause={debugPause}
              {...(debugPause.variables ? { variables: debugPause.variables } : {})}
              onControl={(action) => void controlDebug(action)}
            />
          )}
        </div>

        {error && (
          <div className="wf-error-banner" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {toast.node}
        <ToastHost />
        <ConfirmHost />

        {/* Block settings + on-error modal (gear button in node hover toolbar). */}
        {settingsForId && settingsBlock && (
          <SlashMenuProvider
            nodeId={settingsForId}
            graph={suggestionGraph}
            insertSecret={insertSecretProducer}
          >
            <BlockSettingsModal
              // Same reason as the edit overlay: the modal hosts the very same
              // block forms, and their draft rows belong to one node.
              key={settingsForId}
              open
              onClose={() => setSettingsForId(null)}
              block={settingsBlock}
              data={settingsNode?.data.blockData ?? {}}
              onChange={(patch) => patchNode(settingsForId, patch)}
              lines={settingsLines}
              onLineChange={changeLineStyle}
            />
          </SlashMenuProvider>
        )}

        {/* One child of a group (pencil in the group node): the same block form,
            minus the goal section — the engine never reads a contract for a step
            that is not a graph node. Variable suggestions still resolve against
            the graph, so a child can reference what runs before it. */}
        {childEdit && (
          <SlashMenuProvider
            nodeId={childEdit.nodeId}
            graph={suggestionGraph}
            insertSecret={insertSecretProducer}
          >
            <Modal
              open
              onClose={() => setChildEditFor(null)}
              icon={childEdit.block.icon}
              accent={`var(--cat-${childEdit.block.category})`}
              title={editorLocale.blockName(childEdit.block.id, childEdit.block.name)}
              size="md"
            >
              <BlockEditForm
                key={`${childEdit.nodeId}-${childEdit.index}`}
                block={childEdit.block}
                nodeName={String(childEdit.child.data['description'] ?? childEdit.block.name)}
                data={childEdit.child.data}
                onChange={(patch) => patchGroupChild(childEdit.nodeId, childEdit.index, patch)}
                onBack={() => setChildEditFor(null)}
                t={t}
                hideGoal
              />
            </Modal>
          </SlashMenuProvider>
        )}

        {/* Run-logs / debug viewer modal. */}
        <CertificationModal report={certReport} onClose={() => setCertReport(null)} t={t} />
        <LogsModal
          open={logsOpen}
          onClose={() => setLogsOpen(false)}
          workflowId={workflowId}
          debugMode={meta.settings.debugMode}
          // The log modal stacks on top of the canvas, so locating a node has to
          // uncover it first.
          onLocateNode={(nodeId) => {
            setLogsOpen(false)
            locateNode(nodeId)
          }}
          t={t}
        />
      </div>
    </EditorLocaleContext.Provider>
  )
}

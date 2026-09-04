/**
 * Pure graph-repair operations for the workflow auto-debugger.
 *
 * When a workflow run fails, the AI decision layer (background) picks ONE
 * repair strategy and this module turns that decision into concrete edits of
 * the workflow graph. Everything here is pure: the input workflow is never
 * mutated (each op works on a `structuredClone`), so callers can apply,
 * inspect and discard candidate repairs safely.
 *
 * Ops deliberately mirror the runtime conventions the engine already
 * understands:
 * - per-block params live flat on `node.data` (canonical post-migrate shape),
 * - the Automa-style `onError` retry policy (interval < 60 is read as seconds
 *   by the engine, see `workflow-engine/engine.ts onErrorPolicy`),
 * - edges carry `sourceHandle: '<blockId>-output-N'` and
 *   `targetHandle: '<blockId>-input-1'`.
 *
 * @module lib/workflow/auto-debug-patch
 */
import { CATALOG_BY_ID } from './blocks/palette'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

// --- Shared result / decision types (imported by background + panel) ---------

/** The one repair the AI may prescribe per debug round. */
export type DebugStrategy =
  | 'retry'
  | 'repair-params'
  | 'insert-branch'
  | 'insert-ai-agent'
  | 'remove-redundant'
  | 'unfixable'

/** How one inserted branch behaves when its condition is false. */
export type BranchOnFalse = 'skip' | 'ai-agent'

/** The structured repair decision the model is asked to return. */
export interface DebugDecision {
  diagnosis: string
  strategy: DebugStrategy
  /** `retry`: attempts beyond the first (engine adds these to the base run). */
  retryTimes?: number
  /** `retry`: seconds between attempts (engine converts < 60 to ms). */
  retryIntervalSec?: number
  /** `repair-params`: corrected block params, merged flat onto node data. */
  paramsPatch?: Record<string, unknown>
  /** `insert-branch`: the guard to splice in before the failing node. */
  branch?: {
    kind: 'element-exists' | 'conditions'
    /** `element-exists`: CSS/XPath selector to probe. */
    selector?: string
    findBy?: string
    /** `conditions`: variable name / comparison / reference value. */
    variable?: string
    compare?: string
    value?: unknown
    /** Where the false branch goes. */
    onFalse: BranchOnFalse
    /** Prompt for the AI-agent fallback node (`onFalse: 'ai-agent'`). */
    agentPrompt?: string
  }
  /** `insert-ai-agent`: the agent step to splice in before the failing node. */
  agent?: {
    prompt?: string
    selector?: string
    actOnPage?: boolean
    variableName?: string
  }
  /** Extra params patch applied to the failing node alongside an insertion. */
  alsoPatchParams?: Record<string, unknown>
  /** `remove-redundant`: ids of duplicated / no-longer-needed nodes to delete.
   *  May also accompany a constructive strategy (retry / repair-params /
   *  insert-*) as a compositional logic adjustment — those nodes are removed
   *  on top of the primary repair. */
  removeNodeIds?: string[]
}

/** One debug round as reported back to the panel. */
export interface DebugRound {
  diagnosis: string
  strategy: DebugStrategy
  changes: string[]
  runOutcome: 'ok' | 'failed' | 'cancelled'
  error?: string
}

/** Final result of a debug session, sent to the panel. */
export interface WorkflowDebugResult {
  ok: boolean
  cancelled?: boolean
  attempts: number
  workflowModified: boolean
  summary: string
  error?: string
  /** Run id of the last attempt, so the panel can deep-link into History. */
  lastRunId?: string
  rounds: DebugRound[]
}

/** One recorded engine step line, used for failure attribution and context. */
export interface DebugStepLine {
  kind: string
  nodeId?: string
  text: string
}

/** Page facts gathered around the failure, included in the AI context. */
export interface DebugPageFacts {
  url?: string
  title?: string
  /** Current element count per probed selector. */
  selectorMatches?: Record<string, number>
  /** Inspected page elements (target status / similar candidates / interactive elements). Shape is owned by the inspector. */
  elements?: unknown
}

/** The failure context handed to the AI decision layer. */
export interface DebugFailureContext {
  workflow: Workflow
  failingNodeId?: string
  error: string
  steps: DebugStepLine[]
  pageFacts?: DebugPageFacts
}

/** Raised by the AI layer when no model provider / API key is configured. */
export class NoProviderError extends Error {}

/** Outcome of one pure patch op. */
export interface AppliedDecision {
  workflow: Workflow
  changed: boolean
  changes: string[]
}

// --- Small helpers -----------------------------------------------------------

/** Generates an id without pulling storage in (keeps this module chrome-free). */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Canonical block id of a node (`data.blockId`, falling back to the label). */
function blockIdOfNode(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

/** Human-readable node name for change notes: label + description when set. */
function describeNode(node: WorkflowNode): string {
  const desc = typeof node.data?.['description'] === 'string' ? node.data['description'] : ''
  return desc ? `${node.label}（${desc}）` : node.label
}

/** Element selector carried by a node (Automa dual shape + legacy key). */
function selectorOf(node: WorkflowNode): string {
  const data = node.data ?? {}
  if (typeof data['selector'] === 'string' && data['selector']) return data['selector']
  if (typeof data['cssSelector'] === 'string' && data['cssSelector']) return data['cssSelector']
  return ''
}

/** Truncates a value for inline change notes. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** Trigger block ids that must never be deleted (kept in sync with engine.ts). */
const TRIGGER_BLOCK_IDS = new Set([
  'trigger',
  'manual',
  'schedule',
  'scheduled',
  'visit-web',
  'context-menu',
  'on-startup',
  'keyboard-shortcut',
  'date',
  'specific-day',
  'element-change',
])

function mkEdge(
  source: string,
  target: string,
  sourceBlockId: string,
  targetBlockId: string,
  outputSuffix = 'output-1',
): WorkflowEdge {
  return {
    id: newId(),
    source,
    target,
    sourceHandle: `${sourceBlockId}-${outputSuffix}`,
    targetHandle: `${targetBlockId}-input-1`,
  }
}

/** Default (first) out-edge target of a node, or undefined when it dead-ends. */
function defaultNextOf(workflow: Workflow, nodeId: string): string | undefined {
  return workflow.drawflow.edges.find((edge) => edge.source === nodeId)?.target
}

function noop(workflow: Workflow, changes: string[]): AppliedDecision {
  return { workflow, changed: false, changes }
}

// --- Repair operations -------------------------------------------------------

/**
 * Sets (merges into) the Automa-style retry policy on one node so the engine
 * retries transient failures. Interval is stored in seconds; the engine's
 * `onErrorPolicy` treats values < 60 as seconds and converts to ms.
 */
export function setRetryPolicy(
  workflow: Workflow,
  nodeId: string,
  opts: { retryTimes?: number; retryIntervalSec?: number },
): AppliedDecision {
  const node = workflow.drawflow.nodes.find((n) => n.id === nodeId)
  if (!node) return noop(workflow, [`未找到节点 ${nodeId}，未应用重试策略`])
  const wf = structuredClone(workflow)
  const target = wf.drawflow.nodes.find((n) => n.id === nodeId)!
  const raw =
    target.data['onError'] && typeof target.data['onError'] === 'object'
      ? (target.data['onError'] as Record<string, unknown>)
      : {}
  const retryTimes = clamp(Number(opts.retryTimes ?? raw['retryTimes'] ?? 3), 1, 5)
  const retryInterval = clamp(Number(opts.retryIntervalSec ?? raw['retryInterval'] ?? 2), 1, 30)
  target.data['onError'] = {
    ...raw,
    enable: true,
    retry: true,
    toDo: 'retry',
    retryTimes,
    retryInterval,
  }
  return {
    workflow: wf,
    changed: true,
    changes: [
      `为「${describeNode(node)}」增加失败重试：最多重试 ${retryTimes} 次，间隔 ${retryInterval} 秒`,
    ],
  }
}

/**
 * Merges corrected params flat onto one node's `data` (the canonical shape).
 * `blockId` / `disableBlock` are protected: the AI must not re-type a node or
 * silently disable it.
 */
export function patchNodeParams(
  workflow: Workflow,
  nodeId: string,
  patch: Record<string, unknown>,
): AppliedDecision {
  const node = workflow.drawflow.nodes.find((n) => n.id === nodeId)
  if (!node) return noop(workflow, [`未找到节点 ${nodeId}，未修改参数`])
  const entries = Object.entries(patch).filter(([key]) => key !== 'blockId' && key !== 'disableBlock')
  if (entries.length === 0) return noop(workflow, ['参数修改内容为空'])
  const wf = structuredClone(workflow)
  const target = wf.drawflow.nodes.find((n) => n.id === nodeId)!
  const keys: string[] = []
  for (const [key, value] of entries) {
    target.data[key] = value
    keys.push(`${key}: ${preview(node.data[key])} → ${preview(value)}`)
  }
  return {
    workflow: wf,
    changed: true,
    changes: [`修正「${describeNode(node)}」参数：${keys.join('；')}`],
  }
}

/**
 * Builds a new node from a palette/catalog block: catalog defaults, then the
 * given overrides, then the canonical `blockId` and a description marking it
 * as AI-added (the editor shows the description as the node subtitle).
 * Returns `null` for unknown block ids.
 */
export function buildBlockNode(
  blockId: string,
  overrides: Record<string, unknown>,
  position: { x: number; y: number },
  description: string,
): WorkflowNode | null {
  const block = CATALOG_BY_ID.get(blockId)
  if (!block) return null
  return {
    id: newId(),
    label: block.name || blockId,
    position,
    data: {
      ...structuredClone((block.data ?? {}) as Record<string, unknown>),
      ...overrides,
      blockId,
      description,
    },
  }
}

/**
 * Splices `newNode` into the graph right before `refNodeId`: every edge that
 * pointed at the reference node now points at the new node, and the new node's
 * outputs route to `outs.output1` / `outs.output2` (positional handles
 * `-output-1` / `-output-2`, which the engine maps to the block's semantic
 * branch keys: true/false, exists/notExists, ...).
 *
 * Returns the input workflow unchanged when the reference node is missing.
 */
export function insertNodeBefore(
  workflow: Workflow,
  refNodeId: string,
  newNode: WorkflowNode,
  outs: { output1?: string; output2?: string },
): Workflow {
  const wf = structuredClone(workflow)
  const refNode = wf.drawflow.nodes.find((n) => n.id === refNodeId)
  if (!refNode) return workflow
  const newBlockId = blockIdOfNode(newNode)
  for (const edge of wf.drawflow.edges) {
    if (edge.target !== refNodeId) continue
    edge.target = newNode.id
    edge.targetHandle = `${newBlockId}-input-1`
  }
  wf.drawflow.nodes.push(newNode)
  if (outs.output1) {
    const targetBlock = blockIdOfNode(wf.drawflow.nodes.find((n) => n.id === outs.output1) ?? refNode)
    wf.drawflow.edges.push(mkEdge(newNode.id, outs.output1, newBlockId, targetBlock))
  }
  if (outs.output2) {
    const targetBlock = blockIdOfNode(wf.drawflow.nodes.find((n) => n.id === outs.output2) ?? refNode)
    wf.drawflow.edges.push(mkEdge(newNode.id, outs.output2, newBlockId, targetBlock, 'output-2'))
  }
  return wf
}

/** Adds a node plus one default out-edge (used for branch-side agent nodes). */
function addNodeWithEdge(
  workflow: Workflow,
  node: WorkflowNode,
  nextTarget: string | undefined,
): Workflow {
  const wf = structuredClone(workflow)
  wf.drawflow.nodes.push(node)
  if (nextTarget) {
    const targetBlock = blockIdOfNode(wf.drawflow.nodes.find((n) => n.id === nextTarget) ?? node)
    wf.drawflow.edges.push(mkEdge(node.id, nextTarget, blockIdOfNode(node), targetBlock))
  }
  return wf
}

/**
 * Deletes the given nodes and splices them out of the flow: each surviving
 * edge that pointed at a removed node is retargeted to the removed node's
 * default downstream (following chains through other removed nodes), so the
 * graph never dead-ends where a redundant step used to sit. Edges that only
 * connected removed nodes are dropped.
 *
 * Guards: unknown ids are ignored; trigger/entry blocks and the graph's first
 * node are never removed; removing every node is refused.
 */
export function removeNodes(workflow: Workflow, nodeIds: string[]): AppliedDecision {
  const idSet = new Set(nodeIds)
  const present = workflow.drawflow.nodes.filter((n) => idSet.has(n.id))
  if (present.length === 0) return noop(workflow, ['未找到要删除的节点'])
  const firstNodeId = workflow.drawflow.nodes[0]?.id
  const removable = present.filter(
    (n) => n.id !== firstNodeId && !TRIGGER_BLOCK_IDS.has(blockIdOfNode(n)),
  )
  if (removable.length === 0) return noop(workflow, ['入口/触发器节点不可删除'])
  if (removable.length >= workflow.drawflow.nodes.length) {
    return noop(workflow, ['不能删除全部节点'])
  }

  const wf = structuredClone(workflow)
  const removedSet = new Set(removable.map((n) => n.id))
  const nodes = wf.drawflow.nodes

  // Default downstream of every node in the pre-edit graph.
  const defaultNext = new Map<string, string | undefined>()
  for (const node of nodes) defaultNext.set(node.id, defaultNextOf(workflow, node.id))

  // Follow default-next chains until a surviving node (or a dead end).
  const resolveSplice = (id: string): string | undefined => {
    let current = id
    const seen = new Set<string>()
    while (removedSet.has(current) && !seen.has(current)) {
      seen.add(current)
      const next = defaultNext.get(current)
      if (!next) return undefined
      current = next
    }
    return removedSet.has(current) ? undefined : current
  }

  const edges = wf.drawflow.edges
  for (const edge of edges) {
    if (removedSet.has(edge.target) && !removedSet.has(edge.source)) {
      const splice = resolveSplice(edge.target)
      if (splice) {
        edge.target = splice
        const targetNode = nodes.find((n) => n.id === splice)
        if (targetNode) edge.targetHandle = `${blockIdOfNode(targetNode)}-input-1`
      }
      // No splice target: the edge is dropped by the filter below.
    }
  }
  wf.drawflow.edges = edges.filter(
    (edge) => !removedSet.has(edge.source) && !removedSet.has(edge.target),
  )
  wf.drawflow.nodes = nodes.filter((node) => !removedSet.has(node.id))
  const labels = removable.map((node) => describeNode(node)).join('、')
  return { workflow: wf, changed: true, changes: [`删除冗余/重复节点：${labels}`] }
}

/** Params that never belong in a compact log line. */
const PARAM_NOISE_KEYS = new Set(['description', 'blockId', 'disableBlock'])

/** Cap per param value in the compact log line. */
const PARAM_VALUE_CAP = 50

/**
 * Compact "key=value" summary of a node's params for live run logs, so the
 * user can see WHICH node runs with WHAT configuration. Noise keys are
 * skipped, long values truncated, the retry policy collapsed to one token.
 */
export function describeNodeParams(node: WorkflowNode): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(node.data ?? {})) {
    if (PARAM_NOISE_KEYS.has(key)) continue
    if (value === undefined || value === null || value === '' || value === false) continue
    if (key === 'onError') {
      const policy = value as Record<string, unknown>
      if (policy['retry'] === true) {
        const interval = policy['retryInterval']
        parts.push(`onError=重试×${String(policy['retryTimes'] ?? '?')}${interval ? `/${String(interval)}s` : ''}`)
      }
      continue
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
    parts.push(`${key}=${text.length > PARAM_VALUE_CAP ? `${text.slice(0, PARAM_VALUE_CAP)}…` : text}`)
  }
  return parts.join(', ')
}

/** Chinese strategy label used in change notes and the debug report. */
export function describeStrategy(strategy: DebugStrategy): string {
  switch (strategy) {
    case 'retry':
      return '增加重试'
    case 'repair-params':
      return '修正参数'
    case 'insert-branch':
      return '增加条件分支'
    case 'insert-ai-agent':
      return '增加 AI 智能节点'
    case 'remove-redundant':
      return '删除冗余节点'
    case 'unfixable':
      return '无法自动修复'
  }
}

// --- Decision dispatcher -----------------------------------------------------

/**
 * Applies one AI repair decision to the workflow graph. Invalid or incomplete
 * decisions degrade to a no-op with an explanatory change note — the caller
 * then stops debugging instead of saving a broken graph.
 */
export function applyDebugDecision(
  workflow: Workflow,
  failingNodeId: string,
  decision: DebugDecision,
): AppliedDecision {
  let applied = applyPrimaryDecision(workflow, failingNodeId, decision)
  // Compositional logic adjustment: a constructive repair may ALSO remove
  // nodes that no longer make sense (e.g. fix a selector and drop a
  // duplicated step). `unfixable` stays a pure no-op; `remove-redundant` IS
  // the removal and must not run twice.
  if (
    decision.removeNodeIds?.length &&
    decision.strategy !== 'remove-redundant' &&
    decision.strategy !== 'unfixable'
  ) {
    const removal = removeNodes(applied.workflow, decision.removeNodeIds)
    if (removal.changed) {
      applied = {
        workflow: removal.workflow,
        changed: true,
        changes: [...applied.changes, ...removal.changes],
      }
    }
  }
  return applied
}

function applyPrimaryDecision(
  workflow: Workflow,
  failingNodeId: string,
  decision: DebugDecision,
): AppliedDecision {
  switch (decision.strategy) {
    case 'retry':
      return setRetryPolicy(workflow, failingNodeId, {
        retryTimes: decision.retryTimes,
        retryIntervalSec: decision.retryIntervalSec,
      })

    case 'repair-params': {
      if (!decision.paramsPatch || Object.keys(decision.paramsPatch).length === 0) {
        return noop(workflow, ['AI 未提供参数修改内容'])
      }
      return patchNodeParams(workflow, failingNodeId, decision.paramsPatch)
    }

    case 'insert-branch':
      return applyInsertBranch(workflow, failingNodeId, decision)

    case 'insert-ai-agent':
      return applyInsertAgent(workflow, failingNodeId, decision)

    case 'remove-redundant':
      return removeNodes(workflow, decision.removeNodeIds ?? [])

    case 'unfixable':
      return noop(workflow, [])

    default:
      return noop(workflow, ['未知的修复策略'])
  }
}

function applyInsertBranch(
  workflow: Workflow,
  failingNodeId: string,
  decision: DebugDecision,
): AppliedDecision {
  const branch = decision.branch
  const failingNode = workflow.drawflow.nodes.find((n) => n.id === failingNodeId)
  if (!branch || !failingNode) return noop(workflow, ['AI 未提供条件分支内容'])

  const onFalse: BranchOnFalse = branch.onFalse === 'ai-agent' ? 'ai-agent' : 'skip'
  const skipTarget = defaultNextOf(workflow, failingNodeId)

  // Optional AI fallback on the false branch (a dead-end skip target is fine).
  let working = workflow
  let agentNodeId: string | undefined
  if (onFalse === 'ai-agent') {
    const agentPrompt =
      branch.agentPrompt?.trim() ||
      `页面状态已变化，原步骤「${describeNode(failingNode)}」可能无法直接执行。请检查当前页面，定位正确的目标元素并完成该步骤要做的操作。`
    const agentNode = buildBlockNode(
      'ai-agent',
      {
        prompt: agentPrompt,
        selector: '',
        actOnPage: true,
        variableName: 'aiDebugVar',
      },
      { x: failingNode.position.x - 260, y: failingNode.position.y + 160 },
      'AI 调试自动添加：页面变化兜底',
    )
    if (!agentNode) return noop(workflow, ['无法构建 AI 智能节点'])
    agentNodeId = agentNode.id
    working = addNodeWithEdge(workflow, agentNode, skipTarget)
  }

  // The guard itself: element-exists with the given (or the failing node's
  // own) selector, or a single conditions group over a variable.
  let guardNode: WorkflowNode | null = null
  if (branch.kind === 'conditions' && branch.variable) {
    guardNode = buildBlockNode(
      'conditions',
      {
        conditions: [
          {
            conditions: [
              { name: branch.variable, compare: branch.compare ?? 'exists', value: branch.value ?? '' },
            ],
          },
        ],
      },
      { x: failingNode.position.x - 260, y: failingNode.position.y },
      'AI 调试自动添加：条件分支',
    )
  } else {
    const selector = branch.selector?.trim() || selectorOf(failingNode)
    if (!selector) return noop(workflow, ['条件分支缺少可用的元素选择器'])
    guardNode = buildBlockNode(
      'element-exists',
      {
        selector,
        findBy: branch.findBy ?? 'cssSelector',
        tryCount: 3,
        timeout: 500,
        throwError: false,
      },
      { x: failingNode.position.x - 260, y: failingNode.position.y },
      'AI 调试自动添加：元素存在守卫',
    )
  }
  if (!guardNode) return noop(workflow, ['无法构建条件分支节点'])

  const routed = insertNodeBefore(working, failingNodeId, guardNode, {
    output1: failingNodeId,
    ...(agentNodeId ? { output2: agentNodeId } : skipTarget ? { output2: skipTarget } : {}),
  })
  if (routed === working) return noop(workflow, ['未能插入条件分支节点'])

  const falseRoute =
    onFalse === 'ai-agent'
      ? '不存在时转 AI 智能节点兜底'
      : skipTarget
        ? '不存在时跳过该步骤继续后续流程'
        : '不存在时结束流程'
  const changes = [
    `在「${describeNode(failingNode)}」前插入条件守卫「${guardNode.label}」：满足→执行原步骤；${falseRoute}`,
  ]
  if (agentNodeId) changes.push('条件不成立分支已接入 AI 智能节点兜底')
  return { workflow: routed, changed: true, changes }
}

function applyInsertAgent(
  workflow: Workflow,
  failingNodeId: string,
  decision: DebugDecision,
): AppliedDecision {
  const failingNode = workflow.drawflow.nodes.find((n) => n.id === failingNodeId)
  if (!failingNode) return noop(workflow, ['未找到失败节点'])
  const agent = decision.agent ?? {}
  const agentPrompt =
    agent.prompt?.trim() ||
    `原步骤「${describeNode(failingNode)}」执行失败（${decision.diagnosis || '原因未知'}）。请检查当前页面状态，定位正确的目标元素并完成该步骤要做的操作。`
  const agentNode = buildBlockNode(
    'ai-agent',
    {
      prompt: agentPrompt,
      selector: agent.selector ?? '',
      actOnPage: agent.actOnPage !== false,
      variableName: agent.variableName?.trim() || 'aiDebugVar',
    },
    { x: failingNode.position.x - 260, y: failingNode.position.y },
    'AI 调试自动添加：动态处理步骤',
  )
  if (!agentNode) return noop(workflow, ['无法构建 AI 智能节点'])

  let routed = insertNodeBefore(workflow, failingNodeId, agentNode, { output1: failingNodeId })
  if (routed === workflow) return noop(workflow, ['未能插入 AI 智能节点'])

  let changes = [`在「${describeNode(failingNode)}」前插入 AI 智能节点，动态定位/处理页面变化`]
  const extra = decision.alsoPatchParams
  if (extra && Object.keys(extra).length > 0) {
    const patched = patchNodeParams(routed, failingNodeId, extra)
    if (patched.changed) {
      routed = patched.workflow
      changes = [...changes, ...patched.changes]
    }
  }
  return { workflow: routed, changed: true, changes }
}

/**
 * AI-debug phase 2: conversation replay + workflow graph audit (复演与图审计).
 *
 * When the node-level takeover loop cannot rescue a workflow, the debug
 * session escalates: a FULL agent re-executes the workflow's goal on the live
 * page exactly like the first chat run (snapshot → act → verify), then a
 * one-shot model call compares what actually worked against the workflow
 * graph and audits every node —
 *
 *   ok        the node is correct as-is
 *   wrong     the node runs but with bad params (a paramsPatch is proposed)
 *   missing   the goal needs a step the graph does not have
 *   redundant the node is dead weight (exploratory/dead-end) and should go
 *   fallback  the node is optional and must not break the run (onError route)
 *
 * The audit may also carry a FULL corrected graph (`workflow.nodes/edges`).
 * {@link buildRewrittenWorkflow} validates that graph defensively — an
 * unusable rewrite degrades to `null` and the session falls back to the
 * paramsPatch path, never to a broken workflow.
 *
 * Everything here is pure (prompt building, parsing, validation); the IO
 * (agent turn, model call, verify run) lives in the debug session wiring.
 *
 * @module lib/workflow/debug-rewrite
 */
import { BLOCK_BY_ID } from './blocks/palette'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/** How the audit judges one node. */
export type NodeVerdict = 'ok' | 'wrong' | 'missing' | 'redundant' | 'fallback'

const NODE_VERDICTS: readonly string[] = ['ok', 'wrong', 'missing', 'redundant', 'fallback']

/** One audited node (panel-facing + prompt-facing). */
export interface NodeAudit {
  nodeId: string
  nodeLabel: string
  verdict: NodeVerdict
  note: string
}

/** Parsed audit reply. `graph` is the raw (unvalidated) rewrite. */
export interface WorkflowAudit {
  diagnosis: string
  nodes: NodeAudit[]
  changes: string[]
  /** Raw nodes/edges from the model — validate via {@link buildRewrittenWorkflow}. */
  graph: { nodes: unknown[]; edges: unknown[] } | null
}

/** Hard caps so one reply cannot blow the context or the graph. */
const TRACE_CAP = 60
const VALUE_CAP = 160
const MAX_AUDIT_NODES = 40
const MAX_GRAPH_NODES = 60

/** JSON.stringify replacer that truncates long strings (applies recursively). */
function truncateStrings(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'string' && val.length > VALUE_CAP ? `${val.slice(0, VALUE_CAP)}…` : val,
  )
}

/**
 * The plan text the replay agent sees. Prefers the authored `workflow.plan`;
 * falls back to assembling it from node descriptions so older workflows and
 * editor saves still get a usable brief.
 */
export function planTextOf(workflow: Workflow): string {
  if (typeof workflow.plan === 'string' && workflow.plan.trim()) return workflow.plan.trim()
  const steps = workflow.drawflow.nodes
    .map((node) => ({
      blockId:
        typeof node.data['blockId'] === 'string' ? node.data['blockId'] : node.label,
      description:
        typeof node.data['description'] === 'string' && node.data['description']
          ? node.data['description']
          : String(node.data['blockId'] ?? node.label),
    }))
    .filter((node) => node.blockId !== 'trigger')
    .map((node, index) => `${index + 1}. ${node.description}`)
  return `目标：${workflow.name}${workflow.description ? ` — ${workflow.description}` : ''}\n执行步骤：\n${steps.join('\n')}`
}

/** One graph line per node: id, block, description, params (for the audit). */
function nodeLines(workflow: Workflow): string[] {
  const lines: string[] = []
  for (const node of workflow.drawflow.nodes) {
    const raw = node.data['blockId']
    const blockId = typeof raw === 'string' ? raw : node.label
    const name = BLOCK_BY_ID.get(blockId)?.name ?? blockId
    const description =
      typeof node.data['description'] === 'string' ? node.data['description'] : ''
    const params = { ...node.data } as Record<string, unknown>
    delete params['description']
    delete params['blockId']
    lines.push(
      `- id=${node.id} [${blockId}] ${name}${description ? `：${description}` : ''}`,
      `  params: ${truncateStrings(params)}`,
    )
  }
  return lines
}

/**
 * Builds the REPLAY prompt: the agent re-does the whole task on the page like
 * the first chat run. It is NOT told to fix params — it is told to achieve
 * the goal with whatever works, noting where the workflow's way differs.
 */
export function buildReplayPrompt(workflow: Workflow): string {
  return [
    'You are the browser agent inside a Chrome extension, working in FULL mode (you control the page).',
    'A workflow automates a task, but its replay FAILED. Your job: perform the SAME task on the live page exactly like you would in a fresh chat conversation — see the page, act, verify — so we can learn what actually works.',
    '',
    '## Task brief (goal + execution steps)',
    planTextOf(workflow),
    '',
    '## How to work',
    '1. snapshot_page FIRST, then do every step for real with the page tools (navigate, click, fill, press key…). No dry runs, no "I would click" — actually do it.',
    '2. Follow the brief\'s steps in order when they work. Where a step does not work as written (stale selector, missing element, wrong order), still achieve that step\'s PURPOSE your own way and remember the difference.',
    '3. Do not stop at the first obstacle; adapt like you would in a normal chat run. Skip a step only when the page genuinely has no such target.',
    '4. Finish the WHOLE task before answering.',
    '',
    '## Response format (MANDATORY)',
    'End your reply with ONE line of JSON — no markdown fence, no commentary after it:',
    '{"completed":true,"summary":"中文：你实际做了什么；哪些步骤与工作流写法不同、为什么"}',
  ].join('\n')
}

/** The replay outcome the audit consumes. */
export interface ReplayOutcome {
  completed: boolean
  summary: string
  /** Compact tool trace (oldest first), already capped by the caller. */
  trace: string[]
}

/**
 * Builds the AUDIT prompt: a one-shot model call that compares the replay's
 * real execution against the workflow graph and produces the diagnosis, the
 * per-node verdicts and (when possible) a corrected graph.
 */
export function buildAuditPrompt(
  workflow: Workflow,
  replay: ReplayOutcome,
  failure: { error?: string; takeoverNote?: string },
): string {
  const lines: string[] = []
  lines.push(
    'You are the workflow repair expert inside a browser-automation Chrome extension.',
    'A workflow\'s replay failed; an agent then re-did the task on the live page successfully (or nearly).',
    'Audit the workflow graph against what ACTUALLY worked and produce a corrected version.',
    '',
    '## Domain knowledge (operator guide)',
    '节点形如 { id, label: \'<算子id>\', position: {x,y}, data: { blockId: \'<算子id>\', ...参数 } }；',
    "连边形如 { id, source, target, sourceHandle: '<来源算子id>-output-1', targetHandle: '<目标算子id>-input-1' }。",
    '参数里引用变量用 {{变量名}}；元素定位用 selector + findBy: \'cssSelector\'。每个节点 data.description 写一句中文。',
    '首节点必须是 trigger（data.type:\'manual\'）。可选步骤用 element-exists 分支或 onError 跳过，不要让它们中断流程。',
    '',
    '## Workflow goal + steps',
    planTextOf(workflow),
    '',
    '## Workflow graph (id · block · params — the object you must fix)',
  )
  lines.push(...nodeLines(workflow))
  lines.push(
    '',
    '## What failed in the replay',
    failure.error ? `失败信息：${failure.error}` : '失败信息：（未记录）',
    failure.takeoverNote ? `节点级 AI 接管结果：${failure.takeoverNote}` : '',
    `复演是否完成任务：${replay.completed ? '是' : '否/部分'}`,
    replay.summary ? `复演总结：${replay.summary}` : '',
    replay.trace.length > 0 ? '复演实际执行轨迹（→ 动作 / ← 结果 / ! 错误，最新在末尾）：' : '',
    ...replay.trace.slice(-TRACE_CAP).map((line) => `  ${line}`),
    '',
    '## Task',
    '1. diagnosis：中文，2~4 句——工作流为什么失败（对照复演实际做成的过程）。注意溯源：报错的节点不一定是根因，常见根因是上游节点产出了错误的值（读错元素、变量为空/错、参数填错）——从复演轨迹里找出第一个"做错"的环节。',
    '2. 逐节点 verdict（只审列出的节点，最多 ' + MAX_AUDIT_NODES + ' 个）：',
    '   - ok：正确；wrong：能跑但参数错（在 paramsPatch 给出修正参数，如 {"selector":"…","waitForSelector":true,"waitSelectorTimeout":5000}）——若是上游根因，wrong 要判给产出错误值的上游节点而不是报错节点；',
    '   - missing：目标需要但图里缺的步骤（changes 里说明应加什么）；redundant：多余/死步骤，应删；fallback：可有可无，必须配置 onError 跳过才不炸。',
    '   note：中文一句，说明依据（复演里它是怎么做的）。',
    '3. workflow：给出修正后的完整图（nodes + edges，结构严格遵守上面的规则）。能给出就一定给——这是最终产物；确实给不出时才省略。',
    '   保留正确的节点原样（id 不变）；修正 wrong 的参数；删掉 redundant；补上 missing 的节点；给 fallback 节点加 onError: { enable: true, toDo: \'continue\' }。',
    '4. changes：中文列表，逐条写你改了什么（用于向用户展示，如「修正节点3选择器 → button.submit」「新增：提交后等待加载」）。',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"diagnosis":"…","nodes":[{"id":"<节点id>","verdict":"ok|wrong|missing|redundant|fallback","note":"…"}],"changes":["…"],"workflow":{"nodes":[{…完整节点…}],"edges":[{…完整连边…}]}}',
    'workflow.nodes 的每个元素：{"id":"唯一id","label":"<算子id>","position":{"x":0,"y":0},"data":{"blockId":"<算子id>",…参数,"description":"一句中文"}}。',
    'workflow.edges 的每个元素：{"id":"e1","source":"<源节点id>","target":"<目标节点id>","sourceHandle":"<源算子id>-output-1","targetHandle":"<目标算子id>-input-1"}。',
  )
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * Extracts the LAST complete TOP-LEVEL JSON object from a model reply (models
 * add prose and reasoning around the JSON; nested objects must not be picked,
 * and reasoning models may emit several candidates — the last complete one is
 * the verdict).
 */
function extractLastJson(text: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          last = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          /* an incomplete/garbled candidate is skipped, later ones may parse */
        }
        start = -1
      }
    }
  }
  return last
}

/** Parses the audit reply; `null` means unusable (session falls back). */
export function parseWorkflowAudit(text: string): WorkflowAudit | null {
  const parsed = extractLastJson(text.replace(/```(?:json)?/g, ''))
  if (!parsed) return null
  const diagnosis =
    typeof parsed['diagnosis'] === 'string' && parsed['diagnosis'].trim()
      ? parsed['diagnosis'].trim()
      : ''
  const changes = Array.isArray(parsed['changes'])
    ? parsed['changes'].filter((c): c is string => typeof c === 'string' && !!c.trim())
    : []
  const validIds = new Set<string>()
  const nodeAudits: NodeAudit[] = []
  if (Array.isArray(parsed['nodes'])) {
    for (const raw of parsed['nodes']) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const id = typeof entry['id'] === 'string' ? entry['id'] : ''
      const verdict = typeof entry['verdict'] === 'string' ? entry['verdict'] : ''
      if (!id || !(NODE_VERDICTS as readonly string[]).includes(verdict)) continue
      validIds.add(id)
      nodeAudits.push({
        nodeId: id,
        nodeLabel: typeof entry['label'] === 'string' ? entry['label'] : id,
        verdict: verdict as NodeVerdict,
        note:
          typeof entry['note'] === 'string' && entry['note'].trim()
            ? entry['note'].trim()
            : '',
      })
    }
  }
  const rawWorkflow = parsed['workflow']
  const graph =
    rawWorkflow &&
    typeof rawWorkflow === 'object' &&
    Array.isArray((rawWorkflow as Record<string, unknown>)['nodes']) &&
    ((rawWorkflow as Record<string, unknown>)['nodes'] as unknown[]).length > 0
      ? {
          nodes: (rawWorkflow as Record<string, unknown>)['nodes'] as unknown[],
          edges: Array.isArray((rawWorkflow as Record<string, unknown>)['edges'])
            ? ((rawWorkflow as Record<string, unknown>)['edges'] as unknown[])
            : [],
        }
      : null
  if (!diagnosis && nodeAudits.length === 0 && !graph) return null
  return {
    diagnosis: diagnosis || '（AI 未给出诊断）',
    nodes: nodeAudits,
    changes,
    graph,
  }
}

/**
 * Auto-layout: stacks nodes vertically (the canvas draws fine with any
 * coordinates, but generated graphs should not pile up on one point).
 */
function withPositions(
  nodes: (Omit<WorkflowNode, 'position'> & { position?: { x: number; y: number } })[],
): WorkflowNode[] {
  return nodes.map((node, index) => ({
    ...node,
    position: node.position ?? { x: 160, y: index * 140 },
  }))
}

// --- Goal-completion check (目标达成判定) -------------------------------------

/** Evidence of a finished (no-error) run, judged against the workflow's goal. */
export interface GoalEvidence {
  /** The run's step tail (oldest last). */
  steps: { kind: string; text: string }[]
  /** Final variable values produced by the nodes. */
  variables: Record<string, unknown>
  /** The engine's own summary line (may be empty). */
  summary?: string
}

/** The judge's verdict on whether the run actually achieved the goal. */
export interface GoalVerdict {
  achieved: boolean
  reason: string
}

/**
 * Builds the goal-completion prompt: a one-shot judge call that decides
 * whether a run that threw NO errors actually COMPLETED the workflow's goal.
 * The distinction matters: a workflow can run clean end-to-end and still read
 * the wrong element, fill the wrong box or submit into the void.
 */
export function buildGoalCheckPrompt(workflow: Workflow, evidence: GoalEvidence): string {
  const lines: string[] = []
  lines.push(
    'You are the goal judge for a browser-automation workflow.',
    'A workflow just finished WITHOUT any node error. "No error" is NOT success — decide whether the run actually COMPLETED THE GOAL.',
    '',
    '## Goal + execution steps (the contract this run must fulfill)',
    planTextOf(workflow),
    '',
    '## What the run actually did (step tail, oldest last)',
  )
  for (const step of evidence.steps.slice(-40)) {
    lines.push(`- [${step.kind}] ${step.text}`)
  }
  lines.push('', '## What the nodes produced (final variable values)')
  const vars = Object.entries(evidence.variables).slice(0, 25)
  if (vars.length === 0) lines.push('(no variables)')
  for (const [key, value] of vars) {
    lines.push(`- ${key} = ${truncateStrings(value)}`)
  }
  if (evidence.summary) lines.push('', `Engine summary: ${evidence.summary}`)
  lines.push(
    '',
    '## How to judge',
    '- The GOAL is the contract: check the END STATE it implies (e.g. "search X and open the product page" requires the right page open; "extract price into {{price}}" requires price to hold a real price, not garbage/empty).',
    '- Use the variables as the primary evidence: an empty/wrong/placeholder value where the goal expects data means NOT achieved.',
    '- Missing steps the plan requires (a step never ran, a submission never happened) mean NOT achieved, even when every executed step succeeded.',
    '- Judge leniently about cosmetic differences (page layout, exact text wording) and strictly about the substance (right target, real value, action actually happened).',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"achieved":true,"reason":"中文一句话：目标达成的依据（或未达成的缺口）"}',
  )
  return lines.join('\n')
}

/** Parses the goal judge's reply; `null` means unusable (caller falls back). */
export function parseGoalVerdict(text: string): GoalVerdict | null {
  const cleaned = text.replace(/```(?:json)?/g, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const reason =
      typeof parsed['reason'] === 'string' && parsed['reason'].trim()
        ? parsed['reason'].trim()
        : ''
    return { achieved: parsed['achieved'] === true, reason }
  } catch {
    return null
  }
}

/** Validates the model's graph and builds the rewritten workflow. Pure. */export function buildRewrittenWorkflow(
  original: Workflow,
  graph: { nodes: unknown[]; edges: unknown[] },
): Workflow | null {
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return null
  if (graph.nodes.length > MAX_GRAPH_NODES) return null
  const nodes: (Omit<WorkflowNode, 'position'> & { position?: { x: number; y: number } })[] = []
  const idOf = new Map<string, string>()
  for (const raw of graph.nodes) {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Record<string, unknown>
    const data =
      entry['data'] && typeof entry['data'] === 'object' && !Array.isArray(entry['data'])
        ? ({ ...(entry['data'] as Record<string, unknown>) } as Record<string, unknown>)
        : null
    if (!data) return null
    const rawBlockId = typeof data['blockId'] === 'string' ? data['blockId'] : entry['label']
    const blockId = typeof rawBlockId === 'string' ? rawBlockId : ''
    if (!blockId || !BLOCK_BY_ID.has(blockId)) return null
    const originalId = typeof entry['id'] === 'string' && entry['id'] ? entry['id'] : `n${nodes.length + 1}`
    if (idOf.has(originalId)) return null
    const id = originalId
    idOf.set(originalId, id)
    if (typeof data['description'] !== 'string') data['description'] = ''
    const position =
      entry['position'] &&
      typeof entry['position'] === 'object' &&
      typeof (entry['position'] as Record<string, unknown>)['x'] === 'number' &&
      typeof (entry['position'] as Record<string, unknown>)['y'] === 'number'
        ? (entry['position'] as unknown as { x: number; y: number })
        : undefined
    nodes.push({
      id,
      label: blockId,
      ...(position ? { position } : {}),
      data,
    })
  }
  // The engine starts at the trigger; a graph without one can never run.
  if (!nodes.some((node) => node.data['blockId'] === 'trigger')) return null
  const edges: WorkflowEdge[] = []
  for (const raw of graph.edges ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const source = typeof entry['source'] === 'string' ? entry['source'] : ''
    const target = typeof entry['target'] === 'string' ? entry['target'] : ''
    if (!idOf.has(source) || !idOf.has(target) || source === target) continue
    const sourceNode = nodes.find((node) => node.id === source)
    const targetNode = nodes.find((node) => node.id === target)
    if (!sourceNode || !targetNode) continue
    const sourceBlock = String(sourceNode.data['blockId'] ?? sourceNode.label)
    const targetBlock = String(targetNode.data['blockId'] ?? targetNode.label)
    edges.push({
      id: typeof entry['id'] === 'string' && entry['id'] ? entry['id'] : `e${edges.length + 1}`,
      source,
      target,
      ...(typeof entry['sourceHandle'] === 'string' && entry['sourceHandle']
        ? { sourceHandle: entry['sourceHandle'] }
        : { sourceHandle: `${sourceBlock}-output-1` }),
      ...(typeof entry['targetHandle'] === 'string' && entry['targetHandle']
        ? { targetHandle: entry['targetHandle'] }
        : { targetHandle: `${targetBlock}-input-1` }),
    })
  }
  if (edges.length === 0 && nodes.length > 1) return null
  return {
    ...original,
    drawflow: {
      nodes: withPositions(nodes),
      edges,
      position: original.drawflow.position,
      zoom: original.drawflow.zoom,
    },
    updatedAt: Date.now(),
  }
}

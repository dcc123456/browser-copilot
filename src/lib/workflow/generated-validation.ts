/**
 * Static validation of GENERATED workflows — the gate between generation and
 * execution (spec §9/§12 Phase 6).
 *
 * Six layers, each checkable WITHOUT touching a browser:
 *   A graph    — connectivity, reachability, no orphan subgraphs
 *   B data     — data flow: variables/tables referenced are written somewhere
 *   C locator  — every element op carries a locator; strict identity beats
 *                position (positional-only locators are refused)
 *   D readiness— the contract is coherent (non-empty states, sane timeouts)
 *   E side effect — unsafe actions need idempotency + postconditions
 *   F goal     — generated-strict workflows must state a verifiable goal
 *
 * The report is structured evidence: `{code, severity, nodeId?, path?, message,
 * suggestedFix?}` — the chat can show it, the AI-repair loop (Phase 8) can act
 * on `error`-level issues only via LOCAL patches, and nothing here executes.
 *
 * @module lib/workflow/generated-validation
 */
import { BLOCK_BY_ID } from './blocks/palette'
import { LEGACY_ID_TO_AUTOMA } from './migrate'
import {
  goalSpecOf,
  isGeneratedStrict,
  nodeReliabilityOf,
  workflowHasUnsafeActions,
  type NodeReliabilitySpec,
} from './reliability'
import { deriveGoalSpecFromNodes } from './goal'
import { nodeGoalContractOf } from './node-goal-contract'
import type { Workflow, WorkflowNode } from './types'

/** Severity: `error` blocks the save/run; `warning`/`info` only annotate. */
export type GeneratedValidationSeverity = 'error' | 'warning' | 'info'

export interface GeneratedValidationIssue {
  code: string
  severity: GeneratedValidationSeverity
  nodeId?: string
  path?: string
  message: string
  suggestedFix?: string
}

export interface GeneratedValidationReport {
  ok: boolean
  errors: GeneratedValidationIssue[]
  warnings: GeneratedValidationIssue[]
  issues: GeneratedValidationIssue[]
}

// --- element-bearing blocks (locator layer C) ------------------------------------

/** Blocks that act on or read a page element (also the page-context guard's
 * "this node touches a page" set). */
export const ELEMENT_OP_BLOCKS: ReadonlySet<string> = new Set<string>([
  'event-click',
  'click',
  'hover-element',
  'forms',
  'get-text',
  'element-exists',
  'attribute-value',
  'wait-for',
  'set-checkbox',
  'select-option',
  'element-scroll',
])

/** Blocks that write variables or table cells (data layer B). */
const VARIABLE_WRITER_BLOCKS = new Set<string>([
  'set-variable',
  'webhook',
  'get-text',
  'attribute-value',
  'read-page',
  'element-exists',
  'counter',
  'date-now',
  'random-number',
  'get-secret',
  'prompt-text',
  'while-loop',
  'loop-data',
  'loop-elements',
  'repeat-task',
  'increment-variable',
  'forms',
])

/** Unsafe (non-idempotent) interaction verbs — the §5 classification. */
const UNSAFE_FORM_ACTIONS = new Set<string>(['submit', 'login', 'signup', 'pay', 'delete', 'send'])

interface ValidateCtx {
  isStrict: boolean
}

// --- helpers ---------------------------------------------------------------------

function blockIdOf(node: WorkflowNode): string {
  return typeof node?.data?.blockId === 'string' ? node.data.blockId : ''
}

function paramsOf(node: WorkflowNode): Record<string, unknown> {
  return (node?.data ?? {}) as Record<string, unknown>
}

function selectorOf(node: WorkflowNode): string {
  const p = paramsOf(node)
  return (
    (typeof p['selector'] === 'string' && p['selector']) ||
    (typeof p['cssSelector'] === 'string' && p['cssSelector']) ||
    ''
  )
}

/** Collect `{{token}}` references from every string in the node params. */
function refsOf(node: WorkflowNode): { vars: string[]; table: boolean } {
  const vars = new Set<string>()
  let table = false
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\{\{\s*([^}\s][^}]*?)\s*\}\}/g)) {
        const raw = m[1]!
        if (raw.startsWith('table')) table = true
        else vars.add(raw.split('.')[0]!.trim())
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk)
    }
  }
  walk(paramsOf(node))
  return { vars: [...vars], table }
}

// --- the six layers --------------------------------------------------------------

function validateGraph(workflow: Workflow, ctx: ValidateCtx): GeneratedValidationIssue[] {
  const issues: GeneratedValidationIssue[] = []
  const nodes = workflow.drawflow?.nodes ?? []
  const edges = workflow.drawflow?.edges ?? []
  if (nodes.length === 0) {
    issues.push({
      code: 'GRAPH_EMPTY',
      severity: 'error',
      message: '工作流没有任何节点。',
      suggestedFix: '重新生成，至少包含一个触发块。',
    })
    return issues
  }
  const nodeIds = new Set(nodes.map((n) => n.id))
  // The head: trigger node or the first node. Unreachable nodes are the bug.
  const head =
    nodes.find((n) => (n.data as Record<string, unknown> | undefined)?.['blockId'] === 'trigger') ??
    nodes[0]
  if (head) {
    const adjacency = new Map<string, string[]>()
    for (const e of edges) {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
      adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target])
    }
    const seen = new Set<string>([head.id])
    const queue = [head.id]
    while (queue.length) {
      const id = queue.shift()!
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) {
        issues.push({
          code: 'GRAPH_UNREACHABLE_NODE',
          severity: 'error',
          nodeId: n.id,
          path: `drawflow.nodes[id=${n.id}]`,
          message: `节点 "${n.label || n.id}" 从触发点不可达（断链或孤立节点）。`,
          suggestedFix: '重新生成该分支，或删除不可达节点。',
        })
      }
    }
  }
  // Unknown block ids would die at run time with "没有找到块执行器". Legacy
  // chat-saved ids resolve through the migration aliases first ('open-url' →
  // 'new-tab'), so a valid old graph is not flagged.
  for (const n of nodes) {
    const blockId = blockIdOf(n)
    const resolved = LEGACY_ID_TO_AUTOMA[blockId] ?? blockId
    if (blockId && !BLOCK_BY_ID.has(resolved)) {
      issues.push({
        code: 'GRAPH_UNKNOWN_BLOCK',
        severity: 'error',
        nodeId: n.id,
        path: `drawflow.nodes[id=${n.id}].blockId`,
        message: `未知块类型 "${blockId}"。`,
        suggestedFix: '使用 operator 工具重新添加该节点。',
      })
    }
  }
  void ctx
  return issues
}

function validateDataFlow(workflow: Workflow, ctx: ValidateCtx): GeneratedValidationIssue[] {
  const issues: GeneratedValidationIssue[] = []
  const nodes = workflow.drawflow?.nodes ?? []
  const written = new Set<string>()
  for (const n of nodes) {
    const blockId = blockIdOf(n)
    if (!VARIABLE_WRITER_BLOCKS.has(blockId)) continue
    const p = paramsOf(n)
    const name = typeof p['variableName'] === 'string' ? p['variableName'] : ''
    if (name) written.add(name)
    // forms fill writes its declared field variables at run time.
    if (blockId === 'forms' && Array.isArray(p['fields'])) {
      for (const field of p['fields'] as Array<Record<string, unknown>>) {
        if (typeof field?.['variableName'] === 'string') written.add(field['variableName'])
      }
    }
    if (blockId === 'forms' && typeof p['variableName'] === 'string') {
      written.add(p['variableName'])
    }
  }
  // Declared run inputs count as written (they are provided by the launcher).
  // They live in TWO homes: settings.inputs, and the trigger node's declared
  // list (where the generation path puts them, mirrored onto workflow.trigger).
  const triggerNode = nodes.find((n) => blockIdOf(n) === 'trigger')
  const triggerParams = triggerNode ? paramsOf(triggerNode) : undefined
  const inputSources: unknown[] = [
    (workflow.settings as unknown as Record<string, unknown> | undefined)?.['inputs'],
    (workflow.trigger as unknown as Record<string, unknown> | undefined)?.['inputs'],
    (workflow.trigger as unknown as Record<string, unknown> | undefined)?.['parameters'],
    triggerParams?.['inputs'],
    triggerParams?.['parameters'],
  ]
  for (const inputs of inputSources) {
    if (!Array.isArray(inputs)) continue
    for (const input of inputs as Array<Record<string, unknown>>) {
      if (typeof input?.['name'] === 'string') written.add(input['name'])
    }
  }
  for (const n of nodes) {
    const { vars } = refsOf(n)
    for (const v of vars) {
      if (!written.has(v)) {
        issues.push({
          code: 'DATA_UNWRITTEN_VARIABLE',
          severity: 'error',
          nodeId: n.id,
          path: `drawflow.nodes[id=${n.id}]`,
          message: `引用了变量 {{${v}}}，但没有任何节点写入它（运行时会替换为空）。`,
          suggestedFix: `先添加 set-variable 写入 ${v}，或改为字面量。`,
        })
      }
    }
  }
  void ctx
  return issues
}

function validateLocators(workflow: Workflow, ctx: ValidateCtx): GeneratedValidationIssue[] {
  const issues: GeneratedValidationIssue[] = []
  for (const n of workflow.drawflow?.nodes ?? []) {
    const blockId = blockIdOf(n)
    if (!ELEMENT_OP_BLOCKS.has(blockId)) continue
    const selector = selectorOf(n)
    if (!selector.trim()) {
      issues.push({
        code: 'LOCATOR_MISSING',
        severity: 'error',
        nodeId: n.id,
        path: `drawflow.nodes[id=${n.id}].selector`,
        message: `元素操作块 "${n.label || blockId}" 没有定位器。`,
        suggestedFix: '重新添加该节点并验证元素存在。',
      })
      continue
    }
    if (!ctx.isStrict) continue
    // Strict: identity beats position. A positional chain (nth-child / :eq /
    // bare index) is refused at GENERATION time — the runtime would only
    // refuse it later, after acting on the wrong element once.
    if (/(nth-child|nth-of-type|:eq\(|first-of-type|last-of-type)/i.test(selector)) {
      issues.push({
        code: 'LOCATOR_POSITIONAL',
        severity: 'error',
        nodeId: n.id,
        path: `drawflow.nodes[id=${n.id}].selector`,
        message: `定位器使用位置选择（nth-child/:eq），在 strict 模式下禁止：${selector}`,
        suggestedFix: '改用 testid/role/name/稳定文本定位。',
      })
    }
    // Random-looking generated classes/ids (ember-1234, css-1a2b3c) are the
    // classic re-render breakage; flag them as errors in strict mode.
    if (/(ember-|css-[a-z0-9]{6,}|sc-[a-zA-Z0-9]{5,}|__[a-z]+_[a-z0-9]{5,})/i.test(selector)) {
      issues.push({
        code: 'LOCATOR_UNSTABLE_TOKEN',
        severity: 'error',
        nodeId: n.id,
        path: `drawflow.nodes[id=${n.id}].selector`,
        message: `定位器包含疑似自动生成的不稳定片段：${selector}`,
        suggestedFix: '改用 testid/role/name/稳定文本定位。',
      })
    }
  }
  return issues
}

function validateReadiness(workflow: Workflow, ctx: ValidateCtx): GeneratedValidationIssue[] {
  const issues: GeneratedValidationIssue[] = []
  for (const n of workflow.drawflow?.nodes ?? []) {
    const spec: NodeReliabilitySpec | undefined = nodeReliabilityOf(n)
    if (!spec?.readiness) continue
    const blockId = blockIdOf(n)
    const before = spec.readiness.before ?? []
    const after = spec.readiness.after ?? []
    if (before.length === 0 && after.length === 0 && !ctx.isStrict) {
      // An explicit but EMPTY contract on a non-strict run is a lint-level
      // smell; on strict runs the block default fills it, so no issue there.
      issues.push({
        code: 'READINESS_EMPTY',
        severity: 'info',
        nodeId: n.id,
        message: `节点 "${n.label || blockId}" 声明了空的就绪契约。`,
      })
    }
    for (const req of [...before, ...after]) {
      if (typeof req.timeoutMs === 'number' && (req.timeoutMs <= 0 || req.timeoutMs > 60_000)) {
        issues.push({
          code: 'READINESS_TIMEOUT_RANGE',
          severity: 'error',
          nodeId: n.id,
          path: `drawflow.nodes[id=${n.id}].__reliability.readiness`,
          message: `就绪超时 ${req.timeoutMs}ms 超出 (0, 60000] 窗口。`,
          suggestedFix: '使用 8000ms（默认）或 ≤60s 的窗口。',
        })
      }
    }
  }
  return issues
}

function validateSideEffects(workflow: Workflow, ctx: ValidateCtx): GeneratedValidationIssue[] {
  const issues: GeneratedValidationIssue[] = []
  for (const n of workflow.drawflow?.nodes ?? []) {
    const blockId = blockIdOf(n)
    if (blockId !== 'forms' && blockId !== 'event-click' && blockId !== 'webhook') continue
    const spec = nodeReliabilityOf(n)
    if (!ctx.isStrict) {
      // Compat keeps running regardless — the contract is advisory there.
      continue
    }
    const p = paramsOf(n)
    const verb = String(p['action'] ?? p['event'] ?? blockId)
    const unsafe = UNSAFE_FORM_ACTIONS.has(verb) || spec?.idempotency === 'unsafe'
    if (!unsafe) continue
    if (!spec?.idempotency) {
      issues.push({
        code: 'SIDE_EFFECT_IDEMPOTENCY_MISSING',
        severity: 'error',
        nodeId: n.id,
        path: `drawflow.nodes[id=${n.id}].__reliability.idempotency`,
        message: `副作用动作 "${verb}" 未声明幂等性（strict 模式要求）。`,
        suggestedFix: '为该节点标注 idempotency（unsafe 动作必须先做终态检查）。',
      })
    }
    if (!spec?.postconditions?.length) {
      issues.push({
        code: 'SIDE_EFFECT_POSTCONDITION_MISSING',
        severity: 'error',
        nodeId: n.id,
        path: `drawflow.nodes[id=${n.id}].__reliability.postconditions`,
        message: `副作用动作 "${verb}" 没有可验证的后置条件（无法判断"已生效"）。`,
        suggestedFix: '声明动作完成后的可观察事实（如 URL 变化、成功提示出现）。',
      })
    }
  }
  return issues
}

function validateGoal(workflow: Workflow, ctx: ValidateCtx): GeneratedValidationIssue[] {
  const issues: GeneratedValidationIssue[] = []
  if (!ctx.isStrict) return issues
  // The goal is mandatory ONLY where a false "成功" is dangerous: graphs with
  // unsafe (non-idempotent) actions. Read-only graphs without a goal save and
  // run — the L3 gate skips, honestly reporting "nothing to verify".
  if (!workflowHasUnsafeActions(workflow)) return issues
  // The goal may be declared on settings OR derivable from the graph's own
  // postconditions (what the assembly path stamps). Either source satisfies
  // the layer — both mean the workflow can STATE what done means.
  const goal =
    goalSpecOf(workflow) ??
    deriveGoalSpecFromNodes({ name: workflow.name, nodes: workflow.drawflow?.nodes ?? [] })
  // Every generated action node must carry a Node Goal Contract (spec V64).
  for (const node of workflow.drawflow?.nodes ?? []) {
    if (node.data?.blockId === 'trigger') continue
    if (!nodeGoalContractOf(node.data)) {
      issues.push({
        code: 'NODE_GOAL_MISSING',
        severity: 'error',
        nodeId: node.id,
        path: `drawflow.nodes[${node.id}].data.__workflowAi`,
        message: '生成的动作节点缺少节点目标契约（node goal contract）。',
        suggestedFix: '重新生成该节点，使其携带 goal 与 successCriteria。',
      })
    }
  }
  if (!goal) {
    issues.push({
      code: 'GOAL_MISSING',
      severity: 'error',
      path: 'settings.goalSpec',
      message:
        '工作流包含不可逆动作（提交/登录/发送/支付/删除）但没有可验证的目标（goalSpec）——无法判断动作"已生效"。',
      suggestedFix: '在关键动作节点声明 postconditions（由其派生 goal），或显式提供 goalSpec。',
    })
  }
  return issues
}

// --- entry -----------------------------------------------------------------------

/**
 * Validate a generated workflow. `ok` is false iff there is at least one
 * `error`-level issue (warnings do not block).
 */
export function validateGeneratedWorkflow(workflow: Workflow): GeneratedValidationReport {
  const ctx: ValidateCtx = { isStrict: isGeneratedStrict(workflow) }
  let issues = [
    ...validateGraph(workflow, ctx),
    ...validateDataFlow(workflow, ctx),
    ...validateLocators(workflow, ctx),
    ...validateReadiness(workflow, ctx),
    ...validateSideEffects(workflow, ctx),
    ...validateGoal(workflow, ctx),
  ]
  // Compat workflows are NEVER gated: every layer still runs and reports, but
  // demoted to warnings, so the report stays useful for review and the AI-
  // repair loop while legacy runs keep their exact behavior.
  if (!ctx.isStrict) {
    issues = issues.map((i) => ({ ...i, severity: 'warning' as const }))
  }
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning' || i.severity === 'info')
  return { ok: errors.length === 0, errors, warnings, issues }
}

/** The issue codes that block a generated-strict save/run. */
export function blockingIssues(report: GeneratedValidationReport): GeneratedValidationIssue[] {
  return report.errors
}

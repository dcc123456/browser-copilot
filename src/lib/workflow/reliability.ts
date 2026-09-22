/**
 * The Workflow Reliability Contract.
 *
 * The core idea of the reliability work: a workflow is a PROGRAM, not a list
 * of actions, and AI-generated workflows must carry a machine-checkable
 * contract saying what "done" means — which steps are dangerous to repeat,
 * which element is meant, what must hold before/after each step, and what the
 * whole run must have achieved before anyone may call it a success.
 *
 * Where the contract lives (old JSON stays valid — every field is optional):
 *
 *   - workflow level: `settings.reliabilityMode`, `settings.goalSpec`
 *   - node level:     `node.data.__reliability`
 *
 * Mode resolution (`reliabilityModeOf`):
 *
 *   1. an explicit `settings.reliabilityMode` always wins;
 *   2. a generation provenance (`chat-generate` / `chat-history`) implies
 *      `generated-strict` — that is what "AI 生成的 Workflow 默认进入
 *      generated-strict" means;
 *   3. everything else (hand-made, imported, historic) is `compat`.
 *
 * `compat` keeps today's behavior bit for bit; only diagnostics may be added.
 * `generated-strict` is where the strict locator, readiness, postcondition and
 * goal-verification machinery applies.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/reliability
 */
import type { WorkflowCondition } from './conditions'
import { workflowConditionsOf } from './conditions'
import type { ReadinessSpec } from './readiness'
import { normalizeReadinessSpec } from './readiness'
import type { SemanticLocator } from './element-fingerprint'
import type { Workflow, WorkflowNode } from './types'

/** Which execution regime a workflow runs under. */
export type WorkflowReliabilityMode = 'compat' | 'generated-strict'

/**
 * Can this action be repeated without harm?
 *
 * - `safe` — reads, scrolls, navigation: retry freely.
 * - `conditional` — fills / selects / toggles: the effect is idempotent ONLY
 *   while the pre-state holds; retry after verifying it.
 * - `unsafe` — login / submit / send / create / delete / pay / publish: a
 *   blind replay can double the effect. Terminal-state check FIRST.
 */
export type IdempotencyLevel = 'safe' | 'conditional' | 'unsafe'

/** What to do when a locator matches more than one element. */
export type AmbiguityPolicy = 'error' | 'score' | 'first-visible'

/** The workflow-level goal: what "success" means, checkably. */
export interface WorkflowGoalSpec {
  /** One-line human summary of the goal. */
  summary: string
  /** Conditions that must ALL hold for the run to count as successful. */
  successConditions: WorkflowCondition[]
  /**
   * Conditions identifying the terminal state of a NON-IDEMPOTENT goal —
   * "already logged in", "order already placed". When these hold the goal is
   * achieved even if the run never re-demonstrated it.
   */
  terminalStateConditions?: WorkflowCondition[]
}

/** Per-node locator reliability metadata (saved by generation, read by runtime). */
export interface NodeLocatorSpec {
  /** The semantic identity recorded for the element, when one was observed. */
  semantic?: SemanticLocator
  /** Whether the recorded CSS selector was live-probed to match exactly one. */
  selectorVerified?: boolean
}

/** The per-node reliability contract (`node.data.__reliability`). */
export interface NodeReliabilitySpec {
  /** What this step is FOR, in intent language (drives diagnosis + repair). */
  intent?: string
  /** Repeat-safety of this step. Classified from block+intent when absent. */
  idempotency?: IdempotencyLevel
  /** Facts that must hold before the step runs. */
  preconditions?: WorkflowCondition[]
  /** Facts that must hold after the step ran. */
  postconditions?: WorkflowCondition[]
  /** What the page must look like before/after (the wait contract). */
  readiness?: ReadinessSpec
  /** Locator reliability metadata (semantic identity + probe result). */
  locator?: NodeLocatorSpec
}

// --- Mode resolution -----------------------------------------------------------

/**
 * Resolve the reliability mode of a workflow. See the module docblock for the
 * precedence. Tolerates unknown values (falls back to compat).
 */
export function reliabilityModeOf(workflow: Workflow): WorkflowReliabilityMode {
  const explicit = (workflow.settings as unknown as Record<string, unknown> | undefined)?.[
    'reliabilityMode'
  ]
  if (explicit === 'generated-strict') return 'generated-strict'
  if (explicit === 'compat') return 'compat'
  const provenance = workflow.settings?.provenance
  if (provenance === 'chat-generate' || provenance === 'chat-history') {
    return 'generated-strict'
  }
  return 'compat'
}

/** Shorthand: does this workflow run under generated-strict? */
export function isGeneratedStrict(workflow: Workflow): boolean {
  return reliabilityModeOf(workflow) === 'generated-strict'
}

// --- Goal spec ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The workflow's goal spec, when present AND well-formed. Garbage shapes are
 * treated as absent (the strict gate then reports the missing goal).
 */
export function goalSpecOf(workflow: Workflow): WorkflowGoalSpec | undefined {
  const raw = (workflow.settings as unknown as Record<string, unknown> | undefined)?.['goalSpec']
  if (!isRecord(raw)) return undefined
  if (typeof raw['summary'] !== 'string' || !raw['summary'].trim()) return undefined
  const successConditions = workflowConditionsOf(raw['successConditions'])
  if (successConditions.length === 0) return undefined
  const terminalStateConditions = workflowConditionsOf(raw['terminalStateConditions'])
  return {
    summary: raw['summary'],
    successConditions,
    ...(terminalStateConditions.length ? { terminalStateConditions } : {}),
  }
}

/**
 * The strict-mode gate problems for the GOAL part of the contract: a
 * generated-strict workflow without a usable goal spec must not save or run.
 * (The save/run integration lives in the generated validator; this is the
 * shared predicate.)
 */
export function goalGateProblems(workflow: Workflow): string[] {
  if (!isGeneratedStrict(workflow)) return []
  // The goal gate protects against FALSE "成功" claims on side effects — so it
  // is only a hard requirement when the graph actually performs UNSAFE
  // (non-idempotent) actions. A read-only generated workflow (读页面/导出/导航)
  // without a declared goal still saves and runs; the L3 verification simply
  // skips (nothing to verify against), which is honest — not a silent pass.
  if (!workflowHasUnsafeActions(workflow)) return []
  const raw = (workflow.settings as unknown as Record<string, unknown> | undefined)?.['goalSpec']
  if (!isRecord(raw) || typeof raw['summary'] !== 'string' || !raw['summary'].trim()) {
    return [
      'generated-strict 工作流包含不可逆动作（提交/登录/发送/支付/删除）但缺少目标说明：' +
        '请在这些关键动作节点的 __reliability.postconditions 里声明"完成后必然可观察的事实"，保存时会自动派生 goalSpec',
    ]
  }
  if (goalSpecOf(workflow) === undefined) {
    return [
      'generated-strict 工作流缺少可验证的成功条件（settings.goalSpec.successConditions）' +
        '——不可逆动作必须声明 postconditions 才能判断"已生效"',
    ]
  }
  return []
}

/**
 * Whether any node of the workflow performs an UNSAFE (non-idempotent)
 * action — the condition under which a verifiable goal is mandatory.
 */
export function workflowHasUnsafeActions(workflow: Workflow): boolean {
  return (workflow.drawflow?.nodes ?? []).some((node) => {
    const data = (node.data ?? {}) as Record<string, unknown>
    const blockId = typeof data['blockId'] === 'string' ? data['blockId'] : ''
    return idempotencyOf(blockId, data, nodeReliabilityOf(node)) === 'unsafe'
  })
}

// --- Node contract ----------------------------------------------------------------

/** The `data` key the node-level contract lives under. */
export const NODE_RELIABILITY_KEY = '__reliability'

/** A node's explicit `__reliability` contract, when present and well-formed. */
export function nodeReliabilityOf(node: WorkflowNode): NodeReliabilitySpec | undefined {
  const raw = node.data?.[NODE_RELIABILITY_KEY]
  if (!isRecord(raw)) return undefined
  const spec: NodeReliabilitySpec = {}
  if (typeof raw['intent'] === 'string' && raw['intent'].trim()) spec.intent = raw['intent']
  if (raw['idempotency'] === 'safe' || raw['idempotency'] === 'conditional' || raw['idempotency'] === 'unsafe') {
    spec.idempotency = raw['idempotency']
  }
  const preconditions = workflowConditionsOf(raw['preconditions'])
  if (preconditions.length) spec.preconditions = preconditions
  const postconditions = workflowConditionsOf(raw['postconditions'])
  if (postconditions.length) spec.postconditions = postconditions
  const readiness = normalizeReadinessSpec(raw['readiness'])
  if (readiness) spec.readiness = readiness
  if (isRecord(raw['locator'])) {
    const locatorRaw = raw['locator'] as Record<string, unknown>
    const locator: NodeLocatorSpec = {}
    if (isRecord(locatorRaw['semantic'])) {
      locator.semantic = locatorRaw['semantic'] as SemanticLocator
    }
    if (typeof locatorRaw['selectorVerified'] === 'boolean') {
      locator.selectorVerified = locatorRaw['selectorVerified']
    }
    if (locator.semantic || locator.selectorVerified !== undefined) spec.locator = locator
  }
  return Object.keys(spec).length > 0 ? spec : undefined
}

/** Attach a reliability contract to a node's data (pure: returns new data). */
export function withNodeReliability(
  data: Record<string, unknown>,
  spec: NodeReliabilitySpec,
): Record<string, unknown> {
  return { ...data, [NODE_RELIABILITY_KEY]: spec }
}

// --- Idempotency classification (block + intent, never blockId alone) -------------

/** Blocks whose DEFAULT is repeat-safe (reads, navigation, local data ops). */
const SAFE_BLOCK_IDS: ReadonlySet<string> = new Set([
  'get-text',
  'read-page',
  'attribute-value',
  'element-exists',
  'get-form',
  'take-screenshot',
  'element-scroll',
  'scroll',
  'wait-for',
  'delay',
  'new-tab',
  'new-window',
  'open-url',
  'go-back',
  'forward-page',
  'reload-tab',
  'switch-tab',
  'close-tab',
  'tab-url',
  'active-tab',
  'set-variable',
  'get-variable',
  'increase-variable',
  'slice-variable',
  'regex-variable',
  'data-mapping',
  'log-data',
  'loop-breakpoint',
])

/**
 * Blocks whose DEFAULT is conditional: the effect lands on an element and is
 * repeatable only while the pre-state holds. Element actions that could carry
 * an unsafe intent (a click that submits a form) live here and are UPGRADED to
 * unsafe by the intent keywords below.
 */
const CONDITIONAL_BLOCK_IDS: ReadonlySet<string> = new Set([
  'click',
  'event-click',
  'hover-element',
  'forms',
  'fill',
  'select-option',
  'set-checkbox',
  'set-radio',
  'press-key',
  'upload-file',
  'trigger-event',
  'create-element',
  'handle-dialog',
  'javascript-code',
])

/** Blocks whose DEFAULT is unsafe: they send or commit something by design. */
const UNSAFE_BLOCK_IDS: ReadonlySet<string> = new Set(['webhook', 'feishu-message'])

/**
 * Intent keywords that upgrade a conditional action to unsafe. The POINT of
 * the reliability contract: a `click` whose intent says "提交订单" is a submit,
 * whatever the block id says.
 */
const UNSAFE_INTENT_PATTERN =
  /(登录|登入|提交|发送|创建|新建|删除|支付|付款|发布|下单|购买|下单|确认订单|注销|login|log[\s-]?in|sign[\s-]?in|submit|send|create|delete|remove|pay|payment|checkout|publish|purchase|place[\s-]?order)/i

/** The node's declared intent, from the contract (falls back to `description`). */
export function intentOf(node: WorkflowNode): string {
  const spec = nodeReliabilityOf(node)
  if (spec?.intent) return spec.intent
  const description = node.data?.['description']
  return typeof description === 'string' ? description : ''
}

/**
 * Classify the repeat-safety of one step. Order:
 *
 *   1. explicit `__reliability.idempotency` — the contract wins;
 *   2. block default (`webhook` unsafe, reads safe, element actions conditional);
 *   3. intent keywords upgrade a conditional action to unsafe;
 *   4. unknown blocks stay `conditional` (the cautious middle).
 *
 * `data` participates for composite blocks: a `forms` block is only unsafe
 * when it actually SUBMITS (`action: 'submit'`), not when it fills a field.
 */
export function idempotencyOf(
  blockId: string,
  data: Record<string, unknown> = {},
  spec?: NodeReliabilitySpec,
): IdempotencyLevel {
  if (spec?.idempotency) return spec.idempotency
  if (blockId === 'forms' && String(data['action'] ?? 'fill') === 'submit') return 'unsafe'
  if ((UNSAFE_BLOCK_IDS as ReadonlySet<string>).has(blockId)) return 'unsafe'
  if ((SAFE_BLOCK_IDS as ReadonlySet<string>).has(blockId)) return 'safe'
  if ((CONDITIONAL_BLOCK_IDS as ReadonlySet<string>).has(blockId)) {
    const intent = intentOf({
      id: '',
      label: blockId,
      position: { x: 0, y: 0 },
      data,
    })
    return UNSAFE_INTENT_PATTERN.test(intent) ? 'unsafe' : 'conditional'
  }
  return 'conditional'
}

/** Does this step require a terminal-state check before ANY blind replay? */
export function requiresTerminalStateCheck(
  blockId: string,
  data: Record<string, unknown>,
  spec?: NodeReliabilitySpec,
): boolean {
  return idempotencyOf(blockId, data, spec) === 'unsafe'
}

// --- Ambiguity policy --------------------------------------------------------------

/**
 * Strict mode's ambiguity constants (§6.2). Kept next to the policy so the
 * kernel, the executors and the tests read ONE definition.
 */
export const STRICT_AMBIGUITY: AmbiguityPolicy = 'score'
export const STRICT_MIN_SCORE = 70
export const STRICT_MIN_MARGIN = 12

/** The ambiguity policy a workflow runs with: strict scores, compat keeps the legacy first-visible. */
export function ambiguityPolicyOf(workflow: Workflow): AmbiguityPolicy {
  return isGeneratedStrict(workflow) ? STRICT_AMBIGUITY : 'first-visible'
}

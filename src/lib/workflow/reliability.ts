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
import { nodeGoalContractOf } from './node-goal-contract'
import { BLOCK_CATALOG } from './blocks/catalog'

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
  /**
   * Repair hints recorded at generation time (spec §36): tells the repair
   * orchestrator which strategies to prefer for THIS node — e.g. "fix the
   * selector first" or "selector repair is low-value, go straight to a
   * semantic target".
   */
  repairHints?: {
    preferredStrategies?: import('./repair-session').RepairStrategy[]
    allowGraphEdit?: boolean
    allowReplan?: boolean
  }
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
  if (
    raw['idempotency'] === 'safe' ||
    raw['idempotency'] === 'conditional' ||
    raw['idempotency'] === 'unsafe'
  ) {
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

/**
 * Only the hyphenated block ids are scrubbed. A single-word id (`forms`, `note`,
 * `link`, `clipboard`) is ordinary English that a real intent may well contain,
 * and none of them hide an unsafe keyword; the multi-segment ones are operator
 * names, which only ever appear in prose ABOUT the toolset.
 */
const BLOCK_NAME_PATTERN = (() => {
  const names = BLOCK_CATALOG.map((entry) => entry.id)
    .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(id))
    .sort((a, b) => b.length - a.length)
  return names.length > 0 ? new RegExp(names.join('|'), 'gi') : null
})()

/**
 * A clause that FORBIDS a verb is not asking for it — 「保存为草稿，不发布」.
 *
 * Exported because the draft-save test needs the same reading: the one sentence
 * that documents a draft also names the publish it declines.
 *
 * The two optional groups exist because a prohibition is usually written with a
 * light verb and an adverb between the negation and the act: round 30's terminal
 * step said 「保存为草稿，不执行正式发布」 and the bare form matched none of it, so the
 * graph that really ended on its draft save was reported as having no save step
 * at all. The window stays clause-local (no wildcard over punctuation), so
 * 「点击发布，不要撤销」 still reads as the publish it is.
 */
export const NEGATED_COMMIT_VERB =
  /(?:绝不|决不|不可|不能|不要|不用|无法|禁止|未|别|勿|不|\bnot\b|\bnever\b|\bwithout\b)[\s,，、]{0,6}?(?:执行|进行|实施|予以|做|发起|触发|点击|按下|单击|会|能|要|应|打算|准备|计划|click|press|execute|perform)?[\s,，、]{0,4}?(?:正式|直接|手动|自动|再次|重复|actually|really|manually|directly)?[\s,，、]{0,4}?(?:发布|发表|提交|发送|下单|支付|付款|购买|publish|\bpost\b|submit|send|checkout|purchase)/gi

/**
 * 「发布页 / 发布平台 / 图文发布 / 发布模式」 names WHERE the step stands, not what it does.
 *
 * The mode variant is round 81: a generated step whose job was switching the
 * composer to 图文 mode says 「在发布页顶部切换到「上传图文」发布模式」, the trial read the
 * remaining 发布 as a publish act, stopped at step 6 of 41, and never reached the
 * draft save. A mode tab is the same class of place name as a page tab — what
 * makes a step unsafe is its own words naming the press (「点击发布按钮」), and those
 * are untouched here.
 */
export const PAGE_NAME_ESCAPE =
  /(发布|发表|提交|发送)[\s,，、]?(?:页面?|页|平台|中心|编辑器|区|列表|管理|模式)/g

/**
 * Closing an overlay is not the act its name reminds of.
 *
 * Round 73's trial stopped at step 7/29 on 「关闭登录弹窗」 — a click that shuts a
 * login popup — because 登录/login is an unsafe keyword and the popup's own name
 * was the only prose the step had. The escape needs the OVERLAY noun, not just the
 * verb: 「关闭订单」 is a real state change and must keep refusing.
 */
const DISMISS_OVERLAY_ESCAPE =
  /(?:关闭|关掉|收起|取消|忽略|跳过|dismiss|close|cancel|hide)[^，,。.;；\n]{0,14}?(?:弹窗|弹层|对话框|对话窗|浮层|浮窗|遮罩|提示框|popup|popover|modal|dialog|toast|overlay)/gi

/**
 * A selector is a machine handle, not a claim about the action.
 *
 * The node label the generator stamps embeds the resolved selector — 「Click the
 * target element (.close-circle, .login-close, …)」 — and `.login-close` matched
 * the login keyword for the same reason the block ids had to be scrubbed.
 */
const SELECTOR_PARENTHETICAL = /\((?:[^()]*[.#[\]>][^()]*)\)/g

/**
 * The prose the unsafe-intent keywords are scanned against.
 *
 * The page-name escape removes a phrase that names the PLACE a step stands on —
 * 「图文发布页」 is not a step that publishes. Without it, a generated upload step
 * whose own contract mentions the 发布页 it sits on classifies as a publish and
 * the trial stops before the images the goal asked for (round 20 stopped at 11/26
 * on exactly that sentence, and the script path has carried this escape ever since).
 *
 * A PROHIBITION is deliberately not removed here. 「把笔记留在草稿箱，绝不发布」 still
 * refuses the step under the default policy: naming a publish, even to decline it,
 * is not evidence that the step is safe to re-fire. Running such a step is a
 * separate, opt-in decision, and `isDraftSaveNode` is where that decision strips
 * the negation and asks whether the step instead names a DRAFT.
 */
function intentForKeywordScan(intent: string): string {
  const withoutBlockNames = BLOCK_NAME_PATTERN ? intent.replace(BLOCK_NAME_PATTERN, ' ') : intent
  return withoutBlockNames
    .replace(SELECTOR_PARENTHETICAL, ' ')
    .replace(DISMISS_OVERLAY_ESCAPE, '关闭浮层')
    .replace(PAGE_NAME_ESCAPE, '页')
}

/**
 * Does this prose describe an action that cannot be taken back?
 *
 * The keyword test the reliability contract runs on a step's intent, exposed for
 * callers that have nothing else to read. A node generated without a contract
 * carries its meaning in its LABEL — 「点击「发布」按钮」 and no intent field — and
 * a caller deciding whether to re-fire that click cannot afford to see a
 * harmless block id and assume the step is harmless.
 */
export function hasUnsafeIntent(text: string): boolean {
  if (!text) return false
  return UNSAFE_INTENT_PATTERN.test(intentForKeywordScan(text))
}

/** The node's declared intent, from the contract (falls back to `description`). */
export function intentOf(node: WorkflowNode): string {
  const spec = nodeReliabilityOf(node)
  if (spec?.intent) return spec.intent
  const description = node.data?.['description']
  if (typeof description === 'string' && description) return description
  // A chat-generated step has neither: `appendOperatorNode` labels the node with
  // the block id, and the sentence the model spoke for the step — 「点击暂存草稿」,
  // which is the ONLY thing distinguishing it from 「点击发布」 — is recorded on the
  // node's goal contract. Without this reading, every generated click is
  // prose-less, so the commit policy cannot refuse a publish and a run that did
  // save a draft cannot prove it.
  const goal = node.data ? nodeGoalContractOf(node.data)?.goal : undefined
  return typeof goal === 'string' ? goal : ''
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
    return hasUnsafeIntent(intent) ? 'unsafe' : 'conditional'
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

// --- Cleanup steps ---------------------------------------------------------------

/** 「关闭 / 收起 / dismiss / close」 — an act of making something go away. */
const DISMISS_VERB = /关闭|关掉|收起|取消|退出|隐藏|撤掉|移除|\bdismiss\b|\bclose\b|\bcancel\b|\bhide\b/i

/** The thing dismissed: an overlay the page shows CONDITIONALLY. */
const OVERLAY_NOUN =
  /抽屉|弹[出窗框级]|对话框|遮罩|浮层|弹窗|侧栏|提示|气泡|drawer|modal|dialog|overlay|popup|popover|toast|backdrop|banner/i

/**
 * Is this click only there to dismiss an overlay?
 *
 * An exploratory session opens things: the agent browsing 小红书 pulled the
 * 草稿箱 drawer out, then clicked its close button, and that cleanup became a
 * node in the graph (round 31, node `muqd93gb` — 8 s of waiting, then
 * `READINESS_TIMEOUT(visible)` at step 7 of 17, because on a clean replay the
 * drawer was NEVER OPEN and its close button stays hidden).
 *
 * Such a step is skipped, not failed, when its target does not appear: its own
 * success state is "this overlay is gone", which holds just as hard when there
 * was nothing to dismiss — the page is in the same state either way. Requiring
 * BOTH a dismissal verb and an overlay noun keeps this to cleanup; a step that
 * names an outward act is never excused this way.
 */
export function isDismissStep(node: WorkflowNode): boolean {
  const blockId = String(node.data?.['blockId'] ?? node.label ?? '')
  if (blockId !== 'click' && blockId !== 'event-click') return false
  const prose = [intentOf(node), String(node.data?.['label'] ?? '')]
    .join(' ')
    .trim()
  if (!prose || hasUnsafeIntent(prose)) return false
  return DISMISS_VERB.test(prose) && OVERLAY_NOUN.test(prose)
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

/**
 * Whether a strict run may DEGRADE through the node's candidate chain where the
 * score alone would refuse the match (the `rank` policy, see `lib/ops`).
 *
 * Default ON for generated-strict workflows. Refusal was the wrong remedy for
 * an ambiguous locator: it lost a step the agent had already performed
 * correctly, so a workflow that should have replayed eight of eight steps came
 * home with seven and an apology. Degrading keeps the step AND keeps the
 * evidence — every rung below the clean winner is reported on the node, so a
 * run that needed the ladder is never mistaken for a verified one.
 * `settings.degradeReplay: false` is the explicit opt-out.
 */
export function degradeReplayOf(workflow: Workflow): boolean {
  const raw = (workflow.settings as unknown as Record<string, unknown> | undefined)?.[
    'degradeReplay'
  ]
  if (typeof raw === 'boolean') return raw
  return isGeneratedStrict(workflow)
}

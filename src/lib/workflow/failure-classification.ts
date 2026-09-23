/**
 * Workflow failure classification (spec §26, Commit 7).
 *
 * The standard 23-class failure vocabulary shared by the runtime guard and
 * the repair orchestrator, plus a deterministic classifier. Classification
 * priority (spec §26):
 *
 * ```text
 * 1. structured runner code / known error mapping
 * 2. DOM evidence
 * 3. LLM diagnosis — only when 1+2 cannot decide
 * ```
 *
 * Not every failure is handed to the LLM: the error-message patterns below
 * deterministically map the failure shapes the executors actually emit, so
 * the same failure always classifies the same way (and costs no model call).
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/failure-classification
 */

// --- Vocabulary (spec §26) ----------------------------------------------------

export type WorkflowFailureType =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_AMBIGUOUS'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'SELECTOR_STALE'
  | 'PAGE_NOT_READY'
  | 'NAVIGATION_TIMEOUT'
  | 'FRAME_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'INPUT_REJECTED'
  | 'INVALID_PARAMETER'
  | 'STATE_MISMATCH'
  | 'POSTCONDITION_FAILED'
  | 'GOAL_NOT_SATISFIED'
  | 'WORKFLOW_GRAPH_INVALID'
  | 'MODEL_NO_CANDIDATE'
  | 'MODEL_OUTPUT_INVALID'
  | 'AUTH_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'MFA_REQUIRED'
  | 'SIDE_EFFECT_UNKNOWN'
  | 'MODEL_ERROR'
  | 'UNKNOWN'

export const WORKFLOW_FAILURE_TYPES: readonly WorkflowFailureType[] = [
  'ELEMENT_NOT_FOUND',
  'ELEMENT_AMBIGUOUS',
  'ELEMENT_NOT_VISIBLE',
  'ELEMENT_NOT_INTERACTABLE',
  'SELECTOR_STALE',
  'PAGE_NOT_READY',
  'NAVIGATION_TIMEOUT',
  'FRAME_NOT_FOUND',
  'TAB_NOT_FOUND',
  'INPUT_REJECTED',
  'INVALID_PARAMETER',
  'STATE_MISMATCH',
  'POSTCONDITION_FAILED',
  'GOAL_NOT_SATISFIED',
  'WORKFLOW_GRAPH_INVALID',
  'MODEL_NO_CANDIDATE',
  'MODEL_OUTPUT_INVALID',
  'AUTH_REQUIRED',
  'CAPTCHA_REQUIRED',
  'MFA_REQUIRED',
  'SIDE_EFFECT_UNKNOWN',
  'MODEL_ERROR',
  'UNKNOWN',
]

export function isWorkflowFailureType(value: unknown): value is WorkflowFailureType {
  return typeof value === 'string' && (WORKFLOW_FAILURE_TYPES as readonly string[]).includes(value)
}

// --- Safety semantics per failure type ----------------------------------------

export interface FailureTypePolicy {
  /** A bounded re-observe / retry can plausibly fix it. */
  retryable: boolean
  /** It is an ordinary automatic-repair candidate (never an immediate human). */
  autoRepairable: boolean
  /** Replaying the action blindly is dangerous. */
  unsafeToRetry: boolean
  /** The failure is an external human gate (auth / CAPTCHA / MFA). */
  humanGate: boolean
}

const TYPE_POLICY: Record<WorkflowFailureType, FailureTypePolicy> = {
  ELEMENT_NOT_FOUND: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  ELEMENT_AMBIGUOUS: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  ELEMENT_NOT_VISIBLE: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  ELEMENT_NOT_INTERACTABLE: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  SELECTOR_STALE: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  PAGE_NOT_READY: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  NAVIGATION_TIMEOUT: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  FRAME_NOT_FOUND: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  TAB_NOT_FOUND: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  INPUT_REJECTED: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  INVALID_PARAMETER: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  STATE_MISMATCH: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  POSTCONDITION_FAILED: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  GOAL_NOT_SATISFIED: { retryable: false, autoRepairable: true, unsafeToRetry: true, humanGate: false },
  WORKFLOW_GRAPH_INVALID: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  MODEL_NO_CANDIDATE: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  MODEL_OUTPUT_INVALID: { retryable: false, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  AUTH_REQUIRED: { retryable: false, autoRepairable: false, unsafeToRetry: false, humanGate: true },
  CAPTCHA_REQUIRED: { retryable: false, autoRepairable: false, unsafeToRetry: false, humanGate: true },
  MFA_REQUIRED: { retryable: false, autoRepairable: false, unsafeToRetry: false, humanGate: true },
  SIDE_EFFECT_UNKNOWN: { retryable: false, autoRepairable: false, unsafeToRetry: true, humanGate: false },
  MODEL_ERROR: { retryable: true, autoRepairable: true, unsafeToRetry: false, humanGate: false },
  UNKNOWN: { retryable: false, autoRepairable: false, unsafeToRetry: false, humanGate: false },
}

export function failureTypePolicy(type: WorkflowFailureType): FailureTypePolicy {
  return TYPE_POLICY[type]
}

/**
 * Whether a failure of this type may EVER go straight to human takeover.
 *
 * Per spec §21.2 the ordinary locator/timing/parameter failures must enter
 * the automatic repair ladder instead. Only external gates, the
 * side-effect-unknown safety condition, and the final "all strategies
 * exhausted" state justify a human takeover.
 */
export function allowsImmediateHumanTakeover(type: WorkflowFailureType): boolean {
  const policy = TYPE_POLICY[type]
  return policy.humanGate || type === 'SIDE_EFFECT_UNKNOWN'
}

// --- Deterministic classification ---------------------------------------------

/**
 * Ordered pattern rules over the raw error message. The first match wins;
 * order matters (e.g. "not visible" must be tested after a navigation
 * timeout only where they can overlap).
 */
const MESSAGE_RULES: ReadonlyArray<{ pattern: RegExp; type: WorkflowFailureType }> = [
  { pattern: /SIDE_EFFECT_UNKNOWN|side effect.*unknown|副作用结果未知|结果未知.*拒绝自动重放/i, type: 'SIDE_EFFECT_UNKNOWN' },
  { pattern: /\bMFA\b|multi[\s-]?factor|2FA|两步验证|二次验证|验证码(?!.*captcha)/i, type: 'MFA_REQUIRED' },
  { pattern: /captcha|人机验证|安全验证/i, type: 'CAPTCHA_REQUIRED' },
  { pattern: /auth(entication)? required|login required|sign[\s-]?in required|需要登录|请先登录|未登录/i, type: 'AUTH_REQUIRED' },
  { pattern: /no patch proposed|no candidate|MODEL_NO_CANDIDATE|没有可(用的)?(修复|补丁|patch)|empty proposal/i, type: 'MODEL_NO_CANDIDATE' },
  { pattern: /invalid model output|malformed (response|output|candidate)|bad json|MODEL_OUTPUT_INVALID|模型输出(无效|不合法)/i, type: 'MODEL_OUTPUT_INVALID' },
  { pattern: /model error|llm error|provider error|completion.*failed|模型(调用)?(错误|失败)/i, type: 'MODEL_ERROR' },
  { pattern: /postcondition.*(fail|unmet|not)|POSTCONDITION_FAILED|后置条件(失败|未满足|不成立)/i, type: 'POSTCONDITION_FAILED' },
  { pattern: /goal.*(not|unmet|fail)|GOAL_NOT_(ACHIEVED|SATISFIED)|目标未达成|目标不满足|目标未满足/i, type: 'GOAL_NOT_SATISFIED' },
  { pattern: /graph invalid|invalid graph|unreachable|orphan|WORKFLOW_GRAPH_INVALID|图(无效|不合法)|断链/i, type: 'WORKFLOW_GRAPH_INVALID' },
  { pattern: /ambiguous|more than one|multiple elements|ELEMENT_AMBIGUOUS|TARGET_AMBIGUOUS|多个元素|不唯一/i, type: 'ELEMENT_AMBIGUOUS' },
  { pattern: /not interactable|not clickable|occluded|ELEMENT_NOT_INTERACTABLE|不可交互|被遮挡/i, type: 'ELEMENT_NOT_INTERACTABLE' },
  { pattern: /not visible|hidden|invisible|ELEMENT_NOT_VISIBLE|不可见|未显示/i, type: 'ELEMENT_NOT_VISIBLE' },
  { pattern: /stale (element|node|reference)|detached (from|element)|SELECTOR_STALE|元素已失效|已脱离/i, type: 'SELECTOR_STALE' },
  { pattern: /element not found|no element|cannot find (the )?element|TARGET_NOT_FOUND|ELEMENT_NOT_FOUND|找不到元素|未找到元素|无法找到.*元素/i, type: 'ELEMENT_NOT_FOUND' },
  { pattern: /frame not found|no frame|FRAME_NOT_(FOUND|READY)|找不到(框架|frame)|frame.*(not|unavailable)/i, type: 'FRAME_NOT_FOUND' },
  { pattern: /tab not found|no tab|TAB_NOT_FOUND|找不到标签页/i, type: 'TAB_NOT_FOUND' },
  { pattern: /navigation timeout|navigate.*timeout|NAVIGATION_TIMEOUT|导航超时/i, type: 'NAVIGATION_TIMEOUT' },
  { pattern: /page not ready|not ready|PAGE_NOT_READY|WAIT_CONDITION_UNMET|页面(未|没有)(就绪|加载完成)|尚未加载/i, type: 'PAGE_NOT_READY' },
  { pattern: /input rejected|rejected input|INPUT_REJECTED|输入被拒绝/i, type: 'INPUT_REJECTED' },
  { pattern: /invalid parameter|invalid argument|missing required|INVALID_PARAMETER|参数(无效|缺失|不合法)/i, type: 'INVALID_PARAMETER' },
  { pattern: /state mismatch|unexpected state|STATE_MISMATCH|状态(不一致|不匹配)/i, type: 'STATE_MISMATCH' },
]

/** DOM evidence that can disambiguate beyond the message text. */
export interface FailureDomEvidence {
  /** Number of elements the locator currently matches. */
  matchCount?: number
  /** Whether a matching element exists at all. */
  elementExists?: boolean
  /** Whether a matching element is visible. */
  visible?: boolean
  /** Whether the page has finished loading. */
  loaded?: boolean
  /** Current page URL. */
  url?: string
}

export interface ClassifyFailureInput {
  /** Raw error message emitted by the executor / engine. */
  message: string
  /** An explicit structured code when the runner already classified. */
  code?: string
  /** DOM evidence, when the integration layer collected it. */
  dom?: FailureDomEvidence
}

export interface ClassifiedFailure {
  type: WorkflowFailureType
  /** How the verdict was reached — for observability. */
  basis: 'structured-code' | 'message-pattern' | 'dom-evidence' | 'unknown'
  policy: FailureTypePolicy
}

/**
 * Classify a failure. An explicit well-formed structured code wins; then the
 * known message mapping; then DOM evidence; everything else is `UNKNOWN`.
 */
export function classifyFailure(input: ClassifyFailureInput): ClassifiedFailure {
  // 1. Structured code.
  if (input.code && isWorkflowFailureType(input.code)) {
    return { type: input.code, basis: 'structured-code', policy: TYPE_POLICY[input.code] }
  }
  // 2. Known error mapping (message patterns).
  const message = input.message ?? ''
  for (const rule of MESSAGE_RULES) {
    if (rule.pattern.test(message)) {
      return { type: rule.type, basis: 'message-pattern', policy: TYPE_POLICY[rule.type] }
    }
  }
  // 3. DOM evidence.
  const dom = input.dom
  if (dom) {
    if (dom.loaded === false) {
      return { type: 'PAGE_NOT_READY', basis: 'dom-evidence', policy: TYPE_POLICY.PAGE_NOT_READY }
    }
    if (dom.elementExists === false || dom.matchCount === 0) {
      return { type: 'ELEMENT_NOT_FOUND', basis: 'dom-evidence', policy: TYPE_POLICY.ELEMENT_NOT_FOUND }
    }
    if (dom.visible === false) {
      return { type: 'ELEMENT_NOT_VISIBLE', basis: 'dom-evidence', policy: TYPE_POLICY.ELEMENT_NOT_VISIBLE }
    }
    if (typeof dom.matchCount === 'number' && dom.matchCount > 1) {
      return { type: 'ELEMENT_AMBIGUOUS', basis: 'dom-evidence', policy: TYPE_POLICY.ELEMENT_AMBIGUOUS }
    }
  }
  return { type: 'UNKNOWN', basis: 'unknown', policy: TYPE_POLICY.UNKNOWN }
}

// --- Adapters from the older vocabularies -------------------------------------

/**
 * Map the repair engine's `VerificationFailureType` into the standard
 * vocabulary, so callers migrating off the old types keep classifying
 * consistently.
 */
export function fromVerificationFailure(code: string): WorkflowFailureType {
  switch (code) {
    case 'PAGE_NOT_READY':
    case 'FRAME_NOT_READY':
      return 'PAGE_NOT_READY'
    case 'TARGET_NOT_FOUND':
      return 'ELEMENT_NOT_FOUND'
    case 'TARGET_AMBIGUOUS':
      return 'ELEMENT_AMBIGUOUS'
    case 'NETWORK_ERROR':
      return 'PAGE_NOT_READY'
    case 'WAIT_CONDITION_UNMET':
    case 'TIMEOUT':
      return 'PAGE_NOT_READY'
    case 'VARIABLE_MISSING':
    case 'VARIABLE_EMPTY':
    case 'VARIABLE_TYPE_ERROR':
      return 'INVALID_PARAMETER'
    case 'CONTRACT_VIOLATION':
    case 'PRECONDITION_FAILED':
      return 'STATE_MISMATCH'
    case 'POSTCONDITION_FAILED':
      return 'POSTCONDITION_FAILED'
    case 'GOAL_NOT_ACHIEVED':
      return 'GOAL_NOT_SATISFIED'
    case 'WRONG_ORIGIN':
    case 'WRONG_PAGE':
      return 'STATE_MISMATCH'
    case 'SIDE_EFFECT_UNSAFE':
      return 'SIDE_EFFECT_UNKNOWN'
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED'
    case 'CAPTCHA_REQUIRED':
      return 'CAPTCHA_REQUIRED'
    case 'STRUCTURAL_ERROR':
      return 'WORKFLOW_GRAPH_INVALID'
    case 'ACTION_ERROR':
      return 'ELEMENT_NOT_INTERACTABLE'
    case 'CANCELLED':
      return 'UNKNOWN'
    default:
      return 'UNKNOWN'
  }
}

/** Map the unified `WorkflowFailureKind` (failure-taxonomy.ts) into the type. */
export function fromFailureKind(kind: string): WorkflowFailureType {
  switch (kind) {
    case 'locator-not-found':
      return 'ELEMENT_NOT_FOUND'
    case 'locator-ambiguous':
      return 'ELEMENT_AMBIGUOUS'
    case 'locator-unstable':
      return 'SELECTOR_STALE'
    case 'readiness':
      return 'PAGE_NOT_READY'
    case 'page-state':
      return 'STATE_MISMATCH'
    case 'wrong-origin':
    case 'navigation':
      return 'NAVIGATION_TIMEOUT'
    case 'side-effect':
      return 'SIDE_EFFECT_UNKNOWN'
    case 'goal-verification':
      return 'GOAL_NOT_SATISFIED'
    case 'graph':
    case 'dataflow':
      return 'WORKFLOW_GRAPH_INVALID'
    case 'runtime':
      return 'ELEMENT_NOT_INTERACTABLE'
    case 'environment':
      return 'AUTH_REQUIRED'
    default:
      return 'UNKNOWN'
  }
}

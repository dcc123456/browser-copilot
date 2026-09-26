/**
 * Failure codes — the shared vocabulary for "why did a step fail" (spec §10).
 *
 * Runtime layers raise structured failures by PREFIXING their error message
 * (`READINESS_TIMEOUT(present): …`, `LOCATOR_AMBIGUOUS: …`); this module is
 * the parser + the classifier tables that turn such a message into a stable
 * code, a category, and a recovery hint. One source of truth for the run
 * logs, the failure classifier, the AI-repair loop and the benchmark.
 *
 * @module lib/workflow/failure-code
 */

/** Every structured failure the reliability runtime can produce. */
export type FailureCode =
  // locator (§6)
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  // readiness (§7)
  | 'READINESS_TIMEOUT'
  // contract conditions (§8)
  | 'PRECONDITION_FAILED'
  | 'POSTCONDITION_FAILED'
  // goal (§8.4)
  | 'GOAL_NOT_ACHIEVED'
  // side effects (§5/§9)
  | 'SIDE_EFFECT_UNSAFE'
  | 'TERMINAL_STATE_UNCERTAIN'
  // page context (§11)
  | 'WRONG_ORIGIN'
  | 'WRONG_PAGE'
  // static validation (Phase 6)
  | 'VALIDATION_FAILED'
  // file upload (spec §16)
  | 'UPLOAD_FILE_FAILED'
  // legacy / unclassified
  | 'ELEMENT_NOT_FOUND'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNKNOWN'

export type FailureCategory =
  | 'locator'
  | 'readiness'
  | 'contract'
  | 'goal'
  | 'safety'
  | 'environment'
  | 'workflow'
  | 'cancelled'

export interface FailureClassification {
  code: FailureCode
  category: FailureCategory
  /** Whether a bounded retry / re-observe can plausibly fix it. */
  recoverable: boolean
  /** Whether the AI-repair loop may patch params for it (§12: local patches). */
  aiRepairable: boolean
  /** Short hint for the takeover / repair prompt (Chinese). */
  hint: string
}

/** The priority-ordered classification table — first prefix match wins. */
export const FAILURE_TABLE: ReadonlyArray<
  FailureClassification & { prefixes: readonly string[] }
> = [
  {
    prefixes: ['WRONG_ORIGIN', 'WRONG_PAGE'],
    code: 'WRONG_ORIGIN',
    category: 'environment',
    recoverable: false,
    aiRepairable: false,
    hint: '当前页面不是该步骤期望的站点或页面，先导航到正确页面。',
  },
  {
    prefixes: ['LOCATOR_AMBIGUOUS'],
    code: 'LOCATOR_AMBIGUOUS',
    category: 'locator',
    recoverable: true,
    aiRepairable: true,
    hint: '定位命中多个元素且无法区分，需要更精确的定位器（testid/role/稳定文本）。',
  },
  {
    prefixes: ['LOCATOR_NOT_FOUND'],
    code: 'LOCATOR_NOT_FOUND',
    category: 'locator',
    recoverable: true,
    aiRepairable: true,
    hint: '定位没有命中任何元素，选择器可能过期或页面结构不同。',
  },
  {
    prefixes: ['READINESS_TIMEOUT'],
    code: 'READINESS_TIMEOUT',
    category: 'readiness',
    recoverable: true,
    aiRepairable: true,
    hint: '页面在就绪窗口内未达到可操作状态，可能加载慢或元素根本不会出现。',
  },
  {
    prefixes: ['PRECONDITION_FAILED'],
    code: 'PRECONDITION_FAILED',
    category: 'contract',
    recoverable: true,
    aiRepairable: true,
    hint: '动作执行前的前置事实不成立（如未登录、表单为空），先满足前置条件。',
  },
  {
    prefixes: ['POSTCONDITION_FAILED'],
    code: 'POSTCONDITION_FAILED',
    category: 'contract',
    recoverable: true,
    aiRepairable: true,
    hint: '动作已执行但声明的后置事实不成立，动作可能没生效——不要盲目重放。',
  },
  {
    prefixes: ['GOAL_NOT_ACHIEVED'],
    code: 'GOAL_NOT_ACHIEVED',
    category: 'goal',
    recoverable: false,
    aiRepairable: false,
    hint: '执行"成功"但目标条件未满足，需检查目标定义或业务流程。',
  },
  {
    prefixes: ['SIDE_EFFECT_UNSAFE', 'TERMINAL_STATE_UNCERTAIN'],
    code: 'SIDE_EFFECT_UNSAFE',
    category: 'safety',
    recoverable: false,
    aiRepairable: false,
    hint: '涉及不可逆动作且终态不确定，禁止自动重试，需人工确认。',
  },
  {
    prefixes: ['VALIDATION_FAILED'],
    code: 'VALIDATION_FAILED',
    category: 'workflow',
    recoverable: false,
    aiRepairable: true,
    hint: '工作流静态校验未通过，需要修复结构或补全契约。',
  },
  {
    prefixes: ['没有读到任何内容', '元素未找到', '元素不存在'],
    code: 'ELEMENT_NOT_FOUND',
    category: 'locator',
    recoverable: true,
    aiRepairable: true,
    hint: '页面元素未找到（兼容路径），选择器可能过期。',
  },
  {
    prefixes: ['UPLOAD_USER_SELECTION_CANCELLED'],
    code: 'UPLOAD_FILE_FAILED',
    category: 'cancelled',
    recoverable: false,
    aiRepairable: false,
    hint: '用户取消了文件选择。',
  },
  {
    prefixes: ['UPLOAD_USER_SELECTION_TIMEOUT'],
    code: 'UPLOAD_FILE_FAILED',
    category: 'environment',
    recoverable: true,
    aiRepairable: false,
    hint: '等待用户选择文件超时。',
  },
  {
    prefixes: ['UPLOAD_TARGET_NOT_FOUND', 'UPLOAD_TARGET_NOT_FILE_INPUT'],
    code: 'UPLOAD_FILE_FAILED',
    category: 'locator',
    recoverable: true,
    aiRepairable: true,
    hint: '文件上传目标缺失或不是文件控件，重新定位 input[type=file] 或拖拽区。',
  },
  {
    prefixes: ['UPLOAD_FILE_VARIABLE_NOT_FOUND', 'UPLOAD_FILE_VARIABLE_INVALID', 'UPLOAD_FILE_DATA_INVALID'],
    code: 'UPLOAD_FILE_FAILED',
    category: 'workflow',
    recoverable: true,
    aiRepairable: true,
    hint: '文件变量缺失或数据无效，检查 fileVariable 与文件数据。',
  },
  {
    prefixes: ['UPLOAD_MULTIPLE_NOT_SUPPORTED'],
    code: 'UPLOAD_FILE_FAILED',
    category: 'workflow',
    recoverable: true,
    aiRepairable: true,
    hint: '上传控件不支持多文件，调整文件数量或 multiple 配置。',
  },
  {
    prefixes: ['UPLOAD_FILE_INJECTION_FAILED', 'UPLOAD_FILE_VERIFICATION_FAILED', 'UPLOAD_DROPZONE_UNSUPPORTED'],
    code: 'UPLOAD_FILE_FAILED',
    category: 'workflow',
    recoverable: true,
    aiRepairable: true,
    hint: '文件未能真正进入页面上传控件，检查目标控件与拖拽区。',
  },
  {
    prefixes: ['AbortError', 'aborted', '已取消'],
    code: 'ABORTED',
    category: 'cancelled',
    recoverable: false,
    aiRepairable: false,
    hint: '运行被用户中止。',
  },
  {
    prefixes: ['超时', 'timeout', 'Timeout'],
    code: 'TIMEOUT',
    category: 'environment',
    recoverable: true,
    aiRepairable: false,
    hint: '等待超时，可能页面慢或不可达。',
  },
]

/** Message → classification. Unrecognized messages classify as UNKNOWN. */
export function classifyFailureMessage(message: string): FailureClassification {
  for (const row of FAILURE_TABLE) {
    for (const prefix of row.prefixes) {
      if (message.startsWith(prefix) || message.includes(prefix)) {
        return {
          code: row.code,
          category: row.category,
          recoverable: row.recoverable,
          aiRepairable: row.aiRepairable,
          hint: row.hint,
        }
      }
    }
  }
  return {
    code: 'UNKNOWN',
    category: 'workflow',
    recoverable: true,
    aiRepairable: true,
    hint: '未分类失败，需要查看运行日志。',
  }
}

/** All structured codes the runtime raises, for prompts and docs. */
export const FAILURE_CODES: readonly FailureCode[] = [
  'LOCATOR_NOT_FOUND',
  'LOCATOR_AMBIGUOUS',
  'READINESS_TIMEOUT',
  'PRECONDITION_FAILED',
  'POSTCONDITION_FAILED',
  'GOAL_NOT_ACHIEVED',
  'SIDE_EFFECT_UNSAFE',
  'TERMINAL_STATE_UNCERTAIN',
  'WRONG_ORIGIN',
  'WRONG_PAGE',
  'VALIDATION_FAILED',
  'UPLOAD_FILE_FAILED',
  'ELEMENT_NOT_FOUND',
  'TIMEOUT',
  'ABORTED',
  'UNKNOWN',
]

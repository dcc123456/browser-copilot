/**
 * Offline benchmark scenarios for the AI-debug session (调试基准场景).
 *
 * Each scenario is a plain data description of one realistic failure mode: how
 * the engine behaves, what the takeover agent does, and whether the escalation
 * (replay + graph audit) can rescue the graph. The harness feeds them through
 * the REAL `runDebugSession`, so the benchmark exercises the actual loop without
 * a browser, a model, or network — which is what makes it a CI regression gate.
 *
 * The knobs encode the EXPECTED post-fix behaviour (e.g. a login wall must burn
 * exactly one attempt). When a fix lands, update the knob and the gate catches
 * any regression.
 *
 * @module tests/bench/scenarios
 */
import type { TakeoverFix, TakeoverReasonKind } from '../../src/lib/workflow/ai-takeover'

/** How the engine's first (takeover-enabled) run behaves. */
export type FirstRun = 'ok' | 'failed'

export interface BenchScenario {
  id: string
  /** Short human-readable title (Chinese, shown in the report). */
  title: string
  /** The failure class this scenario represents. */
  failureClass:
    | 'timing'
    | 'locating'
    | 'environment'
    | 'semantic'
    | 'config'
    | 'structural'
    | 'resilience'
    /** Non-idempotent goal (login/submit): the end state may already hold. */
    | 'non-idempotent'
  /** Whether the first (takeover-enabled) run completes without AI help. */
  firstRun: FirstRun
  /** Whether the takeover agent completes the step. */
  takeoverCompletes: boolean
  /** Attempts the takeover burned (asserted for the fast-fail scenarios). */
  takeoverAttempts: number
  /** Classified reason when the takeover fails. */
  reasonKind?: TakeoverReasonKind
  /** Fix the takeover proposes (applied to the copy before the verify run). */
  fix?: TakeoverFix
  /** Whether the takeover-free FIX-verify run passes. */
  verifyPasses: boolean
  /** Whether the replay+audit escalation produces a validated rewrite. */
  replayRewrite: boolean
  /** Whether the REWRITE-verify run passes (only consulted with replayRewrite). */
  rewriteVerifyPasses: boolean
  /** Goal judge verdict: true achieved, false not achieved, null unavailable. */
  goal: boolean | null
  /**
   * The goal's END STATE already holds (non-idempotent flow that already
   * landed). The run may fail — its preconditions are gone forever — but
   * retrying can never re-demonstrate it, so the session must stop and report
   * success instead of looping.
   */
  goalAlreadySatisfied?: boolean
  /** What the scenario is expected to prove (report note). */
  expectation: string
}

/** A takeover fix that points a stale selector at the real element. */
const selectorFix: TakeoverFix = {
  nodeId: 'click',
  nodeLabel: 'click',
  paramsPatch: { selector: 'button.submit' },
  note: '选择器过期',
}

/** A takeover fix that adds an element wait (the timing failure). */
const waitFix: TakeoverFix = {
  nodeId: 'click',
  nodeLabel: 'click',
  paramsPatch: { waitForSelector: true, waitSelectorTimeout: 5000 },
  note: '页面加载慢',
}

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'S1-timing',
    title: '慢页面：元素尚未渲染',
    failureClass: 'timing',
    firstRun: 'failed',
    takeoverCompletes: true,
    takeoverAttempts: 1,
    fix: waitFix,
    verifyPasses: true,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: true,
    expectation: '接管补上等待参数，修复经无接管验证通过',
  },
  {
    id: 'S2-locating',
    title: '选择器过期：定位到真实元素',
    failureClass: 'locating',
    firstRun: 'failed',
    takeoverCompletes: true,
    takeoverAttempts: 1,
    fix: selectorFix,
    verifyPasses: true,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: true,
    expectation: '接管给出稳定选择器，修复经验证通过',
  },
  {
    id: 'S3-environment',
    title: '登录墙：不可恢复，应快速失败',
    failureClass: 'environment',
    firstRun: 'failed',
    takeoverCompletes: false,
    takeoverAttempts: 1,
    reasonKind: 'auth',
    verifyPasses: false,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: null,
    expectation: '第 1 次尝试即终止（不烧满 3 次），会话如实失败',
  },
  {
    id: 'S4-scope',
    title: '多窗口：接管钉到运行所在 tab',
    failureClass: 'config',
    firstRun: 'failed',
    takeoverCompletes: true,
    takeoverAttempts: 1,
    fix: selectorFix,
    verifyPasses: true,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: true,
    expectation: '接管在正确页面完成步骤，修复经验证通过',
  },
  {
    id: 'S5-structural',
    title: '结构性坏图：节点级修复无效，复演+审计重建',
    failureClass: 'structural',
    firstRun: 'failed',
    takeoverCompletes: false,
    takeoverAttempts: 3,
    reasonKind: 'notfound',
    verifyPasses: false,
    replayRewrite: true,
    rewriteVerifyPasses: true,
    goal: true,
    expectation: '升级到复演+图审计，修正图经无接管验证通过',
  },
  {
    id: 'S6-resilience',
    title: '瞬时 5xx：重试后首轮直接成功',
    failureClass: 'resilience',
    firstRun: 'ok',
    takeoverCompletes: false,
    takeoverAttempts: 0,
    verifyPasses: false,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: true,
    expectation: '无需接管，首轮即通过（LLM 重试由单测覆盖）',
  },
  {
    id: 'S7-misjudge',
    title: '残缺 verdict：无有效修复，不得计为成功',
    failureClass: 'semantic',
    firstRun: 'failed',
    takeoverCompletes: true,
    takeoverAttempts: 1,
    verifyPasses: false,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: null,
    expectation: '接管"完成"但无可验证修复 → 不得 verified',
  },
  {
    id: 'S8-no-provider',
    title: '未配置模型：接管不可用',
    failureClass: 'config',
    firstRun: 'failed',
    takeoverCompletes: false,
    takeoverAttempts: 0,
    verifyPasses: false,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: null,
    expectation: '接管 0 次尝试即报不可用，会话如实失败',
  },
  {
    // The reported bug: a LOGIN workflow that already logged in. The AI judged
    // it "not successful", retried — but the login page is gone, so every retry
    // failed identically and the loop never ended.
    id: 'S9-non-idempotent',
    title: '非幂等登录：已登录即终态，不得无限重试',
    failureClass: 'non-idempotent',
    firstRun: 'failed',
    // No fix is possible: the username field no longer exists.
    takeoverCompletes: false,
    takeoverAttempts: 1,
    reasonKind: 'notfound',
    verifyPasses: false,
    replayRewrite: false,
    rewriteVerifyPasses: false,
    goal: true,
    goalAlreadySatisfied: true,
    expectation: '目标终态已满足（已登录）→ 判定成功并立即停止，不重试、不升级到复演',
  },
]

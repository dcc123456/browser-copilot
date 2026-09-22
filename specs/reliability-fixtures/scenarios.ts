/**
 * The reliability baseline scenario set (spec §3.1 Step 0.3).
 *
 * Ten deterministic scenarios covering the failure shapes that make AI-generated
 * workflows unreliable, each with an explicit BASELINE outcome (what the current
 * compat system does — asserted by `tests/workflow-reliability-baseline.spec.ts`
 * and kept true across every phase) and a TARGET outcome (what the generated-
 * strict regime should achieve — asserted by the reliability benchmark from
 * Phase 11).
 *
 * Scenario index:
 *
 *   R01 slow page render        — the element arrives late; readiness must wait
 *   R02 locator matches nothing — must fail with a precise not-found, not drift
 *   R03 locator matches many    — compat first-of-many vs strict ambiguity error
 *   R04 CSS drifts, role/name holds — the rich fallback must still win
 *   R05 SPA route changed       — the old page's locator is gone; must classify
 *   R06 modal appears late      — same readiness shape as R01, behind a click
 *   R07 upstream variable empty — a silent empty fill must NOT read as success
 *   R08 click landed, later node failed — the side effect must be on the ledger
 *   R09 submit landed, run failed   — a re-run must NOT submit twice
 *   R10 wrong origin            — acting on a foreign page must be recognizable
 *
 * @module specs/reliability-fixtures/scenarios
 */
import type { FixtureGraphInput, FixtureMode, FakePageState, FixturePass } from './harness'
import { emptyPage, node, edge, runPass } from './harness'

/** The expected outcome surface every scenario declares for each mode. */
export interface ExpectedOutcome {
  outcome: 'ok' | 'failed' | 'cancelled'
  /** Substrings the run error must contain (absent assertions on success). */
  errorContains?: string[]
  /** The `forms` submit call count after the scenario's full pass sequence. */
  submitCalls?: number
  /** True when some click resolved through a multi-match (first-of-many). */
  firstOfManyClicked?: boolean
  /** Variable values asserted after the run. */
  variables?: Record<string, unknown>
  /** Selector substrings that must appear in the action ledger. */
  actionsInclude?: string[]
}

export interface ReliabilityScenario {
  id: 'R01' | 'R02' | 'R03' | 'R04' | 'R05' | 'R06' | 'R07' | 'R08' | 'R09' | 'R10'
  title: string
  description: string
  /** The fixture graph (mode-independent; stamping happens in the runner). */
  graph: FixtureGraphInput
  /** Builds the FRESH initial page state for one pass. */
  buildPage: (mode: FixtureMode) => FakePageState
  /** Seed variables for the run. */
  variables?: Record<string, unknown>
  /**
   * Scenarios modeling a USER RETRY run a second pass after the first one
   * failed; `resumeFromTrigger` marks that the retry starts at the trigger
   * (today's behavior — the dangerous one for non-idempotent flows).
   */
  retryFromTrigger?: boolean
  baseline: ExpectedOutcome
  target: ExpectedOutcome
}

// --- R01: slow page render -----------------------------------------------------

const R01: ReliabilityScenario = {
  id: 'R01',
  title: '页面慢加载：结果区在读取时还没渲染',
  description:
    'get-text 读取 #result，但页面在第 3 次解析时才渲染出该元素。compat 直接失败；' +
    'generated-strict 应由 readiness 轮询等待并命中即返回。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('read', 'get-text', { selector: '#result', variableName: 'result' }),
    ],
    edges: [edge('t', 'read')],
  },
  buildPage: () => {
    const page = emptyPage('https://shop.example/list', [
      { tag: 'div', id: 'result', text: '订单 10001 已发货' },
    ])
    page.visibleAfterAttempts['#result'] = 3
    return page
  },
  baseline: { outcome: 'failed', errorContains: ['没有读到任何内容'] },
  target: { outcome: 'ok', variables: { result: '订单 10001 已发货' } },
}

// --- R02: locator matches nothing ---------------------------------------------

const R02: ReliabilityScenario = {
  id: 'R02',
  title: 'selector 命中 0 个元素',
  description:
    'click 指向 #gone，页面上不存在。必须以明确的“元素未找到”失败，不得静默执行其他元素。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('click', 'click', { selector: '#gone' }),
    ],
    edges: [edge('t', 'click')],
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'button', id: 'other', name: '其他按钮', role: 'button' },
    ]),
  baseline: { outcome: 'failed', errorContains: ['元素未找到'] },
  target: { outcome: 'failed', errorContains: ['元素未找到'] },
}

// --- R03: locator matches many -------------------------------------------------

const R03: ReliabilityScenario = {
  id: 'R03',
  title: 'selector 命中多个元素',
  description:
    '.card 匹配 3 张卡片。compat 取第一个（记录 firstOfMany）；generated-strict 必须' +
    '以 LOCATOR_AMBIGUOUS 失败，宁可不确定也不误点。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('click', 'click', { selector: '.card' }),
    ],
    edges: [edge('t', 'click')],
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'div', classes: ['card'], text: '订单 10001' },
      { tag: 'div', classes: ['card'], text: '订单 10002' },
      { tag: 'div', classes: ['card'], text: '订单 10003' },
    ]),
  baseline: { outcome: 'ok', firstOfManyClicked: true },
  target: { outcome: 'failed', errorContains: ['元素未找到', '定位不确定'] },
}

// --- R04: CSS drifts, role/name holds ------------------------------------------

const R04: ReliabilityScenario = {
  id: 'R04',
  title: 'CSS 漂移但 role/name 不变',
  description:
    '录制时的 CSS 路径已失效（0 命中），但节点携带的 rich target 里 role+名称的 ' +
    'fallback 仍然唯一命中——当前两层解析的正确行为，必须保持。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('click', 'click', {
        selector: '.old-card > button.primary',
        target: {
          primary: { how: 'css', value: '.old-card > button.primary' },
          fallbacks: [{ how: 'role', value: '发货', role: 'button' }],
        },
      }),
    ],
    edges: [edge('t', 'click')],
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'button', name: '发货', role: 'button', text: '发货' },
    ]),
  baseline: { outcome: 'ok', actionsInclude: ['role|button|发货'] },
  target: { outcome: 'ok', actionsInclude: ['role|button|发货'] },
}

// --- R05: SPA route changed ------------------------------------------------------

const R05: ReliabilityScenario = {
  id: 'R05',
  title: 'SPA 路由改变后旧 locator 失效',
  description:
    '点击进入 /detail 后，仍按 /list 页录制的 .list-row 读取。必须失败且错误可解释，' +
    '不得在错误页面上静默执行。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('open', 'click', {
        selector: '#open-detail',
      }),
      node('read', 'get-text', { selector: '.list-row', variableName: 'row' }),
    ],
    edges: [edge('t', 'open'), edge('open', 'read')],
  },
  buildPage: () => {
    const page = emptyPage('https://shop.example/list', [
      { tag: 'button', id: 'open-detail', name: '查看详情', role: 'button' },
      { tag: 'div', classes: ['list-row'], text: '订单 10001' },
    ])
    // SPA navigation: the route changes AND the list DOM goes away with it.
    page.clickEffects['open-detail'] = (p) => {
      p.url = 'https://shop.example/detail/10001'
      p.elements = [{ tag: 'h1', text: '订单详情' }]
    }
    return page
  },
  baseline: { outcome: 'failed', errorContains: ['没有读到任何内容'] },
  target: { outcome: 'failed', errorContains: ['没有读到任何内容'] },
}

// --- R06: modal appears late -----------------------------------------------------

const R06: ReliabilityScenario = {
  id: 'R06',
  title: 'modal 延迟出现',
  description:
    '点击后弹窗要等 3 次解析才出现，element-exists 检查 #modal-ok。compat 立即判 false；' +
    'generated-strict 的 readiness 应等到出现。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('open', 'click', { selector: '#open-modal' }),
      node('check', 'element-exists', { selector: '#modal-ok', variableName: 'modalShown' }),
    ],
    edges: [edge('t', 'open'), edge('open', 'check')],
  },
  buildPage: () => {
    const page = emptyPage('https://shop.example/list', [
      { tag: 'button', id: 'open-modal', name: '打开弹窗', role: 'button' },
    ])
    page.clickEffects['open-modal'] = (p) => {
      p.elements.push({ tag: 'button', id: 'modal-ok', name: '确认', role: 'button' })
    }
    page.visibleAfterAttempts['#modal-ok'] = 3
    return page
  },
  baseline: { outcome: 'ok', variables: { modalShown: false } },
  target: { outcome: 'ok', variables: { modalShown: true } },
}

// --- R07: upstream variable empty -------------------------------------------------

const R07: ReliabilityScenario = {
  id: 'R07',
  title: 'upstream variable 为空',
  description:
    '{{keyword}} 解析为空串仍被填进搜索框——典型的“静默错误成功”。compat 照跑；' +
    'generated-strict 必须以 VARIABLE_INVALID 类校验失败。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('fill', 'forms', { action: 'fill', selector: '#search', value: '{{keyword}}' }),
    ],
    edges: [edge('t', 'fill')],
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'input', id: 'search', role: 'textbox', name: '搜索' },
    ]),
  variables: { keyword: '' },
  baseline: { outcome: 'ok', actionsInclude: ['fill'] },
  target: { outcome: 'failed', errorContains: ['变量'] },
}

// --- R08: click landed, later node failed -----------------------------------------

const R08: ReliabilityScenario = {
  id: 'R08',
  title: 'click 实际发生但后续节点失败',
  description:
    '#buy 点击成功（副作用已发生），随后 get-text #receipt 失败。失败观测必须能证明' +
    '点击已经落地——这是终态检查与安全恢复的输入。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('buy', 'click', { selector: '#buy' }),
      node('read', 'get-text', { selector: '#receipt', variableName: 'receipt' }),
    ],
    edges: [edge('t', 'buy'), edge('buy', 'read')],
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'button', id: 'buy', name: '购买', role: 'button' },
    ]),
  baseline: { outcome: 'failed', errorContains: ['没有读到任何内容'], actionsInclude: ['click'] },
  target: { outcome: 'failed', errorContains: ['没有读到任何内容'], actionsInclude: ['click'] },
}

// --- R09: submit landed, run failed ------------------------------------------------

const R09: ReliabilityScenario = {
  id: 'R09',
  title: 'submit 已成功但运行失败后重试',
  description:
    '提交已发出但页面尚未跳转（提交按钮还在——真实失败最常见的形状），后续读取失败；' +
    '用户重试整个工作流时从 trigger 重新跑——compat 会再次 submit（双重执行！），' +
    'generated-strict 必须检查终态并跳过。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('submit', 'forms', { action: 'submit', selector: '#submit-btn' }),
      node('read', 'get-text', { selector: '#dashboard', variableName: 'dashboard' }),
    ],
    edges: [edge('t', 'submit'), edge('submit', 'read')],
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'button', id: 'submit-btn', name: '提交订单', role: 'button' },
    ]),
  retryFromTrigger: true,
  baseline: { outcome: 'failed', submitCalls: 2 },
  target: { outcome: 'failed', submitCalls: 1 },
}

// --- R10: wrong origin --------------------------------------------------------------

const R10: ReliabilityScenario = {
  id: 'R10',
  title: 'wrong origin：在错误站点上运行',
  description:
    '工作流生成于 admin.example，却在 shop.example 的页面上运行。compat 只会报' +
    '“元素未找到”（误导）；generated-strict 必须在执行任何动作前报 WRONG_ORIGIN。',
  graph: {
    nodes: [
      node('t', 'trigger'),
      node('click', 'click', { selector: '#admin-menu' }),
    ],
    edges: [edge('t', 'click')],
    settings: { generationOriginUrl: 'https://admin.example/console' },
  },
  buildPage: () =>
    emptyPage('https://shop.example/list', [
      { tag: 'button', id: 'other', name: '商店按钮', role: 'button' },
    ]),
  baseline: { outcome: 'failed', errorContains: ['元素未找到'] },
  target: { outcome: 'failed', errorContains: ['WRONG_ORIGIN'] },
}

/** The ten scenarios, in spec order. */
export const RELIABILITY_SCENARIOS: readonly ReliabilityScenario[] = [
  R01,
  R02,
  R03,
  R04,
  R05,
  R06,
  R07,
  R08,
  R09,
  R10,
]

export function scenarioById(id: string): ReliabilityScenario | undefined {
  return RELIABILITY_SCENARIOS.find((s) => s.id === id)
}

/**
 * Full pass sequence for one scenario: the first run, plus — when the scenario
 * models a user retry (`retryFromTrigger`) and the first run FAILED — a second
 * run from the trigger. Each pass gets a fresh page (the retry sees the page
 * the workflow EXPECTS, which is precisely why a naive retry re-submits: the
 * form is still there), and side-effect counters accumulate across passes.
 */
export async function runScenario(
  scenario: ReliabilityScenario,
  mode: FixtureMode,
): Promise<{ passes: FixturePass[]; final: FixturePass; submitCalls: number }> {
  // compat retry: a FRESH page (the naive replay that re-submits — the bug).
  // strict retry: the ACTUAL page state carries over (a resume sees the real
  // terminal state), so the unsafe action's terminal-state check can skip it.
  const sharedPage = mode === 'strict' ? scenario.buildPage(mode) : undefined
  const buildPage = (): FakePageState => sharedPage ?? scenario.buildPage(mode)
  const first = await runPass(scenario.graph, mode, {
    buildPage,
    ...(scenario.variables ? { variables: scenario.variables } : {}),
  })
  const passes = [first]
  if (scenario.retryFromTrigger && first.outcome === 'failed') {
    passes.push(
      await runPass(scenario.graph, mode, {
        buildPage,
        ...(scenario.variables ? { variables: scenario.variables } : {}),
      }),
    )
  }
  // Side-effect total: on a shared (strict-resume) page the counter is
  // cumulative already — summing passes would double-count the same action.
  const submitCalls =
    sharedPage !== undefined
      ? passes[passes.length - 1]!.submitCalls
      : passes.reduce((n, pass) => n + pass.submitCalls, 0)
  return { passes, final: passes[passes.length - 1]!, submitCalls }
}

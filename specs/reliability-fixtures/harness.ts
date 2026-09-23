/**
 * Reliability fixture harness — a deterministic fake page + pure-engine runner.
 *
 * The reliability spec (`docs/Browser-Copilot_Coding-Agent_Workflow-Reliability_Spec.md`
 * §3.1 Step 0.3) requires a scenario set that gives DETERMINISTIC results before
 * any reliability work starts, so every later phase can be measured against a
 * recorded baseline instead of a feeling. Real E2E was ruled out on purpose:
 * these fixtures drive the PURE engine (`background/workflow-engine/engine`) with
 * injected stub executors over a tiny fake page model — no chrome, no network,
 * no timers beyond the engine's own retry sleeps.
 *
 * The stub executors mirror the production behavior contracts that matter here:
 *
 *   - resolve: a locator matching 0 elements throws (元素未找到); one matching
 *     MANY acts on the first (compat semantics) and records an ambiguity event;
 *   - reads: 0 matches throw (没有读到任何内容); an existing-but-empty text is
 *     still a successful read of '';
 *   - submit ('forms' with action 'submit'): counts its calls on the page and
 *     removes the control for the remainder of the pass — within one run a
 *     submitted control is gone; whether a RETRY sees it again is the scenario's
 *     own modeling choice (R09 keeps the button: the dangerous case).
 *   - navigation ('new-tab'): rewrites the page URL (SPA route changes model as
 *     element-set swaps done by the scenario effects).
 *
 * Two run modes share one fixture:
 *
 *   - 'compat' — the graph as today's system sees it (no provenance). The
 *     BASELINE spec asserts these outcomes, and keeps asserting them after every
 *     phase: they are the regression guard for hand-made / imported workflows.
 *   - 'strict' — the same graph stamped as AI-generated (`provenance` +
 *     `reliabilityMode: 'generated-strict'`). Later phases assert the TARGET
 *     outcomes on this mode; the baseline spec does not, so nothing here can
 *     silently depend on work that has not landed yet.
 *
 * @module specs/reliability-fixtures/harness
 */
import type { Workflow, WorkflowEdge, WorkflowNode } from '../../src/lib/workflow/types'
import type { WorkflowRunResult } from '../../src/background/workflow-engine/engine'
import { runWorkflow } from '../../src/background/workflow-engine/engine'

/** Which execution regime a fixture graph runs under. */
export type FixtureMode = 'compat' | 'strict'

// --- Fake page model ----------------------------------------------------------

/** One element on the fake page: the few fields the stub resolvers need. */
export interface FakeElement {
  tag: string
  id?: string
  classes?: string[]
  /** Implicit ARIA role (button / textbox / link / heading …). */
  role?: string
  /** Accessible name (button label, input label …). */
  name?: string
  /** Visible text. */
  text?: string
  /** Live form-control value. */
  value?: string
  /** data-testid attribute. */
  testid?: string
}

/** One recorded stub action — the fixture's "side effect ledger". */
export interface FakeAction {
  action: string
  selector?: string
  value?: string
  /** True when this action resolved through a multi-match (compat first-of-many). */
  firstOfMany?: boolean
  /** The spec key the resolution actually used (`how|role|value`). */
  usedSpec?: string
}

/**
 * Mutable fake page state. Scenario effects (navigate, show modal, drop the
 * submitted button…) mutate this object in place; every run starts from a FRESH
 * state built by the scenario, so runs never leak into each other.
 */
export interface FakePageState {
  url: string
  elements: FakeElement[]
  /** Side-effect ledger, in execution order. */
  actions: FakeAction[]
  /** How many times a `forms` submit executed (the double-execution counter). */
  submitCalls: number
  /** Resolve attempts per selector key — models late rendering. */
  attempts: Record<string, number>
  /** Selectors that only start matching AFTER this many resolve attempts. */
  visibleAfterAttempts: Record<string, number>
  /** Per-element click effects (navigate / open modal / …). */
  clickEffects: Record<string, (page: FakePageState) => void>
}

export function emptyPage(url: string, elements: FakeElement[]): FakePageState {
  return {
    url,
    elements,
    actions: [],
    submitCalls: 0,
    attempts: {},
    visibleAfterAttempts: {},
    clickEffects: {},
  }
}

// --- Fake resolution ----------------------------------------------------------

/** Which fake elements a single target spec matches. Supports the shapes the fixtures use. */
function matchSpec(el: FakeElement, spec: { how: string; value: string; role?: string }): boolean {
  const value = spec.value.trim()
  switch (spec.how) {
    case 'id':
      return el.id === value
    case 'testid':
      return el.testid === value
    case 'name':
      return el.name === value
    case 'css': {
      const attr = /^\[data-testid=["']?([^\]"']+)["']?\]$/.exec(value)
      if (attr) return el.testid === attr[1]!
      const id = /^#([A-Za-z0-9_-]+)$/.exec(value)
      if (id) return el.id === id[1]!
      const cls = /^\.([A-Za-z0-9_-]+)$/.exec(value)
      if (cls) return (el.classes ?? []).includes(cls[1]!)
      const tag = /^([a-z]+)(?:\.([A-Za-z0-9_-]+))?$/.exec(value)
      if (tag) {
        if (el.tag !== tag[1]!) return false
        if (tag[2] && !(el.classes ?? []).includes(tag[2]!)) return false
        return true
      }
      return false
    }
    case 'role':
      if (spec.role && (el.role ?? 'generic') !== spec.role) return false
      // A role spec with a value matches by accessible name.
      return value === '' || el.name === value
    case 'text':
      return el.text === value
    default:
      return false
  }
}

export interface FakeTargetSpec {
  how: string
  value: string
  role?: string
}

export interface FakeResolveResult {
  element?: FakeElement
  matched: number
  usedSpec: string
}

/**
 * Resolve a rich locator against the fake page, mirroring the kernel's compat
 * semantics: the first spec with any match wins; within a spec the FIRST match
 * is acted on (compat first-of-many); `visibleAfterAttempts` gates late render.
 */
export function resolveFakeTarget(
  page: FakePageState,
  target: { primary: FakeTargetSpec; fallbacks?: FakeTargetSpec[] },
): FakeResolveResult {
  const specs = [target.primary, ...(target.fallbacks ?? [])]
  for (const spec of specs) {
    const key = `${spec.how}|${spec.role ?? ''}|${spec.value}`
    page.attempts[key] = (page.attempts[key] ?? 0) + 1
    const gate = page.visibleAfterAttempts[spec.value]
    const ready = gate === undefined || page.attempts[key] >= gate
    const matched = ready ? page.elements.filter((el) => matchSpec(el, spec)) : []
    if (matched.length > 0) {
      return { element: matched[0], matched: matched.length, usedSpec: key }
    }
  }
  return { matched: 0, usedSpec: '' }
}

/**
 * The locator a fixture node acts through, mirroring the production
 * `targetFrom`: an explicit `selector` is the PRIMARY and the rich `target`
 * specs (its primary + fallbacks) become fallbacks; with no selector the rich
 * target is used as-is.
 */
function locatorOf(data: Record<string, unknown>): {
  primary: FakeTargetSpec
  fallbacks?: FakeTargetSpec[]
} | null {
  const selector = typeof data['selector'] === 'string' ? data['selector'].trim() : ''
  const raw = data['target'] as { primary?: FakeTargetSpec; fallbacks?: FakeTargetSpec[] } | undefined
  const richSpecs: FakeTargetSpec[] =
    raw && typeof raw === 'object' && raw.primary
      ? [raw.primary, ...(raw.fallbacks ?? [])]
      : []
  if (selector) {
    const fallbacks = richSpecs.filter(
      (spec) => !(spec.how === 'css' && spec.value === selector),
    )
    return { primary: { how: 'css', value: selector }, ...(fallbacks.length ? { fallbacks } : {}) }
  }
  if (raw && typeof raw === 'object' && raw.primary) {
    return { primary: raw.primary, ...(raw.fallbacks ? { fallbacks: raw.fallbacks } : {}) }
  }
  return null
}

/** One line describing a locator, for error messages. */
function describeLocator(data: Record<string, unknown>): string {
  const selector = typeof data['selector'] === 'string' ? data['selector'] : ''
  if (selector) return selector
  const target = data['target'] as { primary?: FakeTargetSpec } | undefined
  return target?.primary ? `${target.primary.how}:${target.primary.value}` : '(无定位)'
}

// --- Stub executors -----------------------------------------------------------

type Ctx = Parameters<import('../../src/background/workflow-engine/executors').BlockExecutor>[1]

/**
 * The stub executor map every fixture runs on. Deliberately small: only the
 * block ids the ten scenarios use. Behavior contracts follow the production
 * executors (see module docblock); the fake page is the single source of state.
 */
export function buildFixtureExecutors(page: FakePageState): Record<string, import('../../src/background/workflow-engine/executors').BlockExecutor> {
  const resolveOrFail = (
    data: Record<string, unknown>,
    message = '元素未找到',
  ): ReturnType<typeof resolveFakeTarget> => {
    const locator = locatorOf(data)
    if (!locator) throw new Error(`${message}: (无定位)`)
    const found = resolveFakeTarget(page, locator)
    if (found.matched === 0 || !found.element) {
      throw new Error(`${message}: ${describeLocator(data)}`)
    }
    return found
  }
  // Spec scores mirroring lib/workflow/locator-score (compat keeps first-hit).
  const scoreSpec = (spec: { how: string; value: string }): number => {
    switch (spec.how) {
      case 'testid': return 100
      case 'role': return 95
      case 'id': return /[a-z-]*\d{3,}/i.test(spec.value) ? 78 : 90
      case 'name': return 85
      case 'data-attr': return 75
      case 'text': return 70
      case 'xpath': return 25
      default: return 35 // css / positional
    }
  }
  // STRICT resolution (emulates the kernel's policy-aware resolver): poll the
  // locator until it appears (readiness), then require a UNIQUE high-score
  // winner — a multi-match without a clear identity refuses (LOCATOR_AMBIGUOUS).
  const strictResolveOrFail = (
    data: Record<string, unknown>,
    message = '元素未找到',
    opts: { poll?: boolean; allowEmpty?: boolean; variableName?: string } = {},
  ): ReturnType<typeof resolveFakeTarget> => {
    const locator = locatorOf(data)
    if (!locator) throw new Error(`${message}: (无定位)`)
    const specs = [locator.primary, ...(locator.fallbacks ?? [])]
    const maxAttempts = opts.poll ? 8 : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const all = specs.map((spec) => ({ spec, score: scoreSpec(spec), found: resolveFakeTarget(page, { primary: spec }) }))
      const matchedAny = all.filter((r) => r.found.matched > 0)
      if (matchedAny.length === 0) {
        if (attempt < maxAttempts) continue
        throw new Error(`${message}: ${describeLocator(data)}`)
      }
      // Union size across specs = distinct matched elements.
      const unionIds = new Set(
        matchedAny.flatMap((r) =>
          page.elements
            .map((el, index) => ({ el, index }))
            .filter(({ el }) => matchSpec(el, r.spec))
            .map(({ index }) => index),
        ),
      )
      if (unionIds.size === 1) {
        const hit = matchedAny[0]!
        return { element: hit.found.element, matched: 1, usedSpec: hit.found.usedSpec }
      }
      // Multi-match: the winner must uniquely match one element with a strong
      // identity score and a real margin over the runner-up.
      const eligible = matchedAny.filter((r) => r.found.matched === 1 && r.score >= 70)
      if (eligible.length === 0) {
        throw new Error(`元素未找到: ${describeLocator(data)} 定位不确定（LOCATOR_AMBIGUOUS，命中 ${unionIds.size} 个）`)
      }
      eligible.sort((a, b) => b.score - a.score)
      const top = eligible[0]!
      const runnerUp = eligible[1]?.score ?? 0
      if (top.score - runnerUp >= 12) {
        return { element: top.found.element, matched: 1, usedSpec: top.found.usedSpec }
      }
      throw new Error(`元素未找到: ${describeLocator(data)} 定位不确定（LOCATOR_AMBIGUOUS，命中 ${unionIds.size} 个）`)
    }
    throw new Error(`${message}: ${describeLocator(data)}`)
  }

  // The strict path activates ONLY through the engine's reliability contract
  // (ctx.reliability set by a generated-strict run) — compat executors are
  // untouched bit for bit.
  const resolveFor = (ctx: Ctx, data: Record<string, unknown>, message = '元素未找到', opts?: { poll?: boolean }) =>
    ctx.reliability
      ? strictResolveOrFail(data, message, opts)
      : resolveOrFail(data, message)

  return {
    // The engine starts at the trigger node; it does nothing.
    trigger: async () => null,

    click: async (data, ctx: Ctx) => {
      const found = resolveFor(ctx, data, '元素未找到', { poll: true })
      const firstOfMany = found.matched > 1
      const id = found.element?.id ?? ''
      page.actions.push({
        action: 'click',
        selector: describeLocator(data),
        firstOfMany,
        usedSpec: found.usedSpec,
      })
      page.clickEffects[id]?.(page)
      ctx.emit('result', `已点击 ${describeLocator(data)}`)
      return null
    },

    forms: async (data, ctx: Ctx) => {
      const action = String(data['action'] ?? 'fill')
      if (action === 'submit') {
        // Production contract: a submit acts on the form/submit control. After a
        // real submit the control is GONE (page navigated / form replaced) — the
        // fake page models that by dropping the element, so a second attempt
        // fails to find it exactly like a replayed login would.
        // STRICT: an unsafe action checks the terminal state FIRST — a submit
        // already fired on this page must not fire again (no blind replay).
        if (ctx.reliability && page.submitCalls > 0) {
          ctx.emit('result', '终态已满足（提交早已生效），跳过重复提交')
          return null
        }
        const found = resolveFor(ctx, data)
        const id = found.element?.id ?? ''
        page.submitCalls += 1
        page.actions.push({ action: 'submit', selector: describeLocator(data), usedSpec: found.usedSpec })
        page.elements = page.elements.filter((el) => el.id !== id)
        ctx.emit('result', '已提交')
        return null
      }
      // STRICT: an empty upstream variable is a VARIABLE_INVALID failure, not
      // a silent empty fill (the "silently wrong success" bug class).
      if (ctx.reliability) {
        const raw = String(data['value'] ?? '')
        if (raw === '' && typeof data['value'] === 'string') {
          throw new Error(`变量值为空（VARIABLE_INVALID）: ${describeLocator(data)}`)
        }
      }
      const found = resolveFor(ctx, data)
      const value = String(data['value'] ?? '')
      if (found.element) found.element.value = value
      page.actions.push({ action: 'fill', selector: describeLocator(data), value, usedSpec: found.usedSpec })
      ctx.emit('result', `已填写 ${describeLocator(data)}`)
      return null
    },

    'get-text': async (data, ctx: Ctx) => {
      // Production contract: a READ that matches nothing throws the read error
      // (没有读到任何内容), not the generic not-found one.
      const found = resolveFor(ctx, data, '没有读到任何内容', { poll: true })
      const text = found.element?.text ?? ''
      const variable = String(data['variableName'] ?? '')
      if (variable) ctx.variables[variable] = text
      page.actions.push({ action: 'get-text', selector: describeLocator(data), usedSpec: found.usedSpec })
      ctx.emit('result', `已读取 ${describeLocator(data)}`)
      return null
    },

    'element-exists': async (data, ctx: Ctx) => {
      const locator = locatorOf(data)
      const matched = locator
        ? ctx.reliability
          ? // STRICT: existence checks poll (readiness) before answering —
            // "not yet there" must not read as "not exists".
            (strictResolveOrFail(data, '元素不存在', { poll: true }), 1)
          : resolveFakeTarget(page, locator).matched
        : 0
      const variable = String(data['variableName'] ?? 'exists')
      ctx.variables[variable] = matched > 0
      page.actions.push({ action: 'element-exists', selector: describeLocator(data) })
      ctx.emit('result', matched > 0 ? '元素存在' : '元素不存在')
      return null
    },

    'new-tab': async (data, ctx: Ctx) => {
      const url = String(data['url'] ?? '')
      page.url = url
      page.actions.push({ action: 'new-tab', value: url })
      ctx.emit('result', `已打开 ${url}`)
      return null
    },

    delay: async () => null,
  }
}

// --- Workflow construction ----------------------------------------------------

/** Minimal node builder: id + blockId + params directly on `data`. */
export function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

/** Minimal edge builder. */
export function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}->${target}`, source, target }
}

export interface FixtureGraphInput {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /** Extra settings (generationOriginUrl …) applied on top of the base. */
  settings?: Record<string, unknown>
}

/** The base fixture workflow, stamped per mode. */
export function buildWorkflow(input: FixtureGraphInput, mode: FixtureMode): Workflow {
  const now = Date.now()
  const settings: Record<string, unknown> = {
    saveLog: false,
    debugMode: false,
    notification: false,
    reuseLastState: false,
    ...(input.settings ?? {}),
  }
  if (mode === 'strict') {
    settings['provenance'] = 'chat-generate'
    settings['reliabilityMode'] = 'generated-strict'
  }
  return {
    id: `fixture-${mode}`,
    name: 'Reliability fixture',
    createdAt: now,
    updatedAt: now,
    drawflow: { nodes: input.nodes, edges: input.edges },
    trigger: { type: 'manual' },
    settings: settings as unknown as Workflow['settings'],
  }
}

// --- Observation + runner -----------------------------------------------------

/** What one fixture run produced — the deterministic observable surface. */
export interface FixturePass {
  outcome: WorkflowRunResult['outcome']
  error?: string
  completedNodeIds: string[]
  variables: Record<string, unknown>
  /** Side-effect ledger the scenario asserts on. */
  actions: FakeAction[]
  submitCalls: number
  url: string
}

export interface RunPassOptions {
  /** Builds the FRESH page state this pass runs against. */
  buildPage: () => FakePageState
  /** Seed variables (the pure engine does not read trigger parameters). */
  variables?: Record<string, unknown>
  /** Engine start node override (models resume-from-checkpoint). */
  startAt?: string
}

/**
 * Run a fixture graph once against a FRESH page. Every pass rebuilds the page
 * so runs never leak state into each other; the observation carries the page's
 * side-effect ledger, which is what the reliability assertions are about.
 */
export async function runPass(
  input: FixtureGraphInput,
  mode: FixtureMode,
  options: RunPassOptions,
): Promise<FixturePass> {
  const page = options.buildPage()
  const result = await runWorkflow(buildWorkflow(input, mode), {
    executors: buildFixtureExecutors(page),
    variables: { ...options.variables },
    ...(options.startAt ? { startAt: options.startAt } : {}),
    // Strict runs get the page-context guard (spec §11): the fake page IS the
    // "current page"; the engine checks it against the graph's grounding.
    ...(mode === 'strict'
      ? {
          getPageContext: async () => ({
            url: page.url,
          }),
        }
      : {}),
  })
  return {
    outcome: result.outcome,
    ...(result.error ? { error: result.error } : {}),
    completedNodeIds: result.completedNodeIds,
    variables: result.variables ?? {},
    actions: page.actions,
    submitCalls: page.submitCalls,
    url: page.url,
  }
}

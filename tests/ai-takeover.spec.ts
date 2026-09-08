/**
 * Tests for the AI takeover debug flow:
 *  - `lib/workflow/ai-takeover`: prompt building + verdict parsing,
 *  - `background/workflow-engine/ai-takeover`: the attempt loop (3 tries,
 *    feedback between attempts, output write-back, fix reporting),
 *  - engine integration: a completed takeover continues the run downstream,
 *    an exhausted takeover fails the run, onError='continue' bypasses it.
 *
 * The agent turn runner and settings are mocked so nothing touches the
 * network or chrome.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const runUnattended = vi.fn()
vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt: (...args: unknown[]) => runUnattended(...args),
}))

const getSettingsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getSettings: (...args: unknown[]) => getSettingsMock(...args) }
})

import { runWorkflow, type AiTakeoverRequest } from '../src/background/workflow-engine/engine'
import { createAiTakeover } from '../src/background/workflow-engine/ai-takeover'
import {
  HOPELESS_REASON_KINDS,
  TAKEOVER_MAX_ATTEMPTS,
  asReasonKind,
  buildTakeoverPrompt,
  classifyReason,
  outputVariableKeyOf,
  parseTakeoverVerdict,
  takeoverProviderOf,
} from '../src/lib/workflow/ai-takeover'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: '下单流程',
    description: '在购物网站下单',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: { ...data },
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  ...(handle ? { sourceHandle: handle } : {}),
})

function configuredSettings() {
  getSettingsMock.mockResolvedValue({
    providers: [{ id: 'p1', apiKey: 'k', baseUrl: 'https://x', model: 'm' }],
    activeProviderId: 'p1',
  })
}

// --- lib: prompt + verdict ---------------------------------------------------

describe('buildTakeoverPrompt', () => {
  it('contains the workflow intent, the takeover anchor, the failed step and the verdict contract', () => {
    const prompt = buildTakeoverPrompt({
      workflowName: '下单流程',
      workflowDescription: '在购物网站下单',
      steps: [{ kind: 'status', text: '已打开页面' }],
      previousNodeLine: '← new-tab: 打开购物网站',
      failing: {
        blockId: 'event-click',
        blockName: 'Click element',
        label: 'event-click',
        description: '点击搜索按钮',
        params: { selector: '.stale' },
      },
      error: '元素未找到: .stale',
      attempt: 1,
      maxAttempts: TAKEOVER_MAX_ATTEMPTS,
    })
    expect(prompt).toContain('下单流程')
    expect(prompt).toContain('← new-tab')
    expect(prompt).toContain('event-click')
    expect(prompt).toContain('点击搜索按钮')
    expect(prompt).toContain('.stale')
    expect(prompt).toContain('元素未找到')
    expect(prompt).toContain('snapshot_page')
    expect(prompt).toContain('"completed"')
    expect(prompt).toContain('attempt 1')
  })

  it('feeds the previous failed attempt back on retries', () => {
    const prompt = buildTakeoverPrompt({
      workflowName: 'w',
      steps: [],
      failing: { blockId: 'event-click', params: {} },
      error: 'e',
      attempt: 2,
      maxAttempts: 3,
      lastAttemptNote: '选择器不存在',
    })
    expect(prompt).toContain('attempt 2')
    expect(prompt).toContain('选择器不存在')
  })

  it('shows the earlier anchors, the downstream boundaries and the output variable', () => {
    const prompt = buildTakeoverPrompt({
      workflowName: 'w',
      steps: [],
      earlierNodeLines: ['← new-tab: 打开购物网站'],
      previousNodeLine: '← get-text: 读取用户名',
      upcomingNodeLines: ['form-fill: 填写收货地址', 'event-click: 提交订单'],
      outputVariable: 'price',
      failing: { blockId: 'get-text', params: {} },
      error: 'e',
      attempt: 1,
      maxAttempts: 3,
    })
    expect(prompt).toContain('← new-tab: 打开购物网站')
    expect(prompt).toContain('← get-text: 读取用户名')
    expect(prompt).toContain('填写收货地址')
    expect(prompt).toContain('do NOT do them')
    expect(prompt).toContain('{{price}}')
    expect(prompt).toContain('MUST PRODUCE a value')
  })

  it('feeds the previous attempt tool trace back with the no-repeat rule', () => {
    const prompt = buildTakeoverPrompt({
      workflowName: 'w',
      steps: [],
      failing: { blockId: 'event-click', params: {} },
      error: 'e',
      attempt: 2,
      maxAttempts: 3,
      lastAttemptNote: '点了错误的按钮',
      lastAttemptTrace: ['→ click(ref=e12)', '← click failed'],
    })
    expect(prompt).toContain('PREVIOUS attempt actually did')
    expect(prompt).toContain('→ click(ref=e12)')
    expect(prompt).toContain('← click failed')
    expect(prompt).toContain('Do NOT blindly repeat')
  })

  it('truncates overlong param strings so one node cannot blow the context', () => {
    const prompt = buildTakeoverPrompt({
      workflowName: 'w',
      steps: [],
      failing: { blockId: 'event-click', params: { selector: 'x'.repeat(500) } },
      error: 'e',
      attempt: 1,
      maxAttempts: 3,
    })
    expect(prompt).toContain('…')
    // The fixed guidance (incl. the upstream root-cause sections) is ~3.7k
    // chars; the bound catches param blow-ups.
    expect(prompt.length).toBeLessThan(3800)
  })
})

describe('parseTakeoverVerdict', () => {
  it('parses a clean verdict with output and fix', () => {
    const verdict = parseTakeoverVerdict(
      '{"completed":true,"summary":"已点击提交按钮","output":"ok","fix":{"paramsPatch":{"selector":"button.submit"}}}',
    )
    expect(verdict).toEqual({
      completed: true,
      summary: '已点击提交按钮',
      output: 'ok',
      paramsPatch: { selector: 'button.submit' },
    })
  })

  it('tolerates prose and markdown around the JSON (last object wins)', () => {
    const verdict = parseTakeoverVerdict(
      '我检查了页面。\n{"completed":false,"summary":"按钮在弹窗内"}\n再试:\n{"completed":true,"summary":"点击成功"}',
    )
    expect(verdict.completed).toBe(true)
    expect(verdict.summary).toBe('点击成功')
  })

  it('degrades to not-completed on garbage, empty or shape deviations', () => {
    expect(parseTakeoverVerdict('对不起，我做不到').completed).toBe(false)
    expect(parseTakeoverVerdict('').completed).toBe(false)
    expect(parseTakeoverVerdict('{"completed":"yes"}').completed).toBe(false)
    expect(parseTakeoverVerdict('{"completed":true,"fix":{"paramsPatch":"nope"}}').paramsPatch).toBeUndefined()
    expect(parseTakeoverVerdict('{"completed":true,"fix":{"paramsPatch":{}}}').paramsPatch).toBeUndefined()
  })

  it('rescues a finished step whose verdict JSON is mangled', () => {
    // No parseable JSON object, but the reply plainly claims success.
    const verdict = parseTakeoverVerdict('步骤已完成。我点击了提交按钮，"completed": true，页面跳转成功。')
    expect(verdict.completed).toBe(true)
    expect(verdict.summary).toContain('步骤已完成')
    // A completed:false claim inside a malformed object must NOT be rescued.
    expect(parseTakeoverVerdict('{"completed":false,"summary":"没做成').completed).toBe(false)
  })

  it('surfaces a whitelist reasonKind from the verdict JSON', () => {
    expect(parseTakeoverVerdict('{"completed":false,"summary":"要登录","reasonKind":"auth"}').reasonKind).toBe('auth')
    expect(parseTakeoverVerdict('{"completed":false,"reasonKind":"captcha"}').reasonKind).toBe('captcha')
    // Unknown values are dropped, not passed through.
    expect(parseTakeoverVerdict('{"completed":false,"reasonKind":"sudo rm -rf"}').reasonKind).toBeUndefined()
  })
})

describe('classifyReason', () => {
  it('classifies by keyword across Chinese and English failure text', () => {
    expect(classifyReason('需要输入验证码')).toBe('captcha')
    expect(classifyReason('CAPTCHA blocked the action')).toBe('captcha')
    expect(classifyReason('请先登录账号')).toBe('auth')
    expect(classifyReason('403 Forbidden')).toBe('auth')
    expect(classifyReason('请求超时 timed out')).toBe('timeout')
    expect(classifyReason('net::ERR_CONNECTION_REFUSED')).toBe('network')
    expect(classifyReason('元素未找到: .stale')).toBe('notfound')
    expect(classifyReason('按钮被遮挡')).toBeUndefined()
  })

  it('exposes the hopeless set that triggers fast-fail', () => {
    expect(HOPELESS_REASON_KINDS).toContain('auth')
    expect(HOPELESS_REASON_KINDS).toContain('captcha')
    expect(HOPELESS_REASON_KINDS).not.toContain('timeout')
  })

  it('asReasonKind whitelists', () => {
    expect(asReasonKind('notfound')).toBe('notfound')
    expect(asReasonKind('nonsense')).toBeUndefined()
    expect(asReasonKind(42)).toBeUndefined()
  })
})

describe('takeoverProviderOf', () => {
  const baseSettings = {
    providers: [
      { id: 'p1', apiKey: 'k1', baseUrl: 'https://one', model: 'chat-model' },
      { id: 'p2', apiKey: 'k2', baseUrl: 'https://two', model: 'other-model' },
    ],
    activeProviderId: 'p1',
    takeoverModel: { providerId: '', model: '' },
    takeoverOnRun: false,
  }

  it('returns the active provider when no override is configured', () => {
    expect(takeoverProviderOf(baseSettings as never)?.id).toBe('p1')
    expect(takeoverProviderOf(baseSettings as never)?.model).toBe('chat-model')
  })

  it('overrides the model on the active provider (model-only override)', () => {
    const result = takeoverProviderOf({
      ...baseSettings,
      takeoverModel: { providerId: '', model: 'strong-model' },
    } as never)
    expect(result?.id).toBe('p1')
    expect(result?.model).toBe('strong-model')
  })

  it('switches provider and model together', () => {
    const result = takeoverProviderOf({
      ...baseSettings,
      takeoverModel: { providerId: 'p2', model: 'from-p2' },
    } as never)
    expect(result?.id).toBe('p2')
    expect(result?.model).toBe('from-p2')
  })

  it('keeps the target provider default when only the provider is picked', () => {
    const result = takeoverProviderOf({
      ...baseSettings,
      takeoverModel: { providerId: 'p2', model: '' },
    } as never)
    expect(result?.id).toBe('p2')
    expect(result?.model).toBe('other-model')
  })

  it('falls back to the active provider when the override points nowhere', () => {
    const result = takeoverProviderOf({
      ...baseSettings,
      takeoverModel: { providerId: 'ghost', model: 'x' },
    } as never)
    expect(result?.id).toBe('p1')
  })
})

describe('outputVariableKeyOf', () => {
  it('finds the step output variable key', () => {
    expect(outputVariableKeyOf({ variableName: 'price' })).toBe('price')
    expect(outputVariableKeyOf({ responseVariable: 'http' })).toBe('http')
    expect(outputVariableKeyOf({ selector: '.x' })).toBeUndefined()
    expect(outputVariableKeyOf({ variableName: '  ' })).toBeUndefined()
  })
})

// --- background: the attempt loop -------------------------------------------

describe('createAiTakeover', () => {
  beforeEach(() => {
    configuredSettings()
    runUnattended.mockReset()
  })

  const request = (overrides: Partial<AiTakeoverRequest> = {}): AiTakeoverRequest => ({
    workflow: makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { selector: '.stale', variableName: 'out' }), node('c', 'delay')],
      [edge('a', 'b'), edge('b', 'c')],
    ),
    failingNodeId: 'b',
    failedBlockId: 'event-click',
    failedParams: { selector: '.stale', variableName: 'out' },
    failedError: '元素未找到: .stale',
    previousNodeId: 'a',
    steps: [{ kind: 'error', nodeId: 'b', text: '元素未找到: .stale' }],
    variables: {},
    signal: new AbortController().signal,
    ...overrides,
  })

  it('completes when the agent finishes the step: fix reported, output written back', async () => {
    runUnattended
      .mockResolvedValueOnce({ ok: true, answer: '{"completed":false,"summary":"页面还没加载"}' })
      .mockResolvedValueOnce({
        ok: true,
        answer: '{"completed":true,"summary":"点击了新的提交按钮","output":"done","fix":{"paramsPatch":{"selector":".fresh"}}}',
      })
    const onTakeover = vi.fn()
    const events: string[] = []
    const variables: Record<string, unknown> = {}
    const workflow = request({ variables }).workflow
    const hook = createAiTakeover({ onTakeover, onEvent: (_k, text) => events.push(text), attemptDelayMs: 0 })
    const outcome = await hook(request({ workflow, variables }))
    expect(outcome).toMatchObject({ completed: true, summary: '点击了新的提交按钮' })
    // Two attempts (first failed, second succeeded) with feedback on the retry.
    expect(runUnattended).toHaveBeenCalledTimes(2)
    const secondPrompt = runUnattended.mock.calls[1]?.[0] as string
    expect(secondPrompt).toContain('页面还没加载')
    expect(secondPrompt).toContain('this is attempt 2')
    // Output write-back into the node's declared output variable.
    expect(variables['out']).toBe('done')
    // Fix reported for user confirmation — and NOT applied to the graph.
    expect(onTakeover).toHaveBeenCalledTimes(1)
    const report = onTakeover.mock.calls[0]?.[0] as { completed: boolean; attempts: number; fix?: { paramsPatch: Record<string, unknown> } }
    expect(report.completed).toBe(true)
    expect(report.attempts).toBe(2)
    expect(report.fix?.paramsPatch).toEqual({ selector: '.fresh' })
    expect(workflow.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe('.stale')
    expect(events.some((text) => text.includes('第 1/3'))).toBe(true)
  })

  it('gives up after 3 failed attempts with the last reason', async () => {
    // '按钮被遮挡' classifies as "other" — retryable, so all 3 attempts run.
    runUnattended.mockResolvedValue({ ok: true, answer: '{"completed":false,"summary":"按钮被遮挡"}' })
    const onTakeover = vi.fn()
    const hook = createAiTakeover({ onTakeover, attemptDelayMs: 0 })
    const outcome = await hook(request())
    expect(runUnattended).toHaveBeenCalledTimes(3)
    expect(outcome).toMatchObject({ completed: false })
    expect(outcome?.reason).toContain('按钮被遮挡')
    // "other" is retryable, so the kind stays unclassified (undefined).
    expect(outcome?.reasonKind).toBeUndefined()
    expect(onTakeover).toHaveBeenCalledWith(expect.objectContaining({ completed: false, attempts: 3 }))
  })

  it('fast-fails hopeless reasons (captcha) on the FIRST attempt', async () => {
    runUnattended.mockResolvedValue({ ok: true, answer: '{"completed":false,"summary":"需要输入验证码"}' })
    const onTakeover = vi.fn()
    const hook = createAiTakeover({ onTakeover, attemptDelayMs: 0 })
    const outcome = await hook(request())
    // Retrying a captcha can never succeed — burn exactly one attempt.
    expect(runUnattended).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ completed: false, reasonKind: 'captcha' })
    expect(onTakeover).toHaveBeenCalledWith(
      expect.objectContaining({ completed: false, attempts: 1, reasonKind: 'captcha' }),
    )
  })

  it('fast-fails on the verdict-declared auth reasonKind without keyword matching', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer: '{"completed":false,"summary":"用户未登录","reasonKind":"auth"}',
    })
    const hook = createAiTakeover({ attemptDelayMs: 0 })
    const outcome = await hook(request())
    expect(runUnattended).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ completed: false, reasonKind: 'auth' })
  })

  it('treats a missing JSON verdict as a failed attempt', async () => {
    runUnattended.mockResolvedValue({ ok: true, answer: '我点了一下，好像没反应。' })
    const hook = createAiTakeover({ attemptDelayMs: 0 })
    const outcome = await hook(request())
    expect(runUnattended).toHaveBeenCalledTimes(3)
    expect(outcome?.completed).toBe(false)
  })

  it('feeds the previous attempt tool trace into the next attempt prompt', async () => {
    // Attempt 1 streams a tool action + result, then fails to complete.
    runUnattended
      .mockImplementationOnce(async (_prompt: string, _id: string, _mode: string, options: { onStep?: (kind: string, text: string) => void }) => {
        options.onStep?.('tool', '→ click')
        options.onStep?.('result', '← clicked nothing')
        options.onStep?.('status', 'thinking…')
        return { ok: true, answer: '{"completed":false,"summary":"按钮被遮挡"}' }
      })
      .mockResolvedValueOnce({
        ok: true,
        answer: '{"completed":true,"summary":"换了个按钮点到了"}',
      })
    const hook = createAiTakeover({ attemptDelayMs: 0 })
    await hook(request())
    const secondPrompt = runUnattended.mock.calls[1]?.[0] as string
    // The streamed actions survive into the retry prompt; the status line does not.
    expect(secondPrompt).toContain('→ click')
    expect(secondPrompt).toContain('← clicked nothing')
    expect(secondPrompt).toContain('按钮被遮挡')
    expect(secondPrompt).toContain('Do NOT blindly repeat')
  })

  it('passes the output variable, anchors and downstream boundaries into the prompt', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer: '{"completed":true,"summary":"读取到价格","output":"¥9.9"}',
    })
    const hook = createAiTakeover({})
    const workflow = makeWorkflow(
      [
        node('a', 'trigger', { description: '打开页面' }),
        node('b', 'event-click', { selector: '.stale', variableName: 'out' }),
        node('c', 'delay', { description: '等待加载' }),
      ],
      [edge('a', 'b'), edge('b', 'c')],
    )
    await hook(request({ workflow, steps: [{ kind: 'tool', nodeId: 'a', text: '' }, { kind: 'error', nodeId: 'b', text: '元素未找到: .stale' }] }))
    const prompt = runUnattended.mock.calls[0]?.[0] as string
    // failedParams declare variableName 'out' — the prompt must demand output.
    expect(prompt).toContain('{{out}}')
    expect(prompt).toContain('MUST PRODUCE a value')
    // 'a' ran before 'b' (anchor); 'c' comes after (do-NOT-do boundary).
    expect(prompt).toContain('打开页面')
    expect(prompt).toContain('等待加载')
    expect(prompt).toContain('do NOT do them')
    // The empty engine tool marker resolves to the node's label, not blank.
    expect(prompt).toMatch(/- \[tool\] .+/)
  })

  it('shows the upstream chain with node ids and the run variables for root-cause tracing', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer: '{"completed":true,"summary":"读取到价格","output":"¥9.9"}',
    })
    const hook = createAiTakeover({})
    const workflow = makeWorkflow(
      [
        node('a', 'get-text', { selector: '.title', variableName: 'title', description: '读取标题' }),
        node('b', 'event-click', { selector: '.stale' }),
      ],
      [edge('a', 'b')],
    )
    await hook(
      request({
        workflow,
        steps: [{ kind: 'tool', nodeId: 'a', text: '' }, { kind: 'error', nodeId: 'b', text: '元素未找到: .stale' }],
        variables: { title: '【促销】空气炸锅' },
      }),
    )
    const prompt = runUnattended.mock.calls[0]?.[0] as string
    // The upstream chain carries the node id + its params…
    expect(prompt).toContain('id=a')
    expect(prompt).toContain('.title')
    expect(prompt).toContain('读取标题')
    // …and the variable snapshot shows what upstream actually produced.
    expect(prompt).toContain('title = "【促销】空气炸锅"')
    // The fix contract names the upstream-root-cause option.
    expect(prompt).toContain('"nodeId"')
    expect(prompt).toContain('Upstream chain')
  })

  it('routes a fix to the upstream root-cause node when the agent names one', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer:
        '{"completed":true,"summary":"填写的是上游读错的内容","fix":{"nodeId":"a","paramsPatch":{"selector":".correct-title"}}}',
    })
    const onTakeover = vi.fn()
    const hook = createAiTakeover({ onTakeover })
    const workflow = makeWorkflow(
      [
        node('a', 'get-text', { selector: '.wrong', variableName: 'title', description: '读取标题' }),
        node('b', 'forms', { selector: '.box' }),
      ],
      [edge('a', 'b')],
    )
    await hook(
      request({
        workflow,
        failingNodeId: 'b',
        failedBlockId: 'forms',
        failedParams: { selector: '.box' },
        failedError: '值不对',
        previousNodeId: 'a',
        steps: [{ kind: 'tool', nodeId: 'a', text: '' }, { kind: 'error', nodeId: 'b', text: '值不对' }],
      }),
    )
    const report = onTakeover.mock.calls[0]?.[0] as { fix?: { nodeId: string; nodeLabel: string; note: string } }
    // The fix targets the UPSTREAM node, not the node that threw.
    expect(report.fix?.nodeId).toBe('a')
    expect(report.fix?.nodeLabel).toContain('读取标题')
    expect(report.fix?.note).toContain('根因在失败节点的上游')
    // …and nothing was applied to the graph.
    expect(workflow.drawflow.nodes.find((n) => n.id === 'a')?.data['selector']).toBe('.wrong')
  })

  it('falls back to the failing node when fix.nodeId is unknown', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer:
        '{"completed":true,"summary":"修好了","fix":{"nodeId":"ghost","paramsPatch":{"selector":".x"}}}',
    })
    const onTakeover = vi.fn()
    const hook = createAiTakeover({ onTakeover })
    await hook(request())
    const report = onTakeover.mock.calls[0]?.[0] as { fix?: { nodeId: string; note: string } }
    expect(report.fix?.nodeId).toBe('b')
    expect(report.fix?.note).not.toContain('根因在失败节点的上游')
  })

  it('fails fast when no model provider is configured', async () => {
    getSettingsMock.mockResolvedValue({ providers: [], activeProviderId: '' })
    const onTakeover = vi.fn()
    const hook = createAiTakeover({ onTakeover })
    const outcome = await hook(request())
    expect(runUnattended).not.toHaveBeenCalled()
    expect(outcome?.completed).toBe(false)
    expect(outcome?.reason).toContain('未配置模型')
    expect(onTakeover).toHaveBeenCalledWith(expect.objectContaining({ completed: false, attempts: 0 }))
  })

  it('stops immediately when the run is cancelled', async () => {
    runUnattended.mockResolvedValue({ ok: false, answer: '', cancelled: true })
    const hook = createAiTakeover({})
    const outcome = await hook(request())
    expect(outcome?.completed).toBe(false)
    expect(outcome?.reason).toContain('取消')
    expect(runUnattended).toHaveBeenCalledTimes(1)
  })

  it('passes the dedicated provider into the agent turn and pins the tab before running', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer: '{"completed":true,"summary":"完成"}',
    })
    const pinTab = vi.fn().mockResolvedValue(undefined)
    const provider = {
      id: 'p2',
      label: 'Strong',
      presetId: 'custom',
      apiKey: 'k2',
      baseUrl: 'https://y',
      model: 'strong-model',
    }
    const hook = createAiTakeover({ provider, pinTab })
    await hook(request({ tabId: 42 }))
    expect(pinTab).toHaveBeenCalledWith(42)
    const [, , , options] = runUnattended.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { provider?: unknown },
    ]
    expect(options.provider).toEqual(provider)
  })

  it('falls back to the active chat provider when no takeover model is set', async () => {
    runUnattended.mockResolvedValue({
      ok: true,
      answer: '{"completed":true,"summary":"完成"}',
    })
    const hook = createAiTakeover({})
    await hook(request())
    const [, , , options] = runUnattended.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { provider?: unknown },
    ]
    expect(options.provider).toBeUndefined()
  })
})

// --- engine integration ------------------------------------------------------

describe('engine AI takeover', () => {
  const wf = (): Workflow =>
    makeWorkflow(
      [node('a', 'step-a'), node('b', 'boom-block', { selector: '.stale' }), node('c', 'step-c')],
      [edge('a', 'b'), edge('b', 'c')],
    )

  it('a completed takeover continues with the downstream nodes in the SAME run', async () => {
    const order: string[] = []
    const requests: AiTakeoverRequest[] = []
    const result = await runWorkflow(wf(), {
      executors: {
        'step-a': async () => {
          order.push('a')
          return null
        },
        'boom-block': async () => {
          order.push('b!')
          throw new Error('元素未找到: .stale')
        },
        'step-c': async () => {
          order.push('c')
          return null
        },
      },
      aiTakeover: async (request) => {
        requests.push(request)
        order.push('ai')
        return { completed: true, summary: '手动点了按钮' }
      },
    })
    expect(order).toEqual(['a', 'b!', 'ai', 'c'])
    expect(result.outcome).toBe('ok')
    expect(result.completedNodeIds).toEqual(['a', 'b', 'c'])
    // The hook got the full failure context anchored at the previous node.
    const req = requests[0]!
    expect(req.failingNodeId).toBe('b')
    expect(req.failedBlockId).toBe('boom-block')
    expect(req.failedError).toBe('元素未找到: .stale')
    expect(req.previousNodeId).toBe('a')
    expect(req.steps.some((step) => step.kind === 'error' && step.text.includes('元素未找到'))).toBe(true)
    expect(req.workflow.id).toBe('wf')
  })

  it('an exhausted takeover fails the run with the takeover reason', async () => {
    const result = await runWorkflow(wf(), {
      executors: {
        'step-a': async () => null,
        'boom-block': async () => {
          throw new Error('元素未找到')
        },
        'step-c': async () => null,
      },
      aiTakeover: async () => ({ completed: false, reason: '验证码挡住了' }),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('元素未找到')
    expect(result.error).toContain('验证码挡住了')
    expect(result.completedNodeIds).toEqual(['a'])
  })

  it('a throwing takeover hook is contained into a run failure', async () => {
    const result = await runWorkflow(wf(), {
      executors: {
        'step-a': async () => null,
        'boom-block': async () => {
          throw new Error('boom')
        },
        'step-c': async () => null,
      },
      aiTakeover: async () => {
        throw new Error('model exploded')
      },
    })
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('model exploded')
  })

  it('onError fallback routing bypasses the takeover (user already decided)', async () => {
    const order: string[] = []
    let takeoverCalls = 0
    const result = await runWorkflow(
      makeWorkflow(
        [
          node('a', 'step-a'),
          node('b', 'boom-block', { onError: { enable: true, toDo: 'fallback' } }),
          node('c', 'step-c'),
          node('d', 'step-d'),
        ],
        [edge('a', 'b'), edge('b', 'c'), edge('b', 'd', 'boom-block-output-fallback')],
      ),
      {
        executors: {
          'step-a': async () => {
            order.push('a')
            return null
          },
          'boom-block': async () => {
            order.push('b!')
            throw new Error('nope')
          },
          'step-c': async () => {
            order.push('c')
            return null
          },
          'step-d': async () => {
            order.push('d')
            return null
          },
        },
        aiTakeover: async () => {
          takeoverCalls += 1
          return { completed: true }
        },
      },
    )
    expect(takeoverCalls).toBe(0)
    expect(order).toEqual(['a', 'b!', 'd'])
    expect(result.outcome).toBe('ok')
  })
})

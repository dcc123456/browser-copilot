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
  TAKEOVER_MAX_ATTEMPTS,
  buildTakeoverPrompt,
  outputVariableKeyOf,
  parseTakeoverVerdict,
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
    expect(prompt.length).toBeLessThan(3000)
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
    const hook = createAiTakeover({ onTakeover, onEvent: (_k, text) => events.push(text) })
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
    runUnattended.mockResolvedValue({ ok: true, answer: '{"completed":false,"summary":"验证码挡住了"}' })
    const onTakeover = vi.fn()
    const hook = createAiTakeover({ onTakeover })
    const outcome = await hook(request())
    expect(runUnattended).toHaveBeenCalledTimes(3)
    expect(outcome).toMatchObject({ completed: false })
    expect(outcome?.reason).toContain('验证码挡住了')
    expect(onTakeover).toHaveBeenCalledWith(expect.objectContaining({ completed: false, attempts: 3 }))
  })

  it('treats a missing JSON verdict as a failed attempt', async () => {
    runUnattended.mockResolvedValue({ ok: true, answer: '我点了一下，好像没反应。' })
    const hook = createAiTakeover({})
    const outcome = await hook(request())
    expect(runUnattended).toHaveBeenCalledTimes(3)
    expect(outcome?.completed).toBe(false)
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

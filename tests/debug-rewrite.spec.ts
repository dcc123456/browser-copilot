/**
 * Tests for the debug replay+audit core (`lib/workflow/debug-rewrite`):
 * prompt building (goal/plan, node listing, trace caps), defensive audit
 * parsing, and graph validation for the rewritten workflow.
 */
import { describe, expect, it } from 'vitest'

import {
  buildAuditPrompt,
  buildGoalCheckPrompt,
  buildReplayPrompt,
  buildRewrittenWorkflow,
  parseGoalVerdict,
  parseWorkflowAudit,
  planTextOf,
} from '../src/lib/workflow/debug-rewrite'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: { ...data },
})

function makeWorkflow(nodes: WorkflowNode[], plan?: string): Workflow {
  return {
    id: 'wf',
    name: '搜索下单',
    description: '在购物网站搜索并下单',
    ...(plan ? { plan } : {}),
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

describe('planTextOf', () => {
  it('uses the authored plan when present', () => {
    const wf = makeWorkflow([node('a', 'trigger')], '目标：下单\n执行步骤：\n1. 搜索')
    expect(planTextOf(wf)).toBe('目标：下单\n执行步骤：\n1. 搜索')
  })

  it('falls back to assembling goal + node descriptions', () => {
    const wf = makeWorkflow([
      node('a', 'trigger'),
      node('b', 'event-click', { description: '点击搜索按钮' }),
      node('c', 'forms', { description: '填写数量' }),
    ])
    const plan = planTextOf(wf)
    expect(plan).toContain('目标：搜索下单')
    expect(plan).toContain('1. 点击搜索按钮')
    expect(plan).toContain('2. 填写数量')
    // The trigger is not a "step".
    expect(plan).not.toContain('trigger')
  })
})

describe('buildReplayPrompt / buildAuditPrompt', () => {
  it('the replay prompt carries the brief and forbids dry runs', () => {
    const prompt = buildReplayPrompt(makeWorkflow([node('a', 'trigger')], '目标：X\n1. Y'))
    expect(prompt).toContain('目标：X')
    expect(prompt).toContain('snapshot_page')
    expect(prompt).toContain('actually do it')
    expect(prompt).toContain('"completed"')
  })

  it('the audit prompt lists nodes with params and caps the replay trace', () => {
    const wf = makeWorkflow([
      node('a', 'trigger'),
      node('b', 'event-click', { description: '点提交', selector: '.x'.repeat(60) }),
    ])
    const prompt = buildAuditPrompt(
      wf,
      { completed: true, summary: '实际点了新按钮', trace: Array.from({ length: 90 }, (_, i) => `→ t${i}`) },
      { error: '元素未找到: .stale', takeoverNote: '完成 0/1 个失败节点' },
    )
    expect(prompt).toContain('id=b')
    expect(prompt).toContain('点提交')
    expect(prompt).toContain('元素未找到: .stale')
    expect(prompt).toContain('实际点了新按钮')
    // Trace keeps the TAIL (most recent actions), capped at 60 lines.
    expect(prompt).toContain('→ t89')
    expect(prompt).not.toContain('→ t0\n')
    expect(prompt).toContain('"workflow":{"nodes"')
    // Truncated params cannot blow the context.
    expect(prompt.length).toBeLessThan(20000)
  })
})

describe('parseWorkflowAudit', () => {
  it('parses a full audit with diagnosis, verdicts, changes and graph', () => {
    const audit = parseWorkflowAudit(
      '分析如下。\n{"diagnosis":"选择器过期","nodes":[{"id":"b","verdict":"wrong","note":"实际用了 .fresh"},' +
        '{"id":"zzz","verdict":"bogus","note":"跳过"}],"changes":["修正选择器"],"workflow":{"nodes":[{"id":"a","label":"trigger","data":{"blockId":"trigger"}}],"edges":[]}}',
    )
    expect(audit?.diagnosis).toBe('选择器过期')
    expect(audit?.nodes).toEqual([
      { nodeId: 'b', nodeLabel: 'b', verdict: 'wrong', note: '实际用了 .fresh' },
    ])
    expect(audit?.changes).toEqual(['修正选择器'])
    expect(audit?.graph?.nodes).toHaveLength(1)
  })

  it('takes the LAST JSON object and tolerates fenced blocks', () => {
    const audit = parseWorkflowAudit(
      '```json\n{"diagnosis":"第一版"}\n```\n最终:\n{"diagnosis":"最终诊断","nodes":[],"changes":[]}',
    )
    expect(audit?.diagnosis).toBe('最终诊断')
  })

  it('returns null on garbage but survives a diagnosis-only reply', () => {
    expect(parseWorkflowAudit('对不起，我做不到')).toBeNull()
    const audit = parseWorkflowAudit('{"diagnosis":"整张图无法修复","nodes":[],"changes":[]}')
    expect(audit?.diagnosis).toBe('整张图无法修复')
    expect(audit?.graph).toBeNull()
  })
})

describe('buildRewrittenWorkflow', () => {
  const original = makeWorkflow([
    node('a', 'trigger', { blockId: 'trigger', type: 'manual' }),
    node('b', 'event-click', { blockId: 'event-click', selector: '.stale', description: '点提交' }),
  ])

  const graph = {
    nodes: [
      {
        id: 'a',
        label: 'trigger',
        position: { x: 0, y: 0 },
        data: { blockId: 'trigger', type: 'manual', description: '' },
      },
      {
        id: 'b',
        label: 'event-click',
        position: { x: 0, y: 140 },
        data: { blockId: 'event-click', selector: '.fresh', description: '点提交' },
      },
      {
        id: 'c',
        label: 'delay',
        data: { blockId: 'delay', description: '等待加载' },
      },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c', sourceHandle: '', targetHandle: '' },
    ],
  }

  it('builds the rewritten workflow, preserving identity and filling handles', () => {
    const rewritten = buildRewrittenWorkflow(original, graph)
    expect(rewritten).not.toBeNull()
    expect(rewritten?.id).toBe('wf')
    expect(rewritten?.name).toBe('搜索下单')
    expect(rewritten?.drawflow.nodes).toHaveLength(3)
    expect(rewritten?.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe('.fresh')
    // Handles auto-filled from the block ids when missing/blank.
    const edge2 = rewritten?.drawflow.edges.find((e) => e.id === 'e2')
    expect(edge2?.sourceHandle).toBe('event-click-output-1')
    expect(edge2?.targetHandle).toBe('delay-input-1')
    // Nodes without a position get a stacked one.
    expect(rewritten?.drawflow.nodes.find((n) => n.id === 'c')?.position).toEqual({ x: 160, y: 280 })
    // The input workflow is untouched.
    expect(original.drawflow.nodes).toHaveLength(2)
  })

  it('rejects graphs without a trigger, with unknown blocks, duplicate ids or no edges', () => {
    const noTrigger = {
      nodes: [graph.nodes[1], graph.nodes[2]],
      edges: [{ id: 'e', source: 'b', target: 'c' }],
    }
    expect(buildRewrittenWorkflow(original, noTrigger)).toBeNull()
    const unknownBlock = {
      nodes: [graph.nodes[0], { id: 'x', label: 'nuclear-launch', data: { blockId: 'nuclear-launch' } }],
      edges: [{ source: 'a', target: 'x' }],
    }
    expect(buildRewrittenWorkflow(original, unknownBlock)).toBeNull()
    const dupIds = {
      nodes: [graph.nodes[0], graph.nodes[0]],
      edges: [],
    }
    expect(buildRewrittenWorkflow(original, dupIds)).toBeNull()
    const noEdges = { nodes: graph.nodes, edges: [] }
    expect(buildRewrittenWorkflow(original, noEdges)).toBeNull()
    // Edges referencing unknown nodes are dropped; ALL lost ⇒ rejected.
    const danglingEdges = {
      nodes: graph.nodes,
      edges: [{ id: 'e1', source: 'a', target: 'ghost' }],
    }
    expect(buildRewrittenWorkflow(original, danglingEdges)).toBeNull()
  })
})

describe('goal-completion check (目标达成判定)', () => {
  it('the prompt shows the goal, the run evidence and the judge rules', () => {
    const wf = makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.x' })], '目标：搜索下单\n执行步骤：\n1. 搜索')
    const prompt = buildGoalCheckPrompt(wf, {
      steps: [{ kind: 'tool', text: 'event-click（.x）' }, { kind: 'result', text: '完成' }],
      variables: { price: '¥9.9' },
      summary: '运行成功',
    })
    expect(prompt).toContain('目标：搜索下单')
    expect(prompt).toContain('- [tool] event-click（.x）')
    expect(prompt).toContain('- price = "¥9.9"')
    expect(prompt).toContain('NOT achieved') // judge rules mention failure modes
    expect(prompt).toContain('"achieved"')
  })

  it('parses the verdict leniently and rejects garbage', () => {
    expect(parseGoalVerdict('{"achieved":true,"reason":"商品页已打开"}')).toEqual({
      achieved: true,
      reason: '商品页已打开',
    })
    expect(parseGoalVerdict('前言\n```json\n{"achieved":false,"reason":"价格变量为空"}\n```')).toEqual({
      achieved: false,
      reason: '价格变量为空',
    })
    expect(parseGoalVerdict('no json here')).toBeNull()
    expect(parseGoalVerdict('{"achieved":"yes"}')).toEqual({ achieved: false, reason: '' })
  })
})

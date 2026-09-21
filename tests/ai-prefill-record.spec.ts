/**
 * AI prefill on the OPERATOR record paths.
 *
 * Regression this file exists for: in workflow-generation mode the model
 * composes copy in conversation (a post, a reply, a summary) and passes it to
 * `wf_op_forms` as a literal. The dead-data rewriter then declared it a
 * workflow input with the composed text as `defaultValue` — the saved workflow
 * replayed that one text forever, exactly the "hardcoded copy" failure. The
 * history-compile path already regenerates such copy through an inserted
 * `ai-agent` node; these tests pin the same behavior on BOTH record paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async () => {},
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
})

import {
  actionNodesOf,
  getDraftSnapshot,
  runOperatorTool,
} from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import { aiPrefillSteps, applyAiPrefillOptions } from '../src/lib/storage'
import {
  isAiComposedFill,
  looksAiComposed,
} from '../src/lib/workflow/ai-prefill'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import type { WorkflowDraft } from '../src/lib/workflow/draft-types'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const signal = new AbortController().signal

/** A comment the model wrote itself in conversation — long enough to look composed. */
const COMPOSED_COPY = '这款保温杯采用316不锈钢内胆，保温长达12小时，通勤出差都很合适，现在下单还有专属优惠哦！'

function isAiAgent(node: WorkflowNode): boolean {
  return node.data?.['blockId'] === 'ai-agent'
}

function draftNodes(conversationId: string): WorkflowNode[] {
  return getDraftSnapshot(conversationId)!.nodes
}

function draftActionNodes(conversationId: string): WorkflowNode[] {
  return actionNodesOf(getDraftSnapshot(conversationId)!)
}

/** Wrap a recorded draft in the minimal `Workflow` shape the save card reads. */
function workflowOf(conversationId: string): Workflow {
  const draft: WorkflowDraft = getDraftSnapshot(conversationId)!
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes: draft.nodes, edges: draft.edges },
  }
}

function declaredInputDefaults(conversationId: string): unknown[] {
  const trigger = draftNodes(conversationId).find((n) => n.label === 'trigger')!
  return ((trigger.data['parameters'] ?? []) as { defaultValue?: unknown }[]).map(
    (p) => p.defaultValue,
  )
}

function okExecutors(overrides: Record<string, BlockExecutor> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const record =
    (blockId: string): BlockExecutor =>
    async (data) => {
      calls.push({ blockId, data })
      return null
    }
  return {
    calls,
    executors: {
      forms: record('forms'),
      'ai-agent': record('ai-agent'),
      ...overrides,
    } as Record<string, BlockExecutor>,
  }
}

function run(
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  executors: Record<string, BlockExecutor>,
) {
  return runOperatorToolWithExecution({ name, args, conversationId, signal, executors })
}

describe('looksAiComposed (moved to lib/workflow/ai-prefill)', () => {
  it('keeps the history-path semantics exactly', () => {
    expect(looksAiComposed(COMPOSED_COPY)).toBe(true)
    expect(looksAiComposed('iPhone 15')).toBe(false)
    expect(looksAiComposed('user@example.com')).toBe(false)
    expect(looksAiComposed('https://example.com/a')).toBe(false)
    expect(looksAiComposed('2024-01-02')).toBe(false)
  })
})

describe('isAiComposedFill', () => {
  const noVariables = new Map<string, string>()

  it('is scoped to forms — sinks keep the bulk gate', () => {
    for (const blockId of ['save-local', 'set-variable', 'webhook']) {
      expect(
        isAiComposedFill({
          blockId,
          data: { value: COMPOSED_COPY },
          generated: undefined,
          variableIndex: noVariables,
        }),
      ).toBeNull()
    }
  })

  it('honours the model self-report over the heuristic', () => {
    const data = { selector: '#reply', value: 'iPhone 15' }
    expect(isAiComposedFill({ blockId: 'forms', data, generated: true, variableIndex: noVariables })).toBe(
      'iPhone 15',
    )
    expect(
      isAiComposedFill({ blockId: 'forms', data: { ...data, value: COMPOSED_COPY }, generated: false, variableIndex: noVariables }),
    ).toBeNull()
  })

  it('skips read mode, non-text types, references and upstream-produced values', () => {
    const base = { blockId: 'forms', generated: true, variableIndex: noVariables }
    expect(isAiComposedFill({ ...base, data: { getValue: true, value: COMPOSED_COPY } })).toBeNull()
    expect(isAiComposedFill({ ...base, data: { type: 'select', value: COMPOSED_COPY } })).toBeNull()
    expect(isAiComposedFill({ ...base, data: { value: `前缀${COMPOSED_COPY}` } })).not.toBeNull()
    expect(isAiComposedFill({ ...base, data: { value: `x {{var}} y` } })).toBeNull()
    expect(
      isAiComposedFill({
        ...base,
        data: { value: COMPOSED_COPY },
        variableIndex: new Map([[COMPOSED_COPY, 'aiFill1']]),
      }),
    ).toBeNull()
  })
})

describe('the non-executing record path inserts the producer', () => {
  it('an unmarked composed fill records ai-agent → forms, not a frozen input', async () => {
    const result = await runOperatorTool({
      name: 'wf_op_forms',
      args: { selector: '#reply', type: 'text-field', value: COMPOSED_COPY },
      conversationId: 'prefill-plain',
    })
    expect(result.ok).toBe(true)

    const action = draftActionNodes('prefill-plain')
    expect(action.map((n) => n.data['blockId'])).toEqual(['ai-agent', 'forms'])
    const [ai, forms] = action as [WorkflowNode, WorkflowNode]
    expect(forms.data['value']).toBe('{{aiFill1}}')
    expect(ai.data['variableName']).toBe('aiFill1')
    expect(ai.data['actOnPage']).toBe(false)
    expect(ai.data['referenceValue']).toBe(COMPOSED_COPY)
    expect(String(ai.data['description'])).toContain('AI 生成表单内容')
    // The composed copy must not survive as a declared input's default — that
    // is precisely the "hardcoded copy" shape this feature replaces.
    expect(declaredInputDefaults('prefill-plain')).not.toContain(COMPOSED_COPY)
    // The producer is wired ahead of the consumer.
    const edges = getDraftSnapshot('prefill-plain')!.edges
    expect(edges.some((e) => e.source === ai.id && e.target === forms.id)).toBe(true)
  })

  it('generated:false keeps the declared-input behavior', async () => {
    const result = await runOperatorTool({
      name: 'wf_op_forms',
      args: { selector: '#reply', type: 'text-field', value: COMPOSED_COPY, generated: false },
      conversationId: 'prefill-user',
    })
    expect(result.ok).toBe(true)
    expect(draftActionNodes('prefill-user').map((n) => n.data['blockId'])).toEqual(['forms'])
    expect(draftActionNodes('prefill-user')[0]!.data['value']).toBe('{{formsValue}}')
    expect(declaredInputDefaults('prefill-user')).toContain(COMPOSED_COPY)
  })

  it('a short user-dictated value is left to the rewriter', async () => {
    const result = await runOperatorTool({
      name: 'wf_op_forms',
      args: { selector: '#q', type: 'text-field', value: 'iPhone 15' },
      conversationId: 'prefill-short',
    })
    expect(result.ok).toBe(true)
    expect(draftActionNodes('prefill-short').map((n) => n.data['blockId'])).toEqual(['forms'])
    expect(declaredInputDefaults('prefill-short')).toContain('iPhone 15')
  })

  it('generated is stripped from the recorded node', async () => {
    await runOperatorTool({
      name: 'wf_op_forms',
      args: { selector: '#q', type: 'text-field', value: 'iPhone 15', generated: false },
      conversationId: 'prefill-strip',
    })
    expect(draftActionNodes('prefill-strip')[0]!.data['generated']).toBeUndefined()
  })
})

describe('the executing record path inserts the producer', () => {
  it('records ai-agent → forms, executes only the fill, keeps the literal in audit', async () => {
    const { calls, executors } = okExecutors()
    const result = await run(
      'prefill-exec',
      'wf_op_forms',
      { selector: '#reply', type: 'text-field', value: COMPOSED_COPY },
      executors,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const action = draftActionNodes('prefill-exec')
    expect(action.map((n) => n.data['blockId'])).toEqual(['ai-agent', 'forms'])
    expect(action[1]!.data['value']).toBe('{{aiFill1}}')
    expect(action[0]!.data['referenceValue']).toBe(COMPOSED_COPY)
    // Only the forms block ran on the page — the producer is a replay plan,
    // exactly like the history compiler's insertion.
    expect(calls.map((c) => c.blockId)).toEqual(['forms'])
    // The page was driven with the composed text, so the audit says so.
    expect(result.audit.action).toBe('fill')
    expect(result.audit.args['value']).toBe(COMPOSED_COPY)
    expect(declaredInputDefaults('prefill-exec')).not.toContain(COMPOSED_COPY)
  })

  it('a long composed copy with generated:true skips the bulk refusal too', async () => {
    const longCopy = `${COMPOSED_COPY}这是模型继续撰写的第二段内容，用来把整段文案推过 bulk 门限，验证 generated 标记的豁免。`.repeat(
      5,
    )
    expect(longCopy.length).toBeGreaterThan(400)
    const { executors } = okExecutors()
    const result = await run(
      'prefill-long',
      'wf_op_forms',
      { selector: '#post', type: 'text-field', value: longCopy, generated: true },
      executors,
    )
    expect(result.ok).toBe(true)
    const action = draftActionNodes('prefill-long')
    expect(action.map((n) => n.data['blockId'])).toEqual(['ai-agent', 'forms'])
    expect(action[1]!.data['value']).toBe('{{aiFill1}}')
  })

  it('the model-authored recipe: reference variant, and the literal variant reuses the tail producer', async () => {
    const { executors } = okExecutors()
    const agent = await run(
      'prefill-model',
      'wf_op_ai-agent',
      {
        prompt: '为回复框写一句简短确认。',
        variableName: 'aiFill1',
        actOnPage: false,
        maxToolRounds: 8,
      },
      executors,
    )
    expect(agent.ok).toBe(true)
    // `ai-agent` is record-only during generation (no nested LLM run).
    if (!agent.ok) return
    expect(agent.executed).toBe(false)

    // The recipe's reference variant: no duplicate producer, and because the
    // producer never ran there is no captured text — the save card must NOT
    // offer a toggle whose uncheck would write an empty value.
    const referenced = await run(
      'prefill-model',
      'wf_op_forms',
      { selector: '#reply', type: 'text-field', value: '{{aiFill1}}' },
      executors,
    )
    expect(referenced.ok).toBe(true)
    expect(draftActionNodes('prefill-model').map((n) => n.data['blockId'])).toEqual([
      'ai-agent',
      'forms',
    ])
    expect(draftNodes('prefill-model').filter(isAiAgent)).toHaveLength(1)
    expect(draftNodes('prefill-model').find(isAiAgent)!.data['referenceValue']).toBeUndefined()
    expect(aiPrefillSteps(workflowOf('prefill-model'))).toEqual([])

    // Half-compliance: the model recorded its own ai-agent (the tail) but then
    // passed the composed text as a literal. The tail producer is referenced
    // instead of inserting a second one.
    const conv = 'prefill-model-literal'
    await run(conv, 'wf_op_ai-agent', { prompt: 'p', variableName: 'aiFill1', actOnPage: false }, executors)
    const literal = await run(
      conv,
      'wf_op_forms',
      { selector: '#reply', type: 'text-field', value: COMPOSED_COPY },
      executors,
    )
    expect(literal.ok).toBe(true)
    expect(draftActionNodes(conv).map((n) => n.data['blockId'])).toEqual(['ai-agent', 'forms'])
    expect(draftActionNodes(conv)[1]!.data['value']).toBe('{{aiFill1}}')
    expect(draftNodes(conv).filter(isAiAgent)).toHaveLength(1)
    expect(declaredInputDefaults(conv)).not.toContain(COMPOSED_COPY)
  })
})

describe('the save-card toggle works on recorded drafts', () => {
  it('aiPrefillSteps lists the pair; unchecking restores the conversation literal', async () => {
    const { executors } = okExecutors()
    await run(
      'prefill-card',
      'wf_op_forms',
      { selector: '#reply', type: 'text-field', value: COMPOSED_COPY },
      executors,
    )
    const workflow = workflowOf('prefill-card')

    const steps = aiPrefillSteps(workflow)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.referenceValue).toBe(COMPOSED_COPY)

    const formsId = draftActionNodes('prefill-card').find((n) => n.data['blockId'] === 'forms')!.id
    const off = applyAiPrefillOptions(workflow, { [formsId]: false })
    const offForms = off.drawflow.nodes.find((n) => n.id === formsId)!
    expect(offForms.data['value']).toBe(COMPOSED_COPY)

    const on = applyAiPrefillOptions(workflow, { [formsId]: true })
    expect(on.drawflow.nodes.find((n) => n.id === formsId)!.data['value']).toBe('{{aiFill1}}')
  })
})

/**
 * Retrieval-seeded generation (specs/2026-10-14-workflow-seed-recall-design.md).
 *
 * V93: a certified workflow's PROVEN steps are offered to the model at the one
 * seam every generation path must pass before its first page action
 * (`prepare_workflow_goal`), and whether that offer happened is recorded on the
 * saved workflow so the seeded and unseeded certification rates can be compared.
 *
 * The three things this file exists to keep true are the plan's hard clauses:
 * the offer is an offer — recall writes no draft node and no new path may join a
 * graph without executing it; with no candidate the tool result is the same
 * shape it has always been, byte for byte; and a failing selector behaves
 * exactly as it did before seeds existed (structured error, nothing recorded).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'
import { composeWorkflowFromDraft, getDraftSnapshot } from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import { actionNodesOf } from '../src/background/operator-tool-handler'
import { clearGenerationGoal } from '../src/lib/workflow/generation-goal-storage'
import {
  GENERATION_STAGE_ORDER,
  type GenerationStageId,
} from '../src/lib/workflow/generation-report'
import type { Workflow } from '../src/lib/workflow/types'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const listWorkflowsMock = vi.fn()
vi.mock('../src/lib/workflow/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/workflow/storage')>()
  return {
    ...actual,
    // One seam for both fixtures (a certified workflow present or absent) and
    // for the recall-throwing case, which must degrade instead of failing.
    listWorkflows: (...args: unknown[]) => listWorkflowsMock(...args),
  }
})

const getActiveProviderMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    listAgents: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
  }
})

const streamMock = vi.mocked(streamCompletion)

/**
 * `chrome.storage.local` plus one active tab. The tab is the site hint recall
 * reads when the goal itself names no URL.
 */
function makeChromeMock(tabUrl?: string) {
  return {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      query: vi.fn(async () => (tabUrl ? [{ id: 7, active: true, windowId: 1, url: tabUrl }] : [])),
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
  listWorkflowsMock.mockResolvedValue([])
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
})

let callSeq = 0
function toolCall(name: string, args: Record<string, unknown>) {
  return {
    id: `c${++callSeq}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }
}

function deps(conversationId: string) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    conversationId,
    getMode: async () => 'workflow' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
  }
}

/** Run one turn whose first model message is a single tool call. */
async function prepare(
  conversationId: string,
  goalArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  streamMock
    .mockResolvedValueOnce({
      content: '',
      toolCalls: [toolCall('prepare_workflow_goal', goalArgs)],
    } as never)
    .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
  const history: { role: string; content?: string }[] = [{ role: 'user', content: 'build it' }]
  await runAgentTurn(history as never, deps(conversationId) as never)
  const toolMsg = history.find((m) => m.role === 'tool')!
  return JSON.parse(toolMsg.content ?? '{}') as Record<string, unknown>
}

const SITE = 'https://creator.xiaohongshu.com/publish/publish'

/** The goal the fixture below was certified against, in its own words. */
const seededGoal = {
  summary: '把图文笔记保存成草稿，草稿箱出现新条目',
  successConditions: [{ kind: 'elementExists', target: { text: '草稿箱' } }],
  requiredCapabilities: ['click', 'element-exists'],
}

/** A goal nothing in storage matches, and that does not ask for a draft. */
const unseededGoal = {
  summary: 'The success banner is shown after submit.',
  successConditions: [{ kind: 'elementExists', target: { text: 'success' } }],
  requiredCapabilities: ['click', 'element-exists'],
}

/** One step of a proven graph: a recorded selector is what makes it offerable. */
function certifiedWorkflow(): Workflow {
  const now = Date.now()
  return {
    id: 'wf-certified-1',
    name: 'Publish note and save draft',
    createdAt: now - 86_400_000,
    updatedAt: now - 60_000,
    drawflow: {
      nodes: [
        {
          id: 't1',
          label: 'trigger',
          position: { x: 0, y: 0 },
          data: { blockId: 'trigger', type: 'manual' },
        },
        {
          id: 'n1',
          label: 'event-click',
          position: { x: 0, y: 0 },
          data: {
            blockId: 'event-click',
            selector: '[data-testid="save-draft"]',
            description: '点击保存草稿',
          },
        },
      ],
      edges: [],
    },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: true,
      reuseLastState: false,
      certificationStatus: 'certified',
      provenance: 'chat-generate',
      reliabilityMode: 'generated-strict',
      generationOriginUrl: SITE,
      goalSpec: {
        summary: '把图文笔记保存成草稿，草稿箱出现新条目',
        successConditions: [{ kind: 'elementExists', target: { text: '草稿箱' } }],
      },
    },
  }
}

const signal = new AbortController().signal

describe('V93a the offer rides the goal result', () => {
  it('carries the proven step and attributes it, without touching the graph', async () => {
    vi.stubGlobal('chrome', makeChromeMock(SITE))
    listWorkflowsMock.mockResolvedValue([certifiedWorkflow()])
    const conversationId = `conv-v93a-${Math.random().toString(36).slice(2)}`
    await clearGenerationGoal(conversationId)

    const result = await prepare(conversationId, seededGoal)

    const seeds = result['seeds'] as {
      workflowId: string
      siteMatch: boolean
      steps: Record<string, unknown>[]
    }[]
    expect(seeds).toHaveLength(1)
    expect(seeds[0]!.workflowId).toBe('wf-certified-1')
    expect(seeds[0]!.siteMatch).toBe(true)
    expect(seeds[0]!.steps[0]!.selector).toBe('[data-testid="save-draft"]')
    expect(String(result['note'])).toContain('`seeds`')

    // Attribution is recorded for compose to carry onto the workflow…
    const draft = getDraftSnapshot(conversationId)!
    expect(draft.seededFrom).toEqual(['wf-certified-1'])
    // …and nothing about the offer joins the graph. This is the invariant the
    // whole feature rests on: an offer is not a draft.
    expect(actionNodesOf(draft)).toHaveLength(0)
  })

  it('still hands back the goal contract when recall throws', async () => {
    vi.stubGlobal('chrome', makeChromeMock(SITE))
    listWorkflowsMock.mockRejectedValue(new Error('storage unavailable'))
    const conversationId = `conv-v93a-throw-${Math.random().toString(36).slice(2)}`
    await clearGenerationGoal(conversationId)

    const result = await prepare(conversationId, seededGoal)

    // The goal contract gates everything downstream; recall must never take it
    // down with it, so a thrown recall degrades to today's unseeded generation.
    expect(result['ok']).toBe(true)
    expect(result['seeds']).toBeUndefined()
  })
})

describe('V93b no candidate means no change at all', () => {
  it('the result has the same keys and the same note it had before seeds existed', async () => {
    const conversationId = `conv-v93b-${Math.random().toString(36).slice(2)}`
    await clearGenerationGoal(conversationId)

    const result = await prepare(conversationId, unseededGoal)

    // `seeds` is absent as a KEY, not null: the payload the model sees with no
    // candidate is the payload it saw last release.
    expect(Object.keys(result)).toEqual(['ok', 'name', 'goalSpec', 'requiredCapabilities', 'note'])
    expect(result['note']).toBe(
      'Goal contract established. Operators may now execute; final success is judged against this goal.',
    )
    expect(getDraftSnapshot(conversationId)?.seededFrom).toBeUndefined()
  })
})

describe('V93c compose attributes the seed and reports the stage', () => {
  /** Execute the seeded step for real: the graph is only ever written here. */
  async function executeClick(conversationId: string, executor: BlockExecutor) {
    return runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      args: { selector: '[data-testid="save-draft"]' },
      conversationId,
      signal,
      executors: { 'event-click': executor },
    })
  }

  it('records seededFrom and a SEED_RECALL stage when the offer was used', async () => {
    vi.stubGlobal('chrome', makeChromeMock(SITE))
    listWorkflowsMock.mockResolvedValue([certifiedWorkflow()])
    const conversationId = `conv-v93c-${Math.random().toString(36).slice(2)}`
    await clearGenerationGoal(conversationId)
    await prepare(conversationId, seededGoal)

    const out = await executeClick(conversationId, async () => null)
    expect(out.ok).toBe(true)

    const composed = await composeWorkflowFromDraft(conversationId, { save: false })
    if ('error' in composed) throw new Error(composed.error)
    expect(composed.workflow.settings.seededFrom).toEqual(['wf-certified-1'])
    const stages = composed.workflow.settings.generationStages!
    expect(stages[0]!.stage).toBe('SEED_RECALL')
    expect(stages[0]!.status).toBe('ok')
    // Still one report per stage, in the declared order, with no duplicates.
    expect(stages.map((s) => s.stage)).toEqual([...GENERATION_STAGE_ORDER])
  })

  it('reports the stage as skipped and records no attribution when unseeded', async () => {
    const conversationId = `conv-v93c-skip-${Math.random().toString(36).slice(2)}`
    await clearGenerationGoal(conversationId)
    await prepare(conversationId, unseededGoal)
    const out = await executeClick(conversationId, async () => null)
    expect(out.ok).toBe(true)

    const composed = await composeWorkflowFromDraft(conversationId, { save: false })
    if ('error' in composed) throw new Error(composed.error)
    expect(composed.workflow.settings.seededFrom).toBeUndefined()
    const stages = composed.workflow.settings.generationStages!
    expect(stages[0]!.stage).toBe('SEED_RECALL')
    expect(stages[0]!.status).toBe('skipped')
  })

  it('keeps the seed recall stage in the declared order, once per generation', () => {
    // The contract this feature changed: the static pipeline grew from six
    // stages to seven, and SEED_RECALL is FIRST because recall runs before the
    // first step is executed. Asserted as an exact list so a stage added at the
    // wrong position, or dropped from the report, fails here.
    expect(GENERATION_STAGE_ORDER).toEqual([
      'SEED_RECALL',
      'NORMALIZE',
      'GENERALIZE_INPUTS',
      'HARDEN_TARGETS',
      'BUILD_RELIABILITY',
      'STATIC_VALIDATE',
      'INDEPENDENT_VERIFY',
    ] satisfies GenerationStageId[])
  })
})

describe('V93d E6 a stale seeded locator is an ordinary failure', () => {
  it('returns the structured error and records nothing', async () => {
    vi.stubGlobal('chrome', makeChromeMock(SITE))
    listWorkflowsMock.mockResolvedValue([certifiedWorkflow()])
    const conversationId = `conv-v93d-${Math.random().toString(36).slice(2)}`
    await clearGenerationGoal(conversationId)
    const result = await prepare(conversationId, seededGoal)
    const offered = (result['seeds'] as { steps: { selector?: string }[] }[])[0]!.steps[0]!
      .selector!

    const out = await runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      args: { selector: offered },
      conversationId,
      signal,
      executors: {
        'event-click': async () => {
          throw new Error(`no element matched "${offered}"`)
        },
      },
    })

    // The page moved: the seed is wrong, exactly as a freshly invented selector
    // would be. The offer adds no new failure mode and no new error shape.
    expect(out).toEqual({ ok: false, error: `no element matched "${offered}"` })
    const draft = getDraftSnapshot(conversationId)!
    expect(actionNodesOf(draft)).toHaveLength(0)
    // Attribution survives: the generation was seeded, whether or not the model
    // reused it, which is what makes the two cohorts comparable.
    expect(draft.seededFrom).toEqual(['wf-certified-1'])
  })
})

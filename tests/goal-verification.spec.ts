import { describe, expect, it } from 'vitest'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type {
  ConditionBaseline,
  ConditionPageProbe,
} from '../src/background/workflow-engine/condition-runtime'
import { conditionLocatorKey, describeCondition } from '../src/lib/workflow/conditions'
import type { ExecuteWorkflowResult } from '../src/background/workflow-engine/run-workflow'
import type { Workflow } from '../src/lib/workflow/types'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
const probe: ConditionPageProbe = {
  exists: async () => true,
  visible: async () => true,
  enabled: async () => true,
  text: async () => 'Done',
  attribute: async () => 'value',
  count: async () => 1,
  url: async () => 'https://example.com/done',
}
function workflowWith(nodeData: Record<string, unknown>): Workflow {
  return {
    id: 'w1',
    name: 'Task',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      provenance: 'chat-generate',
      goalSpec: {
        summary: 'The done banner exists.',
        successConditions: [{ kind: 'variableExists', name: 'result' }],
      },
    },
    drawflow: {
      nodes: [
        {
          id: 'n1',
          label: 'forms',
          position: { x: 0, y: 0 },
          data: { blockId: 'forms', ...nodeData },
        },
      ],
      edges: [],
    },
  } as unknown as Workflow
}
const okRun: ExecuteWorkflowResult = { runId: 'r1', outcome: 'ok', variables: { result: 'done' } }
describe('goal verification engine', () => {
  it('certifies when L1/L2/L3 all pass', async () => {
    const data = withNodeGoalContract(
      { blockId: 'forms' },
      {
        version: 1,
        goal: 'fill the result',
        successCriteria: [{ kind: 'variableExists', name: 'result' }],
      },
    )
    const report = await verifyWorkflowGoal(workflowWith(data), okRun, probe)
    expect(report.l1.every((c) => c.satisfied)).toBe(true)
    expect(report.l2.allHeld).toBe(true)
    expect(report.l3.allHeld).toBe(true)
    expect(report.certified).toBe(true)
  })
  it('fails L1 when execution failed', async () => {
    const failedRun: ExecuteWorkflowResult = {
      runId: 'r2',
      outcome: 'failed',
      error: 'boom',
      variables: {},
    }
    const report = await verifyWorkflowGoal(workflowWith({}), failedRun, probe)
    expect(report.level).toBe('L1')
    expect(report.certified).toBe(false)
  })
  it('fails L2 when a node contract does not hold', async () => {
    const data = withNodeGoalContract(
      { blockId: 'forms' },
      {
        version: 1,
        goal: 'need missing var',
        successCriteria: [{ kind: 'variableExists', name: 'missing' }],
      },
    )
    const report = await verifyWorkflowGoal(workflowWith(data), okRun, probe)
    expect(report.level).toBe('L2')
    expect(report.certified).toBe(false)
    // Round 57 replayed 20/20 and saved the draft, and «a node goal contract did
    // not hold» was the whole answer — no step, no condition. The sentence has to
    // name which promise broke, or a reader cannot tell a failed run from a
    // contract written wrong.
    expect(report.reason).toContain('forms')
    expect(report.reason).toContain('missing')
  })
  it('last node succeeds but goal fails: L3 fail, not certified', async () => {
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'need goalVar',
      successConditions: [{ kind: 'variableExists', name: 'goalVar' }],
    }
    const report = await verifyWorkflowGoal(workflow, okRun, probe)
    expect(report.l3.allHeld).toBe(false)
    expect(report.level).toBe('L3')
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('L3')
  })
  it('a step that never ran fails L1 even when the run as a whole finished OK', async () => {
    // `onError: continue` and untaken branches produce exactly this run: outcome
    // 'ok' with a node left behind. Certifying it would call a partial run a
    // verified one.
    const partialRun: ExecuteWorkflowResult = {
      ...okRun,
      completedNodeIds: [],
    }
    const report = await verifyWorkflowGoal(workflowWith({}), partialRun, probe)
    expect(report.l1[0]?.satisfied).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('L1')
  })
  it('an unconfirmed declared outcome withholds the badge without failing the run', async () => {
    const data = withNodeGoalContract(
      { blockId: 'forms' },
      {
        version: 1,
        goal: 'fill the result',
        successCriteria: [{ kind: 'variableExists', name: 'result' }],
      },
    )
    const softRun: ExecuteWorkflowResult = {
      ...okRun,
      completedNodeIds: ['n1'],
      conditionWarnings: ['n2: 元素新出现 [role=dialog]'],
    }
    const report = await verifyWorkflowGoal(workflowWith(data), softRun, probe)
    expect(report.l3.allHeld).toBe(true)
    expect(report.softUnconfirmed).toEqual(['n2: 元素新出现 [role=dialog]'])
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('not confirmed')
  })
  it('reports L2 as unevaluated when no node declared a contract', async () => {
    const report = await verifyWorkflowGoal(
      workflowWith({}),
      { ...okRun, completedNodeIds: ['n1'] },
      probe,
    )
    expect(report.l2.allHeld).toBe(true)
    expect(report.l2.evaluated).toBe(false)
    // Nothing at the node layer was checked, so a pass here comes from L3 alone.
    expect(report.l2.nodes[0]?.criteria).toHaveLength(0)
  })
  it('a URL-only success row cannot certify, even when it holds', async () => {
    // The round-9 graph, exactly: its goal row was `urlContains
    // creator.xiaohongshu.com/publish`, the page it opens IS the publish page, so
    // the condition was true before step 1 ran and stayed true whatever the graph
    // did. Certifying on that is the facade — S0 already refuses a URL as
    // evidence (`provesLandedEffect`), and L3 has to use the same standard or the
    // two layers disagree about what counts as proof.
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'A draft is saved on the publish page.',
      successConditions: [{ kind: 'urlContains', value: 'example.com/done' }],
    }
    const report = await verifyWorkflowGoal(workflow, { ...okRun, completedNodeIds: ['n1'] }, probe)
    expect(report.l3.conditions[0]?.satisfied).toBe(true)
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('proves the goal landed')
  })
  it('one effect-proving condition among the URL rows is enough', async () => {
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'A draft is saved.',
      successConditions: [
        { kind: 'urlContains', value: 'example.com/done' },
        { kind: 'variableExists', name: 'result' },
      ],
    }
    const report = await verifyWorkflowGoal(workflow, { ...okRun, completedNodeIds: ['n1'] }, probe)
    expect(report.certified).toBe(true)
  })
  it('a missing variable row names the variables this run DID hold', async () => {
    // 「变量 xiaohongshuTitle 不存在」 alone cannot be acted on: it is either the
    // goal naming an invention or the run failing to produce it, and the run's
    // own variable names are the only evidence that tells them apart.
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'A draft is saved.',
      successConditions: [
        { kind: 'variableExists', name: 'result' },
        { kind: 'variableExists', name: 'xiaohongshuTitle' },
      ],
    }
    const run: ExecuteWorkflowResult = {
      runId: 'r5',
      outcome: 'ok',
      completedNodeIds: ['n1'],
      variables: { result: 'done', xhsTitle: '这个 AI 会替你点网页', noteBody: '正文' },
    }
    const report = await verifyWorkflowGoal(workflow, run, probe)
    const unmet = report.l3.conditions.find((c) => !c.satisfied)
    expect(unmet?.detail).toContain('xhsTitle')
    expect(unmet?.detail).toContain('noteBody')
    // A row that holds carries no such note.
    expect(report.l3.conditions.find((c) => c.satisfied)?.detail).toBeUndefined()
  })
  it('does not re-observe a goal row that only compares against the state before its step', async () => {
    // `urlChanged` was checked by the engine AT that node against the page before
    // it; after the run there is no baseline, so observing it again can only read
    // false — which is how a graph that really moved the page failed its own goal.
    // Its miss is not lost: a change condition is soft, so it reaches us through
    // `conditionWarnings` (see the next-but-one test above).
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'The page changed and the banner is up.',
      successConditions: [{ kind: 'urlChanged' }, { kind: 'variableExists', name: 'result' }],
    }
    const report = await verifyWorkflowGoal(workflow, { ...okRun, completedNodeIds: ['n1'] }, probe)
    expect(report.l3.conditions.map((c) => c.satisfied)).toEqual([true])
    expect(report.l3.unevaluated).toHaveLength(1)
    expect(report.certified).toBe(true)
  })
  it('a goal of nothing but before-the-step rows certifies nothing', async () => {
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'The URL changed.',
      successConditions: [
        { kind: 'urlChanged' },
        { kind: 'elementAppeared', target: { text: '草稿箱' } },
      ],
    }
    const report = await verifyWorkflowGoal(workflow, { ...okRun, completedNodeIds: ['n1'] }, probe)
    expect(report.l3.conditions).toEqual([])
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('before its step')
  })
  it('a node contract row needing a baseline leaves the L2 ballot unevaluated', async () => {
    const data = withNodeGoalContract(
      { blockId: 'forms' },
      {
        version: 1,
        goal: 'the page moved',
        successCriteria: [
          { kind: 'elementGone', target: { text: '加载中' } },
          { kind: 'variableExists', name: 'result' },
        ],
      },
    )
    const report = await verifyWorkflowGoal(
      workflowWith(data),
      { ...okRun, completedNodeIds: ['n1'] },
      probe,
    )
    expect(report.l2.nodes[0]?.criteria.map((c) => c.satisfied)).toEqual([true])
    expect(report.l2.nodes[0]?.unevaluated).toHaveLength(1)
    expect(report.l2.unevaluated).toHaveLength(1)
    expect(report.certified).toBe(true)
  })
})

describe('goal verification against the pre-run baseline the run carries', () => {
  const draftBox = { text: '草稿箱' }
  const runWithBaseline = (baseline: ConditionBaseline): ExecuteWorkflowResult => ({
    ...okRun,
    completedNodeIds: ['n1'],
    goalBaseline: baseline,
  })

  it('certifies a goal the run made TRUE against the page it started from', async () => {
    // The list had no rows before step 1 and has one now — a claim the standing
    // furniture cannot support, and the reason the engine keeps a snapshot of the
    // page from before the first step.
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'A new draft row appears in the list.',
      successConditions: [{ kind: 'countIncreased', target: { selector: '.note-item' } }],
    }
    const baseline: ConditionBaseline = {
      counts: { [conditionLocatorKey({ selector: '.note-item' })]: 0 },
      exists: {},
    }
    const report = await verifyWorkflowGoal(workflow, runWithBaseline(baseline), probe)
    expect(report.l3.unevaluated).toBeUndefined()
    expect(report.l3.conditions[0]?.satisfied).toBe(true)
    expect(report.certified).toBe(true)
  })

  it('refuses a presence row the page already satisfied before the run', async () => {
    // Round 74 certified a goal whose only holding row was satisfied by the page
    // standing furniture (小红书 shows 草稿箱(100) whether or not this run saved
    // anything). Given the page from BEFORE the run, the row that claims the box
    // APPEARED reads false, and the furniture row left alone no longer carries
    // the goal.
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'A draft is saved.',
      successConditions: [
        { kind: 'elementVisible', target: draftBox },
        { kind: 'elementAppeared', target: draftBox },
      ],
    }
    const baseline: ConditionBaseline = {
      counts: {},
      exists: { [conditionLocatorKey(draftBox)]: true },
    }
    const report = await verifyWorkflowGoal(workflow, runWithBaseline(baseline), probe)
    expect(report.l3.conditions.map((c) => c.satisfied)).toEqual([true, false])
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
  })

  it('refuses a satisfied text row whose words the page showed before the run', async () => {
    // Round 77, to the letter: 13/13 steps, the draft really saved, and the only
    // success row the goal had was 「页面文本包含 草稿」 aimed at 「草稿箱」 — a row that
    // read true on the untouched page. It holds now, so it is not a failed
    // condition; it just proves nothing, and the verdict has to say so.
    const showsDraftBox: ConditionPageProbe = {
      ...probe,
      text: async () => '草稿箱(100)',
    }
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'The draft list shows the saved draft.',
      successConditions: [
        { kind: 'elementText', target: draftBox, match: 'contains', expected: '草稿' },
      ],
    }
    // The row is read back normalized — an `elementText` locator aligns to the
    // words it demands (`alignElementTextTarget`), and the engine snapshots THAT
    // target, so the baseline key is the aligned one, not the words the model
    // happened to write.
    const showsDraft = conditionLocatorKey({ text: '草稿' })
    const baseline: ConditionBaseline = {
      counts: {},
      exists: { [showsDraft]: true },
      texts: { [showsDraft]: '草稿箱(100)' },
    }
    const report = await verifyWorkflowGoal(workflow, runWithBaseline(baseline), showsDraftBox)
    expect(report.l3.conditions[0]?.satisfied).toBe(true)
    expect(report.l3.conditions[0]?.detail).toContain('步骤前')
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('before the run')
  })

  it('says the draft really landed when the goal has no row that could see it', async () => {
    // Round 80 replayed 18/18 and wrote a real 图文 draft, and the verdict a
    // reader got was a refusal to believe it. When the graph's own draft-save
    // step ran in THIS run, «no landing proof» is a goal-writing gap, not a
    // failed run, and the only actionable fix is the missing step and row.
    const workflow = workflowWith({})
    workflow.drawflow.nodes.push({
      id: 'n2',
      label: 'event-click',
      position: { x: 0, y: 0 },
      data: {
        blockId: 'event-click',
        selector: '#draft',
        __reliability: { intent: '把已填好标题与正文的图文笔记保存为草稿，不发布' },
      },
    } as never)
    workflow.drawflow.edges.push({ source: 'n1', target: 'n2' } as never)
    workflow.settings!.goalSpec = {
      summary: 'The draft list shows the saved draft.',
      successConditions: [
        { kind: 'elementText', target: draftBox, match: 'contains', expected: '草稿' },
      ],
    }
    const showsDraft = conditionLocatorKey({ text: '草稿' })
    const baseline: ConditionBaseline = {
      counts: {},
      exists: { [showsDraft]: true },
      texts: { [showsDraft]: '草稿箱(100)' },
    }
    const run = {
      ...okRun,
      completedNodeIds: ['n1', 'n2'],
      goalBaseline: baseline,
    }
    const report = await verifyWorkflowGoal(workflow, run, {
      ...probe,
      text: async () => '草稿箱(100)',
    })
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('a draft was written')
    expect(report.reason).toContain('草稿箱')

    // A run that stopped AT the save wrote nothing, and the sentence must go.
    const stopped = await verifyWorkflowGoal(
      workflow,
      { ...run, stoppedBefore: 'n2' },
      { ...probe, text: async () => '草稿箱(100)' },
    )
    expect(stopped.reason).toContain('before the run')
    expect(stopped.reason).not.toContain('a draft was written')
  })

  it('certifies a text row that names the artifact through a run variable', async () => {
    // The same row shape, but the words are the ones THIS run wrote into a
    // variable, so they cannot have been on the page before it started.
    const draftTitle = { selector: '.draft-title' }
    const key = conditionLocatorKey(draftTitle)
    const workflow = workflowWith({})
    workflow.settings!.goalSpec = {
      summary: 'The saved draft is listed under the title this run wrote.',
      successConditions: [
        { kind: 'elementText', target: draftTitle, match: 'contains', expected: '{{title}}' },
      ],
    }
    const report = await verifyWorkflowGoal(
      workflow,
      {
        ...runWithBaseline({
          counts: {},
          exists: { [key]: false },
          texts: { [key]: '草稿箱(100)' },
        }),
        variables: { result: 'done', title: '图文推广草稿' },
      },
      { ...probe, text: async () => '图文推广草稿' },
    )
    expect(report.l3.conditions[0]?.satisfied).toBe(true)
    expect(report.l3.allHeld).toBe(true)
    expect(report.certified).toBe(true)
  })
})

describe('L2 votes with the observation taken at the step', () => {
  // The page the LAST step left is not the page an earlier step promised.
  const goneNow: ConditionPageProbe = {
    exists: async () => false,
    visible: async () => false,
    enabled: async () => false,
    text: async () => '',
    attribute: async () => '',
    count: async () => 0,
    url: async () => 'https://creator.xiaohongshu.com/new/home',
  }
  const titleInput = { selector: 'input[placeholder*="标题"]' }
  const formsWorkflow = (): Workflow => {
    const workflow = workflowWith(
      withNodeGoalContract(
        { blockId: 'forms' },
        {
          version: 1,
          goal: 'fill the title',
          successCriteria: [{ kind: 'elementExists', target: titleInput }],
        },
      ),
    )
    workflow.settings!.goalSpec = {
      summary: 'A variable was produced.',
      successConditions: [{ kind: 'variableExists', name: 'result' }],
    }
    return workflow
  }

  it('does not fail a step whose element the run has since navigated away from', async () => {
    // Round 76: 13/13 steps, the draft really saved, and the ballot refused it
    // because the title input of the publish form is not on the page the save
    // navigated to. The engine saw that input while the step still stood on it.
    const run: ExecuteWorkflowResult = {
      ...okRun,
      completedNodeIds: ['n1'],
      nodeConditions: [
        {
          nodeId: 'n1',
          description: describeCondition({ kind: 'elementExists', target: titleInput }),
          satisfied: true,
        },
      ],
    }
    const report = await verifyWorkflowGoal(formsWorkflow(), run, goneNow)
    expect(report.l2.nodes[0]?.criteria).toEqual([
      {
        description: describeCondition({ kind: 'elementExists', target: titleInput }),
        satisfied: true,
      },
    ])
    expect(report.certified).toBe(true)
  })

  it('keeps a step that really broke failed, even when the element is back', async () => {
    const run: ExecuteWorkflowResult = {
      ...okRun,
      completedNodeIds: ['n1'],
      nodeConditions: [
        {
          nodeId: 'n1',
          description: describeCondition({ kind: 'elementExists', target: titleInput }),
          satisfied: false,
        },
      ],
    }
    const report = await verifyWorkflowGoal(formsWorkflow(), run, probe)
    expect(report.l2.nodes[0]?.criteria[0]?.satisfied).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.reason).toContain('标题')
  })

  it('re-reads a row the run never observed', async () => {
    const report = await verifyWorkflowGoal(
      formsWorkflow(),
      { ...okRun, completedNodeIds: ['n1'] },
      goneNow,
    )
    expect(report.l2.nodes[0]?.criteria[0]?.satisfied).toBe(false)
  })
})

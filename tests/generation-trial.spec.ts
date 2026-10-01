/**
 * The pre-save trial replay (first-run-success D2).
 *
 * Two things are under test here, and the second outranks the first:
 *
 *  1. what the trial is allowed to run and what it reports — the unsafe cutoff,
 *     the record it reduces a run to, and the stage report the card shows;
 *  2. that it can NEVER cost a workflow its save: every path through the runner
 *     (opt-out, no page, a throw, a timeout, a cancel) resolves, and the graph
 *     the caller holds is either the one it passed in or that graph healed.
 *
 * A "verification" that lowered the number of workflows that get saved would
 * have made the original problem worse, so the assertions below treat a
 * rejection or a swallowed save as the failure case even before the reporting
 * is checked.
 *
 * @module tests/generation-trial
 */
import { describe, expect, it, vi } from 'vitest'
import {
  TRIAL_BUDGET_MS,
  commitCutoffNodeId,
  draftCommitCutoffNodeId,
  executionPath,
  isCommitNode,
  isDraftSaveNode,
  isUnsafeNode,
  normalizeTrialRun,
  skippedTrialRecord,
  trialCertifies,
  trialCutoffNodeId,
  trialFailed,
  trialHasNothingToProve,
  trialRecordOf,
  type TrialRunRecord,
} from '../src/lib/workflow/trial-run'
import {
  createTrialExecute,
  runGenerationTrial,
  withTrialRecord,
  type TrialExecute,
} from '../src/background/workflow-engine/repair/generation-trial'
import { independentVerifyStage } from '../src/background/workflow-engine/generation/generation-pipeline'
import type {
  ExecuteWorkflowOptions,
  ExecuteWorkflowResult,
} from '../src/background/workflow-engine/run-workflow'
import type { NodeDegradation } from '../src/lib/workflow/self-heal'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import { newId } from '../src/lib/storage'

function node(blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: newId(),
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  }
}

/** A step whose LABEL carries the prose — what a graph without `__reliability` has. */
function labeled(blockId: string, label: string, data: Record<string, unknown> = {}) {
  return { ...node(blockId, data), label }
}

/** A trigger followed by `steps`, wired as the single chain the engine walks. */
function chain(steps: WorkflowNode[], name = 'trial'): Workflow {
  const trigger = node('trigger', { type: 'manual' })
  const nodes = [trigger, ...steps]
  const edges = nodes.slice(1).map((step, index) => ({
    id: `e${index}`,
    source: nodes[index]?.id ?? '',
    target: step.id,
  }))
  return {
    id: 'wf',
    name,
    createdAt: 0,
    updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges },
  }
}

/** A read step: what the trial exists to replay. */
function readStep(selector = '#search'): WorkflowNode {
  return node('get-text', { selector, variableName: 'text' })
}

/** A step whose declared intent is a commit — the cutoff the trial obeys. */
function unsafeStep(): WorkflowNode {
  return node('event-click', {
    selector: '#pay',
    __reliability: { intent: 'submit the order' },
  })
}

/**
 * The cover-image upload of the real 小红书 graph: unsafe to the keyword test
 * because the page it uploads to is called 图文发布, and a cutoff that refuses it
 * is a replay that can never reach the draft.
 */
function uploadStep(): WorkflowNode {
  return node('upload-file', {
    selector: 'input[type="file"]',
    __reliability: { intent: '把 canvas 生成的封面图上传到图文发布的图片上传入口' },
  })
}

/**
 * The body-text fill of the same graph: a keyword hit on 发布 inside a sentence
 * whose whole point is forbidding it.
 */
function fillBodyStep(): WorkflowNode {
  return node('forms', {
    selector: '.ql-editor',
    value: '{{aiBody}}',
    __reliability: { intent: '在正文富文本编辑器填写 AI 生成的笔记正文，不点击任何发布按钮' },
  })
}

function resultOf(overrides: Partial<ExecuteWorkflowResult> = {}): ExecuteWorkflowResult {
  return { runId: 'run-1', outcome: 'ok', ...overrides }
}

function degradationOf(n: WorkflowNode, to = 'css|#pay'): NodeDegradation {
  return { nodeId: n.id, rung: 2, from: 'css|.order button', to, matchCount: 2 }
}

describe('executionPath', () => {
  it('walks the first out-edge chain and leaves the trigger out', () => {
    const a = readStep('#a')
    const b = readStep('#b')
    const wf = chain([a, b])
    expect(executionPath(wf).map((n) => n.id)).toEqual([a.id, b.id])
  })

  it('ignores nodes a hand-wired branch made unreachable from the trigger', () => {
    const a = readStep('#a')
    const branch = readStep('#branch')
    const wf = chain([a])
    wf.drawflow.nodes.push(branch)
    expect(executionPath(wf).map((n) => n.id)).toEqual([a.id])
  })

  it('stops at a cycle instead of walking forever', () => {
    const a = readStep('#a')
    const b = readStep('#b')
    const wf = chain([a, b])
    wf.drawflow.edges.push({ id: 'back', source: b.id, target: a.id })
    expect(executionPath(wf).map((n) => n.id)).toEqual([a.id, b.id])
  })
})

describe('trial cutoff', () => {
  it('is the first step that cannot be undone, never a read before it', () => {
    const submit = unsafeStep()
    const wf = chain([readStep(), node('event-click', { selector: '#more' }), submit])
    expect(trialCutoffNodeId(wf)).toBe(submit.id)
    expect(isUnsafeNode(submit)).toBe(true)
  })

  it('is undefined when the whole chain is repeat-safe', () => {
    expect(trialCutoffNodeId(chain([readStep(), node('event-click', { selector: '#next' })]))).toBe(
      undefined,
    )
  })

  it('a forms fill is not a cutoff', () => {
    // Refilling a title field is harmless, and the executor sends a fill when the
    // node carries no `action`. A graph generated for 小红书 stopped its trial at
    // exactly such a node because the contract inference had read the missing
    // verb as a submit.
    const wf = chain([
      readStep(),
      node('forms', { selector: '#title', value: 'a note title' }),
      node('event-click', { selector: '#draft' }),
    ])
    expect(trialCutoffNodeId(wf)).toBeUndefined()
  })

  it('has nothing to prove when the graph starts by committing', () => {
    const submit = unsafeStep()
    expect(trialHasNothingToProve(chain([submit, readStep()]))).toBe(true)
    expect(trialHasNothingToProve(chain([readStep(), submit]))).toBe(false)
    // No cutoff means the whole graph is safe, which is the opposite of nothing.
    expect(trialHasNothingToProve(chain([readStep()]))).toBe(false)
  })

  it('honours the cutoff the caller already chose', () => {
    // Under the commit policy this graph has no cutoff at all — and asking
    // "is there nothing to prove?" without saying so would re-derive the
    // first-unsafe one and skip a trial that has the whole graph to prove.
    const cover = uploadStep()
    const wf = chain([cover, readStep()])
    expect(trialHasNothingToProve(wf, commitCutoffNodeId(wf) ?? null)).toBe(false)
    // Saying nothing keeps the old default; a cutoff on the FIRST step is the skip.
    expect(trialHasNothingToProve(wf)).toBe(true)
    expect(trialHasNothingToProve(chain([cover]), cover.id)).toBe(true)
  })
})

describe('commit cutoff (the run-to-draft policy)', () => {
  it('lets a step that merely prepares a commit through', () => {
    // The real defect: a generated 小红书 graph is unsafe from the intent-keyword
    // test because the NAME of its page contains 发布, so the first-unsafe cutoff
    // stopped the replay in front of the cover upload and the body fill. Neither
    // commits anything, and a replay that refuses them proves nothing.
    const wf = chain([uploadStep(), fillBodyStep(), node('event-click', { selector: '#draft' })])
    expect(commitCutoffNodeId(wf)).toBeUndefined()
    expect(trialCutoffNodeId(wf)).toBe(wf.drawflow.nodes[1]!.id)
  })

  it('stops at the press of the commit control', () => {
    const publish = node('event-click', {
      selector: '#publish',
      __reliability: { intent: '点击发布按钮，把笔记发布出去' },
    })
    const wf = chain([uploadStep(), fillBodyStep(), publish, readStep()])
    expect(commitCutoffNodeId(wf)).toBe(publish.id)
    expect(isCommitNode(publish)).toBe(true)
  })

  it('stops at a submit, a send-key, a posted script and a webhook', () => {
    for (const step of [
      node('forms', { selector: '#f', action: 'submit', __reliability: { intent: '提交表单' } }),
      node('press-key', { selector: '#box', __reliability: { intent: 'press Enter to send' } }),
      node('javascript-code', { code: 'x', __reliability: { intent: 'publish the note' } }),
      node('webhook', { url: 'https://x' }),
    ]) {
      expect(commitCutoffNodeId(chain([readStep(), step]))).toBe(step.id)
    }
  })

  it('never treats a read, a navigation or a variable as a commit', () => {
    for (const step of [
      readStep(),
      node('new-tab', { url: 'https://x' }),
      node('set-variable', { variableName: 'a', value: 'b' }),
      node('get-text', { selector: '#t', variableName: 'v' }),
    ]) {
      expect(isCommitNode(step)).toBe(false)
    }
  })

  it('reads the LABEL when the step has no contract prose', () => {
    // A `click` generated without `__reliability` is repeat-safe by block id
    // alone, and everything that says it presses 发布 lives in its label. The
    // commit policy has to see it, or the one action this policy exists to
    // refuse is the one it runs.
    const publish = labeled('event-click', '点击「发布」按钮', { selector: '#publish' })
    const submit = labeled('forms', '点击发布提交表单', { selector: '#f' })
    expect(isCommitNode(publish)).toBe(true)
    expect(isCommitNode(submit)).toBe(true)
    expect(commitCutoffNodeId(chain([uploadStep(), fillBodyStep(), publish, submit]))).toBe(
      publish.id,
    )
  })

  it('reads an intent that names the commit verb, even as a prohibition', () => {
    // 「…绝不发布」 forbids the publish and the keyword test still calls the step
    // unsafe, so the commit run stops in front of it. Deliberate: the test cannot
    // tell «点击发布，不要重复» from «绝不点击发布», and the two possible mistakes are
    // not equal — stopping early is a `partial` in the report, firing the wrong
    // click publishes a note nobody approved.
    const publishish = labeled('event-click', '在图文发布页保存草稿', {
      selector: '#draft',
      __reliability: { intent: '点击「暂存草稿」按钮，把笔记留在草稿箱，绝不发布' },
    })
    expect(isCommitNode(publishish)).toBe(true)
    expect(commitCutoffNodeId(chain([fillBodyStep(), publishish]))).toBe(publishish.id)
  })

  it('does not second-guess a written intent with the label', () => {
    // The label names the PAGE («图文发布»); the intent says what the step does,
    // and the keyword test has already read it. Reading the label on top would put
    // every step on this page behind a cutoff.
    const saveDraft = labeled('event-click', '在图文发布页保存草稿', {
      selector: '#draft',
      __reliability: { intent: '点击「暂存草稿」按钮，把笔记留在草稿箱' },
    })
    expect(isCommitNode(saveDraft)).toBe(false)
    expect(commitCutoffNodeId(chain([fillBodyStep(), saveDraft, readStep()]))).toBeUndefined()
  })

  it('cannot turn a step that does not actuate into a commit', () => {
    // The label scan only decides WHETHER to look at the block id; a read whose
    // text happens to mention 发布 stays a read.
    const read = labeled('get-text', '读取发布按钮的文案', {
      selector: '#publish-btn',
      variableName: 'label',
    })
    expect(isCommitNode(read)).toBe(false)
    expect(commitCutoffNodeId(chain([read, readStep()]))).toBeUndefined()
  })

  it('judges a script by its body, not by the prose around it', () => {
    // The real graph: the step that draws three poster canvases documents why no
    // declarative operator can do it — and that justification says 「没有任何算子能
    // 新建一张画布」. The keyword test reads 新建 and calls it a commit, so a
    // draft-goal replay stopped at step 9 and could never reach the draft-save.
    // The body draws pixels and presses nothing, so the body wins.
    const canvas = node('javascript-code', {
      code: "const c = document.createElement('canvas');const x = c.getContext('2d');x.fillText('hi',0,0);return c.toDataURL('image/jpeg', 0.9);",
      description: '声明式算子无法生成并输出图片：没有任何声明式算子能新建一张画布并输出图片数据',
    })
    // The Quill work-around: dispatching an input event is how a script types
    // where the native `forms` block cannot reach — a fill, and a fill is allowed.
    const typing = node('javascript-code', {
      code: "ed.innerHTML = html;ed.dispatchEvent(new InputEvent('input', { bubbles: true }));return { done };",
      description: '只有脚本能新建一个输入事件，把 AI 正文写进 Quill 富文本编辑器',
    })
    expect(isCommitNode(canvas)).toBe(false)
    expect(isCommitNode(typing)).toBe(false)
    // The default policy still refuses every script; this loosening is only what
    // the caller that accepted the preparing side effects opted into.
    expect(trialCutoffNodeId(chain([canvas, typing]))).toBe(canvas.id)
    expect(
      commitCutoffNodeId(chain([uploadStep(), canvas, typing, fillBodyStep()])),
    ).toBeUndefined()
  })

  it('still stops at a script that presses, submits, navigates or sends', () => {
    for (const code of [
      "document.querySelector('#publish-btn').click()",
      'form.submit()',
      "el.dispatchEvent(new MouseEvent('click', { bubbles: true }))",
      "window.location = '/note/publish'",
      "location.assign('/publish')",
      "fetch('/api/publish', { method: 'POST' })",
      'navigator.sendBeacon("/hook", data)',
      "new WebSocket('wss://x')",
      // No in-page evidence at all: an unreadable body stays the commit it was.
      'x',
    ]) {
      const step = node('javascript-code', {
        code,
        __reliability: { intent: '把这篇笔记发布出去' },
      })
      expect(isCommitNode(step)).toBe(true)
      expect(commitCutoffNodeId(chain([readStep(), step]))).toBe(step.id)
    }
  })

  it('tells the commit the goal asked for from the one it forbade', () => {
    // The real graph ends on this step, and the keyword test calls it unsafe
    // because the sentence that saves the draft also names the publish it
    // declines. Splitting into clauses and dropping the forbidden ones is what
    // lets an opted-in run WRITE the draft instead of stopping in front of it.
    const saveDraft = node('event-click', {
      selector: '#draft',
      __reliability: { intent: '把已填好标题、正文与 3 张配图的图文笔记保存为草稿，不发布' },
    })
    const publish = node('event-click', {
      selector: '#publish',
      __reliability: { intent: '点击发布按钮，把笔记发布出去，不要重复点击' },
    })
    // No positive draft wording: a commit nobody can prove stays inside the
    // composer is not fired.
    const opaque = node('event-click', {
      selector: '#save',
      __reliability: { intent: '点击提交按钮，把这篇笔记保存下来' },
    })
    expect(isDraftSaveNode(saveDraft)).toBe(true)
    expect(isDraftSaveNode(publish)).toBe(false)
    expect(isDraftSaveNode(opaque)).toBe(false)
    // A step that saves AND sends is not a draft save: the prohibition only
    // excuses the verb it is attached to, and this 发布 has none.
    const both = node('event-click', {
      selector: '#both',
      __reliability: { intent: '先把笔记保存为草稿，再发布出去' },
    })
    expect(isDraftSaveNode(both)).toBe(false)
    expect(
      draftCommitCutoffNodeId(chain([uploadStep(), fillBodyStep(), saveDraft, readStep()])),
    ).toBeUndefined()
    expect(draftCommitCutoffNodeId(chain([saveDraft, publish]))).toBe(publish.id)
    expect(draftCommitCutoffNodeId(chain([fillBodyStep(), both]))).toBe(both.id)
    expect(draftCommitCutoffNodeId(chain([fillBodyStep(), opaque]))).toBe(opaque.id)
    // Both are commits — the refusals the two modes share are the same list.
    expect(isCommitNode(saveDraft)).toBe(true)
  })
})

describe('trialRecordOf', () => {
  const graph = { cutoffNodeId: 'unsafe', totalSteps: 5 }

  it('reads a clean full run as a pass', () => {
    const record = trialRecordOf({ outcome: 'ok', completedSteps: 5 }, { totalSteps: 5 })
    expect(record).toMatchObject({ outcome: 'passed', full: true, coveredSteps: 5 })
    expect(trialCertifies(record)).toBe(true)
  })

  it('reads a run that stopped at its cutoff as a partial, not a pass', () => {
    const record = trialRecordOf(
      { outcome: 'ok', stoppedBefore: 'unsafe', completedSteps: 4 },
      graph,
    )
    expect(record).toMatchObject({ outcome: 'partial', full: false, cutoffNodeId: 'unsafe' })
    expect(trialCertifies(record)).toBe(false)
  })

  it('keeps the machine-readable failure code out of prose', () => {
    const record = trialRecordOf(
      {
        outcome: 'failed',
        completedSteps: 1,
        failedNodeId: 'n2',
        error: 'READINESS_TIMEOUT(present): element never appeared',
      },
      graph,
    )
    expect(record).toMatchObject({
      outcome: 'failed',
      failedNodeId: 'n2',
      failureCode: 'READINESS_TIMEOUT(present)',
    })
    expect(trialFailed(record)).toBe(true)
  })

  it('reports the budget running out as a timeout even when the run said ok', () => {
    const record = trialRecordOf(
      { outcome: 'ok', completedSteps: 2, timedOut: true },
      { totalSteps: 5 },
    )
    expect(record.outcome).toBe('timeout')
    expect(trialCertifies(record)).toBe(false)
  })

  it('reports a caller cancel as a cancel, never as a broken graph', () => {
    const record = trialRecordOf(
      { outcome: 'cancelled', cancelledByCaller: true, completedSteps: 1 },
      { totalSteps: 5 },
    )
    expect(record.outcome).toBe('cancelled')
    expect(trialFailed(record)).toBe(false)
  })
})

describe('normalizeTrialRun', () => {
  it('rebuilds a record it can fully read', () => {
    const record: TrialRunRecord = {
      outcome: 'partial',
      at: 123,
      full: false,
      coveredSteps: 3,
      totalSteps: 5,
      runId: 'r',
      cutoffNodeId: 'n9',
      degradedSteps: 1,
    }
    expect(normalizeTrialRun(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it.each([
    ['an unknown outcome', { outcome: 'verified', at: 1 }],
    ['no timestamp', { outcome: 'passed' }],
    ['a non-numeric timestamp', { outcome: 'passed', at: 'yesterday' }],
    ['a bare string', 'passed'],
    ['null', null],
  ])('drops %s instead of trusting it', (_name, raw) => {
    expect(normalizeTrialRun(raw)).toBeUndefined()
  })

  it('keeps the `false` opt-out out of the record path', () => {
    // `false` means "never trial this workflow" and is handled by the settings
    // whitelist; as a record it is meaningless, so it must not read as one.
    expect(normalizeTrialRun(false)).toBeUndefined()
  })
})

describe('runGenerationTrial', () => {
  it('opts out without touching the page when the setting says false', async () => {
    const wf = chain([readStep()])
    wf.settings.trialRun = false
    const execute = vi.fn()
    const out = await runGenerationTrial(wf, { execute })
    expect(execute).not.toHaveBeenCalled()
    expect(out.workflow).toBe(wf)
    expect(out.record).toMatchObject({ outcome: 'skipped', reason: 'disabled by settings' })
  })

  it('skips a graph whose first step commits', async () => {
    const wf = chain([unsafeStep(), readStep()])
    const execute = vi.fn()
    const out = await runGenerationTrial(wf, { execute })
    expect(execute).not.toHaveBeenCalled()
    expect(out.workflow).toBe(wf)
    expect(out.record.outcome).toBe('skipped')
  })

  it('passes the cutoff to the run and never the step after it', async () => {
    const submit = unsafeStep()
    const wf = chain([readStep(), submit])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({
        outcome: 'ok',
        completedNodeIds: [wf.drawflow.nodes[1]!.id],
        stoppedBefore: submit.id,
      })
    })
    const out = await runGenerationTrial(wf, { execute })
    expect(seen[0]?.stopBefore).toBe(submit.id)
    expect(seen[0]?.traceEntry).toBe('VERIFY')
    expect(out.record).toMatchObject({ outcome: 'partial', coveredSteps: 1, totalSteps: 2 })
  })

  it('runs the preparing steps when the caller opted into the commit cutoff', async () => {
    // The upload and the body fill are unsafe to the keyword test and harmless to
    // replay; the publish click is the one step no replay may re-fire. Under this
    // policy the run is handed NO cutoff at all, because the graph's only unsafe
    // step is the draft save — which is what "did the workflow do its job" asks.
    const wf = chain([uploadStep(), fillBodyStep(), node('event-click', { selector: '#draft' })])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({
        outcome: 'ok',
        completedNodeIds: wf.drawflow.nodes.slice(1).map((n) => n.id),
      })
    })
    const out = await runGenerationTrial(wf, { execute, commitCutoffOnly: true })
    expect(seen[0]?.stopBefore).toBeUndefined()
    expect(out.record).toMatchObject({ outcome: 'passed', full: true, coveredSteps: 3 })
    expect(trialCertifies(out.record)).toBe(true)
  })

  it('still stops a commit-only run in front of the publish click', async () => {
    const publish = node('event-click', {
      selector: '#publish',
      __reliability: { intent: '点击发布，把笔记发布出去' },
    })
    const wf = chain([uploadStep(), fillBodyStep(), publish])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({
        outcome: 'ok',
        completedNodeIds: [wf.drawflow.nodes[1]!.id, wf.drawflow.nodes[2]!.id],
        stoppedBefore: publish.id,
      })
    })
    const out = await runGenerationTrial(wf, { execute, commitCutoffOnly: true })
    expect(seen[0]?.stopBefore).toBe(publish.id)
    expect(out.record).toMatchObject({
      outcome: 'partial',
      full: false,
      cutoffNodeId: publish.id,
      coveredSteps: 2,
    })
    expect(trialCertifies(out.record)).toBe(false)
  })

  it('runs the draft commit itself under the account-writing opt-in', async () => {
    // The whole point of the flag: `--run-to-draft` proves 17 of 18 steps and the
    // draft is still not there, because the 18th step presses 存草稿. Given the
    // opt-in, nothing is withheld — the graph has no step that is not either a
    // read, a preparation, or the draft the goal asked for.
    const saveDraft = node('event-click', {
      selector: '#draft',
      __reliability: { intent: '把填好的图文笔记保存为草稿，不发布' },
    })
    const wf = chain([uploadStep(), fillBodyStep(), saveDraft])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({
        outcome: 'ok',
        completedNodeIds: wf.drawflow.nodes.slice(1).map((n) => n.id),
      })
    })
    const out = await runGenerationTrial(wf, { execute, allowDraftCommit: true })
    expect(seen[0]?.stopBefore).toBeUndefined()
    expect(out.record).toMatchObject({ outcome: 'passed', full: true, coveredSteps: 3 })
    expect(trialCertifies(out.record)).toBe(true)
  })

  it('still stops a draft-commit run in front of a publish', async () => {
    const publish = node('event-click', {
      selector: '#publish',
      __reliability: { intent: '点击发布，把笔记发布出去' },
    })
    const wf = chain([uploadStep(), fillBodyStep(), publish])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({
        outcome: 'ok',
        completedNodeIds: [wf.drawflow.nodes[1]!.id, wf.drawflow.nodes[2]!.id],
        stoppedBefore: publish.id,
      })
    })
    const out = await runGenerationTrial(wf, { execute, allowDraftCommit: true })
    expect(seen[0]?.stopBefore).toBe(publish.id)
    expect(out.record).toMatchObject({ outcome: 'partial', cutoffNodeId: publish.id })
  })

  it('does not count the trigger as a step it proved', async () => {
    // Round 9 reported `13/12 steps` for a graph that had run everything: the
    // engine lists the trigger among the nodes that executed, the trial's
    // `totalSteps` is the chain of STEPS. One currency, or the ratio says the
    // replay covered more than the graph contains.
    const wf = chain([readStep(), uploadStep(), fillBodyStep()])
    const execute = vi.fn(async () =>
      resultOf({ outcome: 'ok', completedNodeIds: wf.drawflow.nodes.map((n) => n.id) }),
    )
    const out = await runGenerationTrial(wf, { execute })
    expect(out.record).toMatchObject({ outcome: 'passed', coveredSteps: 3, totalSteps: 3 })
  })

  it('counts a loop body once, not once per iteration', async () => {
    // `completedNodeIds` is the engine's run log: a node that ran three times is
    // in it three times. Coverage is about which steps ran.
    const wf = chain([readStep(), node('loop-elements', { selector: 'li' })])
    const loopId = wf.drawflow.nodes[2]!.id
    const execute = vi.fn(async () =>
      resultOf({
        outcome: 'ok',
        completedNodeIds: [wf.drawflow.nodes[0]!.id, wf.drawflow.nodes[1]!.id, loopId, loopId, loopId],
      }),
    )
    const out = await runGenerationTrial(wf, { execute })
    expect(out.record).toMatchObject({ coveredSteps: 2, totalSteps: 2 })
  })

  it('hands the caller the run itself, for the goal it must judge', async () => {
    // The record describes coverage; only the execution carries the variables and
    // the per-node completion the L1/L2/L3 certification is built from.
    const wf = chain([readStep()])
    const execute = vi.fn(async () =>
      resultOf({ outcome: 'ok', completedNodeIds: [wf.drawflow.nodes[1]!.id], variables: { hit: '1' } }),
    )
    const out = await runGenerationTrial(wf, { execute })
    expect(out.result).toMatchObject({ outcome: 'ok', variables: { hit: '1' } })
  })

  it('hands the run the declared inputs the caller supplied', async () => {
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf()
    })
    await runGenerationTrial(chain([readStep()]), { execute, inputs: { topic: '周末探店' } })
    expect(seen[0]?.inputs).toEqual({ topic: '周末探店' })
    // Saying nothing keeps the run exactly as it was: no inputs key, so the
    // engine seeds only from the declared defaults.
    seen.length = 0
    await runGenerationTrial(chain([readStep()]), { execute })
    expect('inputs' in (seen[0] ?? {})).toBe(false)
  })

  it('keeps the default policy at the first unsafe step, commit or not', async () => {
    // The opt-in must not quietly become the default: an upload the keyword test
    // calls unsafe still cuts the trial of a run nobody asked for.
    const cover = uploadStep()
    const wf = chain([readStep(), cover])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({ outcome: 'ok', completedNodeIds: [wf.drawflow.nodes[1]!.id] })
    })
    await runGenerationTrial(wf, { execute })
    expect(seen[0]?.stopBefore).toBe(cover.id)
  })

  it('turns a throw into a skipped trial on the SAME graph', async () => {
    const wf = chain([readStep()])
    const out = await runGenerationTrial(wf, {
      execute: vi.fn(async () => {
        throw new Error('NO_INJECTABLE_TAB')
      }),
    })
    expect(out.workflow).toBe(wf)
    expect(out.record).toMatchObject({ outcome: 'skipped' })
    expect(out.record.reason).toContain('NO_INJECTABLE_TAB')
  })

  it('records a failed run as a failed trial and still returns the graph', async () => {
    const wf = chain([readStep(), node('event-click', { selector: '#go' })])
    const out = await runGenerationTrial(wf, {
      execute: vi.fn(async () =>
        resultOf({
          outcome: 'failed',
          error: 'LOCATOR_NOT_FOUND: #go',
          completedNodeIds: [wf.drawflow.nodes[1]!.id],
          trace: { failedNodeId: wf.drawflow.nodes[2]!.id } as never,
        }),
      ),
    })
    expect(out.record).toMatchObject({
      outcome: 'failed',
      failedNodeId: wf.drawflow.nodes[2]!.id,
      failureCode: 'LOCATOR_NOT_FOUND',
      coveredSteps: 1,
    })
  })

  it('writes a degraded step back into the graph it returns', async () => {
    const click = node('event-click', { selector: '.order button' })
    const wf = chain([click])
    const out = await runGenerationTrial(wf, {
      execute: vi.fn(async () =>
        resultOf({
          outcome: 'ok',
          completedNodeIds: [wf.drawflow.nodes[1]!.id, click.id],
          degradations: [degradationOf(click)],
        }),
      ),
    })
    expect(out.record.degradedSteps).toBe(1)
    const healed = out.workflow.drawflow.nodes.find((n) => n.id === click.id)!
    expect(healed.data['selector']).toBe('#pay')
    expect(healed.data['__resolution']).toMatchObject({ rung: 2, to: 'css|#pay' })
    // The caller's graph is never mutated in place: the save writes the copy.
    expect(wf.drawflow.nodes.find((n) => n.id === click.id)!.data['selector']).toBe('.order button')
  })

  it('records a timeout when the budget runs out', async () => {
    const wf = chain([readStep()])
    const out = await runGenerationTrial(wf, {
      budgetMs: 5,
      execute: (_workflow, options) =>
        new Promise<ExecuteWorkflowResult>((resolve) => {
          options.signal.addEventListener(
            'abort',
            () => resolve(resultOf({ outcome: 'cancelled' })),
            {
              once: true,
            },
          )
        }),
    })
    expect(out.record.outcome).toBe('timeout')
    expect(out.workflow).toBe(wf)
  })

  it('stops the run when the caller cancels', async () => {
    const wf = chain([readStep()])
    const controller = new AbortController()
    const pending = runGenerationTrial(wf, {
      budgetMs: TRIAL_BUDGET_MS,
      signal: controller.signal,
      execute: (_workflow, options) =>
        new Promise<ExecuteWorkflowResult>((resolve) => {
          options.signal.addEventListener(
            'abort',
            () => resolve(resultOf({ outcome: 'cancelled' })),
            {
              once: true,
            },
          )
        }),
    })
    controller.abort()
    const out = await pending
    expect(out.record.outcome).toBe('cancelled')
  })

  it('never rejects, whatever the run primitive does', async () => {
    const wf = chain([readStep()])
    const failures: TrialExecute[] = [
      () => {
        throw new Error('boom')
      },
      async () => {
        throw new Error('async boom')
      },
    ]
    for (const execute of failures) {
      await expect(runGenerationTrial(wf, { execute })).resolves.toMatchObject({
        record: { outcome: 'skipped' },
      })
    }
  })
})

describe('createTrialExecute', () => {
  it('runs the graph as a verification run, with no AI takeover', async () => {
    const executeWorkflow = vi.fn(
      async (
        _workflow: Workflow,
        _options: ExecuteWorkflowOptions,
      ): Promise<ExecuteWorkflowResult> => resultOf(),
    )
    const execute = createTrialExecute({ executeWorkflow, scopeWindowId: 7 })
    const wf = chain([readStep()])
    await execute(wf, {
      stopBefore: 'n9',
      signal: new AbortController().signal,
      traceEntry: 'VERIFY',
    })
    expect(executeWorkflow).toHaveBeenCalledWith(wf, {
      source: 'manual',
      traceEntry: 'VERIFY',
      scopeWindowId: 7,
      stopBefore: 'n9',
      signal: expect.any(AbortSignal),
    })
    // The trial proves the GRAPH, so a model that fixes a step mid-run would
    // prove nothing: takeover is never passed.
    expect(executeWorkflow.mock.calls[0]![1].aiTakeover).toBeUndefined()
  })

  it('seeds the run with the inputs the caller supplied', async () => {
    // A generated graph that references {{topic}} is PARAMETERISED, and the
    // panel asks a human for the value when Run is clicked. An unattended replay
    // has nobody to ask — without this the step fails UNRESOLVED_INPUT and the
    // repair loop walks its budget over a caller argument nobody supplied.
    const executeWorkflow = vi.fn(
      async (
        _workflow: Workflow,
        _options: ExecuteWorkflowOptions,
      ): Promise<ExecuteWorkflowResult> => resultOf(),
    )
    const execute = createTrialExecute({ executeWorkflow, scopeWindowId: 7 })
    await execute(chain([readStep()]), {
      signal: new AbortController().signal,
      traceEntry: 'VERIFY',
      inputs: { topic: '周末探店' },
    })
    expect(executeWorkflow.mock.calls[0]![1]).toMatchObject({ variables: { topic: '周末探店' } })
  })
})

describe('independentVerifyStage', () => {
  it('stays pending when no trial ran', () => {
    expect(independentVerifyStage()).toMatchObject({
      stage: 'INDEPENDENT_VERIFY',
      status: 'pending',
    })
  })

  it('reports the coverage the trial actually proved', () => {
    expect(
      independentVerifyStage({
        outcome: 'partial',
        at: 1,
        full: false,
        coveredSteps: 3,
        totalSteps: 4,
      }),
    ).toMatchObject({ status: 'ok', counts: { coveredSteps: 3, totalSteps: 4 } })
  })

  it('never reports a failure as anything but a warning', () => {
    const stage = independentVerifyStage({
      outcome: 'failed',
      at: 1,
      full: false,
      coveredSteps: 1,
      totalSteps: 3,
      failureCode: 'LOCATOR_NOT_FOUND',
    })
    expect(stage.status).toBe('warn')
    expect(stage.summary).toContain('LOCATOR_NOT_FOUND')
  })

  it('leaves a skipped trial pending rather than dressing it up', () => {
    expect(independentVerifyStage(skippedTrialRecord('no page'))).toMatchObject({
      status: 'pending',
    })
  })
})

describe('withTrialRecord', () => {
  it('returns a new workflow and leaves the stored one alone', () => {
    const wf = chain([readStep()])
    const record: TrialRunRecord = {
      outcome: 'passed',
      at: 1,
      full: true,
      coveredSteps: 1,
      totalSteps: 1,
    }
    const next = withTrialRecord(wf, record)
    expect(next).not.toBe(wf)
    expect(next.settings.trialRun).toMatchObject({ outcome: 'passed' })
    expect(wf.settings.trialRun).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  commitCutoffNodeId,
  draftCommitCutoffNodeId,
  draftSaveExecuted,
  draftGoalGapNotice,
  isCommitNode,
  isDraftSaveNode,
  unfiredDraftSaveNotice,
  unvisitedDraftListNotice,
} from '../src/lib/workflow/trial-run'
import { intentOf } from '../src/lib/workflow/reliability'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

/**
 * Chat-generated steps are labeled with their BLOCK ID (`appendOperatorNode`), so
 * the only prose a generated graph carries is the goal contract the generation
 * session wrote onto each node. These tests pin the reading that makes the commit
 * policy see it: without it a generated 「点击发布」 is indistinguishable from a
 * generated 「点击暂存草稿」, which is both a safety hole and the reason a replay
 * that did save a draft could never report `draftSaved`.
 */
const generated = (id: string, goal: string): WorkflowNode => ({
  id,
  label: 'event-click',
  position: { x: 0, y: 0 },
  data: {
    blockId: 'event-click',
    selector: `#${id}`,
    __workflowAi: {
      goalContract: { version: 1, goal, successCriteria: [{ kind: 'variableExists', name: `done:${id}` }] },
    },
  },
})

const graphOf = (...nodes: WorkflowNode[]): Workflow =>
  ({
    id: 'wf-prose',
    name: 'generated graph',
    drawflow: {
      nodes,
      edges: nodes.slice(1).map((node, i) => ({
        id: `e${i}`,
        source: nodes[i]!.id,
        target: node.id,
        sourceHandle: 'event-click-output-1',
        targetHandle: 'event-click-input-1',
      })),
    },
  }) as unknown as Workflow

describe('intentOf reads a generated node’s own goal contract', () => {
  it('uses the contract when the node has no intent and no description', () => {
    expect(intentOf(generated('save', '点击「暂存草稿」按钮，把笔记保存为草稿'))).toBe(
      '点击「暂存草稿」按钮，把笔记保存为草稿',
    )
  })

  it('keeps an explicit description ahead of the contract', () => {
    const node = generated('save', '合同里的话')
    node.data['description'] = '点击「保存为草稿」，不要发布'
    expect(intentOf(node)).toBe('点击「保存为草稿」，不要发布')
  })

  it('stays empty for a node with no prose at all', () => {
    expect(intentOf({ id: 'x', label: 'event-click', position: { x: 0, y: 0 }, data: { blockId: 'event-click' } } as WorkflowNode)).toBe('')
  })
})

describe('the commit policy judges a generated click by what it said it does', () => {
  const save = generated('save', '点击「暂存草稿」按钮，把笔记保存为草稿')
  const publish = generated('publish', '点击「发布」按钮，把笔记发布出去')

  it('recognizes the draft-shaped commit', () => {
    expect(isDraftSaveNode(save)).toBe(true)
  })

  it('refuses the publish commit, and stops the run there', () => {
    expect(isCommitNode(publish)).toBe(true)
    expect(isDraftSaveNode(publish)).toBe(false)
    const graph = graphOf(generated('n1', '在编辑器里填写标题'), publish)
    expect(draftCommitCutoffNodeId(graph)).toBe('publish')
    expect(draftSaveExecuted(graph, 'publish')).toBe(false)
  })

  it('does not mistake the page a step stands on for the act it performs', () => {
    const onPublishPage = generated('upload', '在图文发布页点击上传入口，选择本地封面图')
    expect(isCommitNode(onPublishPage)).toBe(false)
    expect(commitCutoffNodeId(graphOf(generated('n1', '打开笔记编辑器'), onPublishPage))).toBeUndefined()
  })

  it('refuses a step that names the publish even to decline it, and admits it only on the opt-in', () => {
    const declines = generated('decline', '点击「暂存草稿」按钮，把笔记留在草稿箱，绝不发布')
    // Naming a publish is still a refusal by default — declining it is not evidence
    // the step can be re-fired — but its own words do name a draft, which is what
    // the caller's `allowDraftCommit` grants.
    expect(isCommitNode(declines)).toBe(true)
    expect(isDraftSaveNode(declines)).toBe(true)
    const graph = graphOf(generated('n1', '打开笔记编辑器'), declines)
    expect(commitCutoffNodeId(graph)).toBe('decline')
    expect(draftCommitCutoffNodeId(graph)).toBeUndefined()
    expect(draftSaveExecuted(graph, null)).toBe(true)
  })

  it('proves the draft when the run reached past its save step', () => {
    const graph = graphOf(generated('n1', '打开笔记编辑器'), save)
    expect(draftSaveExecuted(graph, null)).toBe(true)
  })

  it('lets a prose-less graph through exactly as it always was', () => {
    const blank = { id: 'b', label: 'event-click', position: { x: 0, y: 0 }, data: { blockId: 'event-click' } } as WorkflowNode
    expect(isCommitNode(blank)).toBe(false)
    expect(isDraftSaveNode(blank)).toBe(false)
  })
})

/**
 * The two cutoff policies ask different questions, and the difference is the whole
 * point: the default refuses anything that COULD be irreversible, while
 * `--allow-draft-commit` refuses only the acts that take the work OUT of the
 * composer. Once a generated node's prose became readable, the broad keyword list
 * stopped matching only publishes and began matching 「新建图文笔记」 — which would
 * have cut an opt-in round off at its FIRST click, i.e. a proof that proved nothing.
 */
describe('the draft-commit opt-in walks to the draft and stops at the publish', () => {
  const road = () =>
    graphOf(
      generated('open', '打开笔记编辑器'),
      generated('create', '点击「新建图文笔记」，进入图文模式'),
      generated('tab', '切换到「图文」标签页'),
      generated('upload', '点击「一键上传图片」，选择三张本地图片'),
      generated('title', '在标题输入框里填写 {{aiTitle}}'),
      generated('save', '点击「暂存草稿」按钮，把笔记保存为草稿'),
      generated('publish', '点击「发布」按钮，把笔记发布出去'),
    )

  it('still refuses a generated step that merely creates something, by default', () => {
    // 创建/新建 qualify as possibly irreversible, and a human watching a replay pays
    // nothing for an extra stop — so the default cutoff did not move.
    expect(commitCutoffNodeId(road())).toBe('create')
  })

  it('runs every step up to the draft under the opt-in and refuses the publish', () => {
    const graph = road()
    expect(draftCommitCutoffNodeId(graph)).toBe('publish')
    expect(draftSaveExecuted(graph, 'publish')).toBe(true)
  })

  it('does not read a draft that is only a location as a saved draft', () => {
    // On the way to a draft you delete a duplicate cover image from the draft list;
    // that mentions 草稿 without keeping anything, and would otherwise certify the
    // goal from a step that wrote no draft.
    const deleteDup = generated('delete', '在草稿列表里点击删除多余的封面图')
    expect(isDraftSaveNode(deleteDup)).toBe(false)
    const graph = graphOf(generated('open', '打开笔记编辑器'), deleteDup)
    expect(commitCutoffNodeId(graph)).toBe('delete')
    expect(draftCommitCutoffNodeId(graph)).toBeUndefined()
  })

  it('refuses an outward act that is not a click', () => {
    const fills = {
      id: 'fill',
      label: 'forms',
      position: { x: 0, y: 0 },
      data: { blockId: 'forms', action: 'fill', selector: '#title', value: '{{aiTitle}}' },
    } as WorkflowNode
    const submits = { ...fills, id: 'submit', data: { ...fills.data, action: 'submit' } } as WorkflowNode
    const graph = graphOf(generated('save', '点击「暂存草稿」按钮，把笔记保存为草稿'), fills, submits)
    expect(draftCommitCutoffNodeId(graph)).toBe('submit')
  })
})

/**
 * Round 30 generated the graph the goal asked for — 18 nodes ending on
 * 「点击「暂存离开」…保存为草稿，不执行正式发布」, with grounded goal rows — and the
 * harness reported 「no node in the graph saves one」 and skipped the replay. The
 * negation test only recognized 「不发布」; a prohibition written with a light verb
 * and an adverb in between matched nothing, so declining the publish read as
 * naming it, and naming it read as doing it.
 */
describe('a prohibition still declines the publish when it is worded in full', () => {
  const declined = (goal: string) => generated('save', goal)

  it('recognizes the round-30 sentence as the draft save it is', () => {
    const node = declined('点击「暂存离开」把已填好标题、正文并配好3张图的图文笔记保存为草稿，不执行正式发布')
    expect(isDraftSaveNode(node)).toBe(true)
    const graph = graphOf(generated('title', '在标题输入框里填写 {{noteTitle}}'), node)
    expect(draftCommitCutoffNodeId(graph)).toBeUndefined()
    expect(draftSaveExecuted(graph, null)).toBe(true)
  })

  it('reads the other ways a model declines it', () => {
    for (const goal of [
      '把笔记保存为草稿，不会正式发布',
      '点击暂存离开，保存草稿，不进行发布',
      'save the note as a draft, without actually publishing',
    ]) {
      expect(isDraftSaveNode(declined(goal)), goal).toBe(true)
    }
  })

  it('still stops at a publish that merely carries a warning', () => {
    // The window is clause-local: 「不要」 here forbids undoing, not publishing, so the
    // publish verb has to survive the strip and stay a refusal.
    const note = generated('publishNote', '点击发布按钮提交笔记，不要撤销')
    expect(isDraftSaveNode(note)).toBe(false)
    const graph = graphOf(generated('save', '点击「暂存草稿」按钮，把笔记保存为草稿'), note)
    expect(draftCommitCutoffNodeId(graph)).toBe('publishNote')
    expect(draftSaveExecuted(graph, 'publishNote')).toBe(true)
  })
})

describe('the draft commit a real generation session wrote', () => {
  /** Round 30/31's terminal node, verbatim off the stored graph. */
  const tmpLeave = {
    id: 'muqdfmq3-rtrqknj8',
    label: 'event-click',
    position: { x: 0, y: 0 },
    data: {
      __reliability: {
        readiness: { before: [{ state: 'present' }, { state: 'visible' }, { state: 'enabled' }] },
      },
      __workflowAi: {
        goalContract: {
          goal: 'Click the target element',
          successCriteria: [{ kind: 'elementExists', target: { label: '暂存离开' } }],
          version: 1,
        },
      },
      blockId: 'event-click',
      description: '点击「暂存离开」把已填好标题、正文并配好3张图的图文笔记保存为草稿，不执行正式发布',
      label: '暂存离开（保存草稿）按钮',
      target: {
        fallbacks: [],
        label: '暂存离开',
        primary: {
          closedShadow: true,
          how: 'cdp-shadow',
          role: 'button',
          shadowHosts: ['xhs-publish-btn'],
          tag: 'button',
          value: '暂存离开',
        },
      },
    },
  } as unknown as WorkflowNode

  it('is reachable, not refused, under the draft opt-in', () => {
    // This sentence is the whole reason the strip exists: it names the publish it
    // declines, and under the old reading 「发布」 survived the strip, the node was
    // classed outward, and `--allow-draft-commit` stopped in front of the only
    // step the goal asked for — 6/17 steps, no draft, and a graph the harness
    // reported as having no draft-save step at all.
    const graph = graphOf(generated('open', '打开小红书创作服务平台的图文发布页'), tmpLeave)
    expect(isDraftSaveNode(tmpLeave)).toBe(true)
    expect(draftCommitCutoffNodeId(graph)).toBeUndefined()
    expect(draftSaveExecuted(graph, null)).toBe(true)
  })

  it('stays refused under the default policy', () => {
    const graph = graphOf(generated('open', '打开图文发布页'), tmpLeave)
    expect(commitCutoffNodeId(graph)).toBe('muqdfmq3-rtrqknj8')
  })
})

describe('the recording tool tells the model its terminal step is still missing', () => {
  const goal = '结合这个项目的readme文档，去小红书上生成推广文章，要求使用图文模式，使用脚本生成3张图片，保存成草稿'

  it('fires while no step saves the draft', () => {
    // Round 37's real graph: 21 recorded steps ending on a focus click, and the
    // only sentence mentioning 保存草稿 belongs to a tab switch.
    const nodes = [
      generated('open', '打开小红书创作服务平台标签页'),
      {
        id: 'switch',
        label: 'switch-tab',
        position: { x: 0, y: 0 },
        data: {
          blockId: 'switch-tab',
          __workflowAi: {
            goalContract: {
              version: 1,
              goal: '切回小红书创作服务平台标签页，填写正文并保存草稿',
              successCriteria: [{ kind: 'variableExists', name: 'done:switch' }],
            },
          },
        },
      } as unknown as WorkflowNode,
      generated('focus', '点击正文编辑区，使其获得焦点以便输入正文'),
    ]
    const notice = unfiredDraftSaveNotice({ nodes, goalText: goal })
    expect(notice).toContain('草稿')
    expect(notice).toContain('最后一步')
  })

  it('stops the moment the save click is recorded', () => {
    const nodes = [
      generated('focus', '点击正文编辑区，使其获得焦点以便输入正文'),
      generated('save', '点击「暂存离开」按钮，把笔记保存为草稿，不执行正式发布'),
    ]
    expect(unfiredDraftSaveNotice({ nodes, goalText: goal })).toBe('')
  })

  it('says nothing to a goal that never asked for a draft', () => {
    expect(
      unfiredDraftSaveNotice({
        nodes: [generated('read', '读取草稿箱里的笔记数量')],
        goalText: '读取草稿箱数量并汇报',
      }),
    ).toBe('')
  })

  it('reads the goal off the trigger head when the draft field is empty', () => {
    // Round 38's silence: the model never passed goalText on the trigger call, so
    // `draft.goalText` was empty and the notice never fired — while compose, which
    // falls back to the head node's own goalText, had the goal the whole time.
    const head = {
      id: 't',
      label: 'trigger',
      position: { x: 0, y: 0 },
      data: { blockId: 'trigger', goalText: '去小红书生成推广文章，保存成草稿' },
    } as unknown as WorkflowNode
    expect(unfiredDraftSaveNotice({ nodes: [head, generated('focus', '点击正文编辑区')] })).toContain('草稿')
  })
})

describe('a saved draft still needs a step that looks at it', () => {
  const goal = '结合这个项目的readme文档，去小红书上生成推广文章，要求使用图文模式，使用脚本生成3张图片，保存成草稿'
  const save = () => generated('save', '点击「暂存离开」按钮，把笔记保存为草稿，不执行正式发布')

  it('fires once the save is recorded and nothing visits the draft list', () => {
    // Round 80's graph exactly: 18/18, a real draft, and the only success row the
    // sealed goal had quoted the publish page's own 「保存草稿」 — furniture. The
    // certification layer is right to refuse it; what was missing was a step.
    const notice = unvisitedDraftListNotice({ nodes: [generated('focus', '点击正文编辑区'), save()], goalText: goal })
    expect(notice).toContain('草稿箱')
    expect(notice).toContain('补两步')
    // The visit alone is not the fix: a 草稿箱 that was already in the page's own
    // navigation is furniture too, and a row aimed at a locator no step recorded is
    // no evidence, so the notice asks for the read step and the row shape together.
    expect(notice).toContain('countIncreased')
    expect(notice).toContain('等待或读取')
  })

  it('stops when a step AFTER the save opens the draft list', () => {
    expect(
      unvisitedDraftListNotice({
        nodes: [save(), generated('drafts', '点击「草稿箱」，查看刚保存的草稿笔记')],
        goalText: goal,
      }),
    ).toBe('')
  })

  it('a visit BEFORE the save proves nothing about the draft it has not written yet', () => {
    const notice = unvisitedDraftListNotice({
      nodes: [generated('drafts', '点击「草稿箱」查看草稿列表'), generated('focus', '点击正文编辑区'), save()],
      goalText: goal,
    })
    expect(notice).toContain('草稿箱')
  })

  it('stays silent while the save itself is still missing, and the gap notice names one hole', () => {
    // The two notices are a queue, not a chorus: a reader gets the next missing
    // step, never two instructions at once.
    const noSave = [generated('focus', '点击正文编辑区')]
    expect(unvisitedDraftListNotice({ nodes: noSave, goalText: goal })).toBe('')
    expect(draftGoalGapNotice({ nodes: noSave, goalText: goal })).toContain('最后一步')
    expect(draftGoalGapNotice({ nodes: [save()], goalText: goal })).toContain('草稿箱')
    expect(draftGoalGapNotice({ nodes: [save(), generated('drafts', '打开草稿列表')], goalText: goal })).toBe('')
  })
})

describe('the words on the pressed element speak for a prose-less click', () => {
  /**
   * Round 43's terminal step. The live operator path records what it clicked in
   * the locator (`data.label`, the target specs) and gives the node a machine
   * label; no goal contract was written. Reading only the sentence used to call
   * this step prose-less — the graph that really saved a draft was reported as
   * having no save step, and a 「发布」 button would have read the same way.
   */
  const pressed = (
    id: string,
    words: { label?: string; text?: string; accessibleName?: string },
  ): WorkflowNode => ({
    id,
    label: 'Click the target element',
    position: { x: 0, y: 0 },
    data: {
      blockId: 'event-click',
      selector: '#pressed',
      ...(words.label ? { label: words.label } : {}),
      ...(words.text || words.accessibleName
        ? {
            target: {
              primary: { how: 'text', value: words.text ?? '' },
              fallbacks: words.accessibleName
                ? [{ how: 'role', value: words.accessibleName, role: 'button' }]
                : [],
            },
            __reliability: { locator: { role: 'button', accessibleName: words.accessibleName } },
          }
        : {}),
    },
  })

  it('credits the draft save the button itself names', () => {
    expect(isDraftSaveNode(pressed('save', { label: '点击暂存离开按钮保存草稿' }))).toBe(true)
    expect(isDraftSaveNode(pressed('save-text', { text: '暂存离开' }))).toBe(true)
    expect(isDraftSaveNode(pressed('save-aria', { accessibleName: '存草稿' }))).toBe(true)
    expect(draftSaveExecuted(graphOf(pressed('save', { text: '暂存离开' })))).toBe(true)
  })

  it('refuses the publish the button names, and stops the draft run in front of it', () => {
    const publish = pressed('publish', { label: '点击发布按钮', text: '发布' })
    expect(isDraftSaveNode(publish)).toBe(false)
    expect(draftCommitCutoffNodeId(graphOf(publish))).toBe('publish')
  })

  it('does not fire the re-ask notice once that click is recorded', () => {
    const nodes = [
      generated('focus', '点击正文编辑区'),
      pressed('save', { label: '点击暂存离开按钮保存草稿', text: '暂存离开' }),
    ]
    expect(unfiredDraftSaveNotice({ nodes, goalText: '去小红书生成推广文章，保存成草稿' })).toBe('')
    // The same draft one step earlier — the save not yet pressed — still asks.
    expect(unfiredDraftSaveNotice({ nodes: nodes.slice(0, 1), goalText: '保存成草稿' })).toContain('草稿')
  })

  it('does not take the block boilerplate for a declaration', () => {
    // Round 45 recorded its 「暂存离开」 click and sealed the step with the block's own
    // template sentence («Click the target element»). A policy that reads the template
    // as the declaration finds no draft save, so the bridge spent a whole extra turn
    // re-asking for a click the graph already had.
    const save = pressed('save', { label: '点击暂存离开按钮保存草稿', text: '暂存离开' })
    const node: WorkflowNode = {
      ...save,
      data: { ...save.data, ...generated('save', 'Click the target element').data },
    }
    expect(isDraftSaveNode(node)).toBe(true)
    expect(unfiredDraftSaveNotice({ nodes: [node], goalText: '去小红书生成推广文章，保存成草稿' })).toBe('')
  })

  it('still needs a step that ACTS: a fill that mentions the draft saves nothing', () => {
    const fill: WorkflowNode = {
      id: 'fill',
      label: 'Fill the form field',
      position: { x: 0, y: 0 },
      data: { blockId: 'forms', action: 'fill', label: '输入标题，稍后保存为草稿' },
    }
    expect(isDraftSaveNode(fill)).toBe(true)
    expect(unfiredDraftSaveNotice({ nodes: [fill], goalText: '保存成草稿' })).toContain('草稿')
  })

  it('ignores a locator value: an id that happens to read "draft" is not a label', () => {
    const node: WorkflowNode = {
      id: 'odd',
      label: 'Click the target element',
      position: { x: 0, y: 0 },
      data: {
        blockId: 'event-click',
        target: { primary: { how: 'id', value: 'draft-save-button' }, fallbacks: [] },
      },
    }
    expect(isDraftSaveNode(node)).toBe(false)
  })
})

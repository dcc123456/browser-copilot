import { describe, expect, it } from 'vitest'
import { ungroundedGoalConditions } from '../src/lib/workflow/selector-probe'
import type { Workflow } from '../src/lib/workflow/types'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'
import { conditionTargetIsNamed } from '../src/lib/workflow/conditions'

/**
 * Round 26 replayed 18/18 steps, saved the draft (the browser's own 草稿箱 shows
 * it), and still reported `L3 failed … 元素不存在` — the goal row asked for
 * `.publishBtn, .btn.submit, [class*='submit']`, and 小红书's publish footer is
 * `publish-video / btn-wrapper / btn-text`. The check was unsatisfiable the
 * moment it was written, so the report blamed the run for the contract's guess.
 */
function graphWith(
  nodeSelectors: string[],
  conditions: { success?: WorkflowCondition[]; terminal?: WorkflowCondition[] },
): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: nodeSelectors.map((selector, index) => ({
        id: `n${index}`,
        label: 'event-click',
        position: { x: 0, y: 0 },
        data: { blockId: 'event-click', selector },
      })),
      edges: [],
      position: { x: 0, y: 0 },
      zoom: 1,
    },
    trigger: { type: 'manual', enabled: true },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      goalSpec: {
        summary: '在小红书生成图文推广笔记并保存草稿',
        successConditions: conditions.success ?? [],
        ...(conditions.terminal ? { terminalStateConditions: conditions.terminal } : {}),
      },
    },
  } as Workflow
}

describe('a goal row is only as checkable as the evidence behind its locator', () => {
  it('names a selector no step of the graph uses', () => {
    const lines = ungroundedGoalConditions(
      graphWith(['[contenteditable="true"]', 'input[type="file"]'], {
        success: [
          { kind: 'urlContains', value: 'xiaohongshu.com' },
          {
            kind: 'elementExists',
            target: { selector: ".publishBtn, .btn.submit, [class*='submit']" },
          },
        ],
      }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('.publishBtn')
    expect(lines[0]).toContain('no step of the graph')
  })

  it('names an invented selector on a differential row too', () => {
    // The row the draft-list notice asks the model to write: 「草稿列表数量增加」 on the
    // note rows, aimed from a step that clicked the 草稿箱 navigation and never
    // recorded the list's own selector. Such a row cannot pass even when the draft
    // really landed, and nothing said the reason.
    const lines = ungroundedGoalConditions(
      graphWith(['a.drafts-nav'], {
        success: [{ kind: 'countIncreased', target: { selector: '.note-item' } }],
      }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('.note-item')
    expect(
      ungroundedGoalConditions(
        graphWith(['.note-item'], {
          success: [{ kind: 'countIncreased', target: { selector: '.note-item' } }],
        }),
      ),
    ).toEqual([])
  })

  it('leaves a row whose locator a step really acted on alone', () => {
    expect(
      ungroundedGoalConditions(
        graphWith(['input[placeholder="填写标题会有更多赞哦"]'], {
          success: [
            {
              kind: 'elementExists',
              target: { selector: 'input[placeholder="填写标题会有更多赞哦"]' },
            },
          ],
        }),
      ),
    ).toEqual([])
  })

  it('leaves a row that identifies the element without a selector alone', () => {
    expect(
      ungroundedGoalConditions(
        graphWith([], {
          success: [
            { kind: 'elementVisible', target: { role: 'button', accessibleName: '暂存离开' } },
          ],
        }),
      ),
    ).toEqual([])
  })

  it('reads terminal-state rows too, and never the URL ones', () => {
    const lines = ungroundedGoalConditions(
      graphWith([], {
        success: [{ kind: 'variableExists', name: 'noteTitle' }],
        terminal: [
          { kind: 'urlContains', value: '/publish' },
          { kind: 'count', target: { selector: '.draft-item' }, op: 'gte', value: 1 },
        ],
      }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('.draft-item')
  })

  it('reads an invented test id the way it reads an invented class', () => {
    // Round 43 replayed its whole graph, saved the draft, and still failed L3 on
    // `[data-testid] draft-saved` — a hook 小红书 does not have. A test id names an
    // element by its source code just like a CSS class does, so it is a guess until a
    // step proves the page carries it.
    expect(
      ungroundedGoalConditions(
        graphWith([], {
          success: [
            {
              kind: 'elementText',
              target: { testId: 'draft-saved' },
              expected: '草稿',
              match: 'contains',
            },
          ],
        }),
      ),
    ).toEqual([expect.stringContaining('draft-saved')])
  })

  it('leaves a test id that a step of the graph really used alone', () => {
    expect(
      ungroundedGoalConditions(
        graphWith(['[data-testid="draft-saved"]'], {
          success: [
            {
              kind: 'elementText',
              target: { testId: 'draft-saved' },
              expected: '草稿',
              match: 'contains',
            },
          ],
        }),
      ),
    ).toEqual([])
  })
})

/**
 * What the goal contract may be SEALED with (the `prepare_workflow_goal` refusal
 * reads this). Rounds 26, 43 and 44 all replayed cleanly and then failed their own
 * goal on a locator the model invented — `.publishBtn`, testid `draft-saved`,
 * `.publish-container, .draft-list, .note-item` — while the single L3 pass (round
 * 34) rested on `{text: "草稿箱"}`, which a person can see.
 */
describe('a goal row must name its element in the words on the page', () => {
  it('accepts visible words, and the shapes an observation produced', () => {
    expect(conditionTargetIsNamed({ kind: 'elementExists', target: { text: '草稿箱' } })).toBe(true)
    expect(
      conditionTargetIsNamed({
        kind: 'elementVisible',
        target: { selector: '.btn', accessibleName: '暂存离开' },
      }),
    ).toBe(true)
    expect(
      conditionTargetIsNamed({
        kind: 'elementExists',
        target: { primary: { how: 'text', value: '草稿箱' }, fallbacks: [] },
      }),
    ).toBe(true)
    expect(conditionTargetIsNamed({ kind: 'variableExists', name: 'noteTitle' })).toBe(true)
  })

  it('refuses a row that identifies its element only by source code', () => {
    expect(
      conditionTargetIsNamed({ kind: 'elementExists', target: { selector: '.publish-container' } }),
    ).toBe(false)
    expect(
      conditionTargetIsNamed({
        kind: 'elementText',
        target: { testId: 'draft-saved' },
        expected: '草稿',
        match: 'contains',
      }),
    ).toBe(false)
  })
})

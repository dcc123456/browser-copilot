/**
 * A cleanup step with nothing to clean up is a step that worked.
 *
 * Round 31 died at step 7 of 17 on `READINESS_TIMEOUT(visible)`. The node was
 * 「关闭右侧「草稿箱」抽屉」 — the exploratory agent had pulled that drawer OUT while
 * browsing, clicked its close button, and the harness recorded the cleanup as a
 * required step. On a clean replay the drawer is never opened, so its close
 * control stays hidden forever, the gate polls 8 s (×3 with the node's retry
 * policy), and a graph that was about to upload three images and save a draft
 * fails as if the page were broken.
 *
 * The skip is safe rather than lenient: the step's own success state is "this
 * overlay is not on the page", which holds exactly as hard when nothing opened
 * it. The engine therefore continues, and the run says so.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import { isDismissStep } from '../src/lib/workflow/reliability'
import type { ReadinessProbe } from '../src/background/workflow-engine/readiness-engine'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

/** Round 31's node, verbatim off the stored graph. */
const DRAWER_CLOSE_SELECTOR =
  '.creator-drawer-close, .note-drawer-close, [class*="drawer"] [class*="close"], [class*="close"]'

function clickNode(id: string, data: Record<string, unknown>): WorkflowNode {
  return {
    id,
    label: 'event-click',
    position: { x: 0, y: 0 },
    data: {
      blockId: 'event-click',
      selector: DRAWER_CLOSE_SELECTOR,
      __reliability: {
        // `present` holds and `visible` never does: the button is in the DOM,
        // the drawer it belongs to is closed.
        readiness: {
          before: [{ state: 'present' }, { state: 'visible' }],
          timeoutMs: 30,
        },
      },
      ...data,
    },
  }
}

function graph(first: WorkflowNode, second: WorkflowNode): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: [first, second],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      reliabilityMode: 'generated-strict',
    },
  }
}

/** Satisfies `present`, refuses everything else — a hidden control. */
const hiddenControl: ReadinessProbe = async (requirement) => ({
  satisfied: requirement.state === 'present',
  detail: '元素尚未可见',
})

const upload = (): WorkflowNode => ({
  id: 'b',
  label: 'upload-file',
  position: { x: 0, y: 0 },
  data: { blockId: 'upload-file', selector: "input[type='file']", variables: { img1: 'data:,' } },
})

describe('the dismissal skip', () => {
  it('continues past a drawer close whose drawer was never opened', async () => {
    const ran: string[] = []
    const executors = {
      'event-click': async () => {
        ran.push('click')
        return null
      },
      'upload-file': async () => {
        ran.push('upload')
        return null
      },
    }
    const result = await runWorkflow(
      graph(
        clickNode('a', {
          description: '关闭右侧「草稿箱」抽屉，露出图文发布页的上传区',
        }),
        upload(),
      ),
      { executors, readinessProbe: hiddenControl },
    )
    expect(result.outcome).toBe('ok')
    expect(ran).toEqual(['upload'])
    expect(result.completedNodeIds).toEqual(['a', 'b'])
    expect((result.steps ?? []).map((line) => line.text).join('\n')).toContain('无需关闭')
  })

  it('still fails a plain click the page never shows', async () => {
    // The skip is scoped to cleanup. A step that must act cannot be excused by
    // its target being absent — that is the failure the gate exists to report.
    const result = await runWorkflow(
      graph(clickNode('a', { description: '点击「上传图片」按钮，打开系统文件选择器' }), upload()),
      {
        executors: {
          'event-click': async () => null,
          'upload-file': async () => null,
        },
        readinessProbe: hiddenControl,
      },
    )
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('READINESS_TIMEOUT(visible)')
  })

  it('refuses to excuse a click that also names an outward act', async () => {
    // 「关闭弹窗并提交」 is not pure cleanup, and a step that submits is never
    // skipped by inferring its preconditions were already true.
    expect(isDismissStep(clickNode('a', { description: '关闭提示弹窗并提交笔记' }))).toBe(false)
  })
})

describe('isDismissStep', () => {
  it('reads the round-31 prose, in both places a generated node keeps its meaning', () => {
    expect(isDismissStep(clickNode('a', { description: '关闭右侧「草稿箱」抽屉' }))).toBe(true)
    expect(isDismissStep(clickNode('a', { label: '草稿箱抽屉关闭按钮' }))).toBe(true)
    expect(
      isDismissStep(clickNode('a', { description: 'dismiss the cookie banner overlay' })),
    ).toBe(true)
  })

  it('does not read every mention of a window as a dismissal', () => {
    expect(isDismissStep(clickNode('a', { description: '在新窗口里选择三张图片' }))).toBe(false)
    expect(isDismissStep(clickNode('a', { description: '填写标题' }))).toBe(false)
    expect(
      isDismissStep({
        ...clickNode('a', { description: '关闭抽屉', blockId: 'forms', action: 'fill' }),
        label: 'forms',
      }),
    ).toBe(false)
  })
})

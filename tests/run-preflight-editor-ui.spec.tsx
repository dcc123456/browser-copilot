/**
 * The run gate's findings reach the canvas and the run log.
 *
 * A missing parameter used to surface as one toast of contract prose that named
 * no node the user could find. It now marks the node red (tooltip = the gate's
 * own sentence) and writes one log row per node carrying its id, so the row can
 * scroll the canvas to the step. These are the two render halves of
 * specs/2026-10-06-run-preflight-log-design.md §3.2.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'
import { BlockNode } from '../src/workflow-editor/flow/BlockNode'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { TraceRow, buildTrace, type RunView } from '../src/workflow-editor/sidebar/log-view'
import type { BlockCatalogEntry } from '../src/lib/workflow/blocks/types'

const textBlock = {
  id: 'get-text',
  name: 'Get text',
  category: 'data',
  icon: 'ri-text',
} as unknown as BlockCatalogEntry

function locale(): ReturnType<typeof makeEditorLocale> {
  return makeEditorLocale('en', (key) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key)
}

function nodeCard(data: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(
      EditorLocaleContext.Provider,
      { value: locale() },
      createElement(ReactFlowProvider, {
        children: createElement(BlockNode, {
          id: 'g',
          data: { block: textBlock, blockData: { selector: '' }, ...data },
          selected: false,
        } as never),
      }),
    ),
  )
}

describe('the blocked node on the canvas', () => {
  it('tints the card and shows the gate sentence as its tooltip', () => {
    const html = nodeCard({
      runState: 'error',
      blockedReason: '缺少必填参数 selector：缺少元素定位。',
    })
    expect(html).toContain('wf-node-error')
    expect(html).toContain('wf-node-alert')
    expect(html).toContain('缺少必填参数 selector')
  })

  it('stays plain when the gate is happy with the node', () => {
    const html = nodeCard({})
    expect(html).not.toContain('wf-node-error')
    expect(html).not.toContain('wf-node-alert')
  })
})

describe('the blocked node in the run log', () => {
  const run: RunView = {
    runId: 'r1',
    label: 'wf',
    source: 'manual',
    startedAt: 1,
    finishedAt: 2,
    outcome: 'failed',
    steps: [
      { at: 1, kind: 'error', text: '运行前检查：1 个算子缺少必填参数，无法执行。' },
      {
        at: 1,
        kind: 'error',
        text: '节点 "Get text: 读取草稿标题" 缺少必填参数 selector：缺少元素定位。',
        nodeId: 'g',
        label: 'Get text: 读取草稿标题',
      },
    ],
  }

  it('keeps the node id on the row written before any block header', () => {
    const [summary, blamed] = buildTrace(run)
    expect(summary?.nodeId).toBeUndefined()
    expect(blamed?.nodeId).toBe('g')
    expect(blamed?.type).toBe('error')
  })

  it('offers the locate action only where there is a node to locate', () => {
    const trace = buildTrace(run)
    const render = (index: number) =>
      renderToStaticMarkup(
        createElement(
          EditorLocaleContext.Provider,
          { value: locale() },
          createElement(TraceRow, {
            entry: trace[index]!,
            debug: false,
            onInspect: () => {},
            onLocate: () => {},
          }),
        ),
      )
    expect(render(1)).toContain('Locate')
    expect(render(0)).not.toContain('Locate')
  })
})

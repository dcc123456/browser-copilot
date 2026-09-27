import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { BlockNode } from '../src/workflow-editor/flow/BlockNode'
import { ReactFlowProvider } from '@xyflow/react'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
import type { BlockCatalogEntry } from '../src/lib/workflow/blocks/types'
const block = { id: 'event-click', name: 'Click element', category: 'interaction', icon: 'ri-cursor-line' } as unknown as BlockCatalogEntry
function data(hasGoal: boolean) {
  const base: Record<string, unknown> = { selector: '.btn' }
  const blockData = hasGoal
    ? withNodeGoalContract(base, { version: 1, goal: 'Click the submit button', successCriteria: [{ kind: 'elementExists', target: { testId: 'btn' } }] })
    : base
  return { block, blockData, label: 'Click element' }
}
function render(nodeData: unknown): string {
  const value = makeEditorLocale('en', (key) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key)
  return renderToStaticMarkup(
    createElement(EditorLocaleContext.Provider, { value },
      createElement(
        ReactFlowProvider,
        { children: createElement(BlockNode, { id: 'n1', data: nodeData, selected: false } as never) },
      ),
    ),
  )
}
describe('V67 node goal viewable directly on the node card', () => {
  it('shows the goal pill on a goal-bearing card', () => {
    const html = render(data(true))
    expect(html).toContain('Click the submit button') // title attribute
    expect(html).toContain('>Goal<')
  })
  it('renders fine without a goal (legacy node)', () => {
    expect(() => render(data(false))).not.toThrow()
  })
})
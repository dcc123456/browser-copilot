/**
 * Acceptance tests for the per-node AI Fix modal presentational pieces
 * (server-rendered): suggestion input + confirm on the input screen, the
 * missing-contract warning, and the apply button + step timeline on success.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  NodeFixBody,
  NodeFixFooter,
  type NodeFixBodyProps,
  type NodeFixFooterProps,
} from '../src/workflow-editor/sidebar/NodeFixModal'
import type { NodeFixEvent } from '../src/lib/workflow/node-fix'

const t = (key: string) => key

function bodyProps(over: Partial<NodeFixBodyProps> = {}): NodeFixBodyProps {
  return {
    state: 'input',
    hasContract: true,
    suggestion: '',
    events: [],
    onSuggestionChange: () => {},
    t,
    ...over,
  }
}

function footerProps(over: Partial<NodeFixFooterProps> = {}): NodeFixFooterProps {
  return {
    state: 'input',
    hasContract: true,
    onClose: () => {},
    onConfirm: () => {},
    onCancel: () => {},
    onApply: () => {},
    t,
    ...over,
  }
}

describe('V-node-fix: per-block AI fix dialog', () => {
  it('renders the suggestion field and confirm button on the input screen', () => {
    const html = renderToStaticMarkup(createElement(NodeFixBody, bodyProps()))
    expect(html).toContain('nodeFixSuggestionLabel')
    expect(html).toContain('nodeFixSuggestionPlaceholder')
    const footer = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ state: 'input' })),
    )
    expect(footer).toContain('nodeFixConfirm')
  })

  it('shows the missing-contract warning and disables confirm when no contract', () => {
    const html = renderToStaticMarkup(createElement(NodeFixBody, bodyProps({ hasContract: false })))
    expect(html).toContain('nodeFixMissingContract')
    const footer = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ hasContract: false })),
    )
    expect(footer).toContain('disabled')
  })

  it('renders the step timeline and apply button on success', () => {
    const events: NodeFixEvent[] = [
      { sessionId: 's', phase: 'observing', round: 0, message: 'page', status: 'done' },
      { sessionId: 's', phase: 'executing', round: 0, message: 'block', status: 'done' },
      { sessionId: 's', phase: 'verifying', round: 0, message: '1/1 held', status: 'done' },
    ]
    const html = renderToStaticMarkup(
      createElement(NodeFixBody, bodyProps({ state: 'success', events })),
    )
    expect(html).toContain('nodeFixPhaseObserving')
    expect(html).toContain('nodeFixPhaseVerifying')
    expect(html).toContain('nodeFixNoChangeNeeded')
    const footer = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ state: 'success' })),
    )
    expect(footer).toContain('nodeFixApply')
  })

  it('renders the failure reason and close button on failure', () => {
    const html = renderToStaticMarkup(
      createElement(
        NodeFixBody,
        bodyProps({ state: 'failed', resultReason: 'No provider configured.' }),
      ),
    )
    expect(html).toContain('No provider configured.')
    const footer = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ state: 'failed' })),
    )
    expect(footer).toContain('nodeFixClose')
  })
})

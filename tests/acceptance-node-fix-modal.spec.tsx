/**
 * Acceptance tests for the per-node AI Fix modal presentational pieces
 * (server-rendered): suggestion + error-log inputs and confirm on the input
 * screen, the no-contract notice, the step timeline, and the two success
 * wordings (`criteria` vs `exec-only`).
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
    errorLog: '',
    events: [],
    onSuggestionChange: () => {},
    onErrorLogChange: () => {},
    t,
    ...over,
  }
}

function footerProps(over: Partial<NodeFixFooterProps> = {}): NodeFixFooterProps {
  return {
    state: 'input',
    canRun: true,
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
    // A node that DOES have a contract is not asked for an error log.
    expect(html).not.toContain('nodeFixErrorLogLabel')
    const footer = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ state: 'input' })),
    )
    expect(footer).toContain('nodeFixConfirm')
  })

  it('offers the error log and the temporary-judgement notice without a contract', () => {
    const html = renderToStaticMarkup(createElement(NodeFixBody, bodyProps({ hasContract: false })))
    expect(html).toContain('nodeFixMissingContract')
    expect(html).toContain('nodeFixErrorLogLabel')
    expect(html).toContain('nodeFixErrorLogPlaceholder')
  })

  it('disables confirm only when there is neither a contract nor anything typed', () => {
    // `disabled:` Tailwind variants are always in the class string, so assert on
    // the attribute React emits for a disabled button.
    const blocked = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ canRun: false })),
    )
    expect(blocked).toContain('disabled=""')
    const allowed = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ canRun: true })),
    )
    expect(allowed).not.toContain('disabled=""')
  })

  it('renders the step timeline and apply button on success', () => {
    const events: NodeFixEvent[] = [
      { sessionId: 's', phase: 'observing', round: 0, message: 'page', status: 'done' },
      { sessionId: 's', phase: 'executing', round: 0, message: 'block', status: 'done' },
      { sessionId: 's', phase: 'verifying', round: 0, message: '1/1 held', status: 'done' },
    ]
    const html = renderToStaticMarkup(
      createElement(NodeFixBody, bodyProps({ state: 'success', events, verifiedBy: 'criteria' })),
    )
    expect(html).toContain('nodeFixPhaseObserving')
    expect(html).toContain('nodeFixPhaseVerifying')
    expect(html).toContain('nodeFixNoChangeNeeded')
    const footer = renderToStaticMarkup(
      createElement(NodeFixFooter, footerProps({ state: 'success' })),
    )
    expect(footer).toContain('nodeFixApply')
  })

  it('says so when only the trial run proved anything', () => {
    const html = renderToStaticMarkup(
      createElement(NodeFixBody, bodyProps({ state: 'success', verifiedBy: 'exec-only' })),
    )
    expect(html).toContain('nodeFixSuccessExecOnly')
    expect(html).not.toContain('nodeFixNoChangeNeeded')
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

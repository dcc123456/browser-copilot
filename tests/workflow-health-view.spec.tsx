import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { WorkflowHealthView } from '../src/sidepanel/WorkflowHealthView'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor } from '../src/lib/i18n'
import type { WorkflowHealthSummary } from '../src/lib/workflow/workflow-health'

function renderHealth(health: WorkflowHealthSummary): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale: 'en', t: messagesFor('en') } },
      createElement(WorkflowHealthView, { health }),
    ),
  )
}

describe('WorkflowHealthView', () => {
  it('renders a stable workflow with its pass ratio and last verified time', () => {
    const html = renderHealth({
      status: 'stable',
      totalRuns: 10,
      passedRuns: 9,
      lastVerifiedAt: new Date('2026-01-01T00:00:00Z').getTime(),
      repairedRuns: 1,
      resumedRuns: 1,
    })
    expect(html).toContain('Stable')
    expect(html).toContain('9 / 10 runs passed')
    expect(html).toContain('Last verified:')
    expect(html).toContain('1 repaired · 1 resumed')
  })

  it('renders needs-attention and the last failure category', () => {
    const html = renderHealth({
      status: 'needs-attention',
      totalRuns: 3,
      passedRuns: 1,
      lastFailureCategory: 'LOCATOR',
      repairedRuns: 0,
      resumedRuns: 0,
    })
    expect(html).toContain('Needs attention')
    expect(html).toContain('1 / 3 runs passed')
    expect(html).toContain('Last failure: LOCATOR')
  })

  it('renders no-data without counts', () => {
    const html = renderHealth({
      status: 'no-data',
      totalRuns: 0,
      passedRuns: 0,
      repairedRuns: 0,
      resumedRuns: 0,
    })
    expect(html).toContain('No runs yet')
  })
})

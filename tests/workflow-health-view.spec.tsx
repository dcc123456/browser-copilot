import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { WorkflowHealthView } from '../src/sidepanel/WorkflowHealthView'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor } from '../src/lib/i18n'
import type { ReplayFirstRunRecord } from '../src/lib/workflow/replay-metrics'
import type { WorkflowHealthSummary } from '../src/lib/workflow/workflow-health'

function renderHealth(
  health: WorkflowHealthSummary,
  firstRun?: ReplayFirstRunRecord,
  locale: 'en' | 'zh-CN' = 'en',
): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(WorkflowHealthView, { health, ...(firstRun ? { firstRun } : {}) }),
    ),
  )
}

const stable: WorkflowHealthSummary = {
  status: 'stable',
  totalRuns: 10,
  passedRuns: 9,
  repairedRuns: 0,
  resumedRuns: 0,
}

const firstRun = (over: Partial<ReplayFirstRunRecord> = {}): ReplayFirstRunRecord => ({
  workflowId: 'wf1',
  revision: 1,
  at: 1,
  outcome: 'ok',
  degradedSteps: 0,
  degradeRungs: [],
  autoRepaired: false,
  ...over,
})

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

  it('says nothing about a first replay it never measured', () => {
    expect(renderHealth(stable)).not.toContain('First replay')
  })

  it('grades a clean pass apart from one that leaned on the locator ladder', () => {
    // The clean pass claims nothing else: the line ends right after "passed".
    expect(renderHealth(stable, firstRun())).toContain('First replay passed</span>')
    expect(renderHealth(stable, firstRun({ degradedSteps: 2, degradeRungs: [2, 3] }))).toContain(
      'First replay passed after 2 locator fallback(s)',
    )
    // Rung 4 is the first-visible guess: the step matched nothing, it settled.
    expect(renderHealth(stable, firstRun({ degradedSteps: 1, degradeRungs: [4] }))).toContain(
      'First replay passed on a guessed locator',
    )
  })

  it('names the failure code, and reports a repair-only pass as a failure', () => {
    const failed = renderHealth(
      stable,
      firstRun({ outcome: 'failed', failureCode: 'READINESS_TIMEOUT(present)' }),
    )
    expect(failed).toContain('First replay failed (READINESS_TIMEOUT(present))')
    expect(renderHealth(stable, firstRun({ outcome: 'failed', autoRepaired: true }))).toContain(
      'First replay failed until AI repair',
    )
  })

  it('localizes the first-replay line', () => {
    expect(renderHealth(stable, firstRun({ outcome: 'failed', failureCode: 'LOCATOR_NOT_FOUND' }), 'zh-CN')).toContain(
      '首次回放失败（LOCATOR_NOT_FOUND）',
    )
  })
})

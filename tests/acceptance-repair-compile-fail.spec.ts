import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CertificationEvidence } from '../src/workflow-editor/sidebar/CertificationModal'
import type { VerificationReport } from '../src/background/workflow-engine/goal-verification'
import { newGenerationMetrics, recordMetric, summarizeMetrics } from '../src/lib/workflow/generation-metrics'
const t = (key: string) => key
function failedReport(level: VerificationReport['level'], reason: string): VerificationReport {
  return { level, passed:false, l1:[], l2:{nodes:[],allHeld:false}, l3:{goalSummary:'',conditions:[],allHeld:false}, certified:false, reason }
}
describe('V99 repair/compile failure cannot be marked certified', () => {
  it('an unverified repair result shows failed status, never certified', () => {
    const html = renderToStaticMarkup(createElement(CertificationEvidence, { report: failedReport('L2','L2 failed after repair'), t }))
    expect(html).toContain('L2 failed after repair')
    expect(html).not.toContain('Certified')
  })
  it('compile-time metrics with failing attempts keep failureRate visible and never assert success', () => {
    const m = newGenerationMetrics()
    recordMetric(m,{type:'operator-attempt'})
    recordMetric(m,{type:'operator-failure'})
    const summary = summarizeMetrics(m)
    expect(summary.failureRate).toBe(1)
    expect(summary.attemptsPerNode).toBe(0) // no node recorded on failure
  })
})
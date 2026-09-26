import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CertificationEvidence } from '../src/workflow-editor/sidebar/CertificationModal'
import type { VerificationReport } from '../src/background/workflow-engine/goal-verification'
const t = (key: string) => key
function report(certified: boolean): VerificationReport {
  return {
    level: certified ? 'L3' : 'L2', passed: certified,
    l1: [{ description: 'forms executed', satisfied: true }],
    l2: { nodes: [{ nodeId: 'n', blockId: 'forms', executed: true, criteria: [{ description: 'variable x exists', satisfied: certified }], preconditions: [] }], allHeld: certified },
    l3: { goalSummary: 'G', conditions: [{ description: 'business result present', satisfied: certified }], allHeld: certified },
    certified, reason: certified ? 'L3 passed' : 'L2 failed: contract did not hold.',
  }
}
describe('V66 final workflow is presented as structured UI', () => {
  it('renders the goal/status/evidence, not a text tail', () => {
    const html = renderToStaticMarkup(createElement(CertificationEvidence, { report: report(true), t }))
    expect(html).toContain('L3 passed')
    expect(html).toContain('certLevelL3')
  })
  it('shows a failed status visibly', () => {
    const html = renderToStaticMarkup(createElement(CertificationEvidence, { report: report(false), t }))
    expect(html).toContain('L2 failed')
  })
})
describe('V68 verification evidence is viewable', () => {
  it('shows why each node/condition passed or failed', () => {
    const html = renderToStaticMarkup(createElement(CertificationEvidence, { report: report(false), t }))
    expect(html).toContain('variable x exists')
    expect(html).toContain('forms executed')
    expect(html).toContain('business result present')
  })
})
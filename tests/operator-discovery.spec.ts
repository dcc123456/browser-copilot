import { describe, expect, it } from 'vitest'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
const cases: [string, string[]][] = [
  ['click the submit button', ['event-click']],
  ['fill in the email field', ['forms']],
  ['read the text of the heading', ['get-text']],
  ['read the href attribute', ['attribute-value']],
  ['wait until the dialog appears', ['element-exists']],
  ['switch to the next browser tab', ['switch-tab']],
  ['upload a file from my computer', ['upload-file']],
  ['save the data to the table', ['insert-data']],
  ['verify that the success message exists', ['element-exists']],
]
describe('29.1 operator discovery', () => {
  it.each(cases)('ranks a native operator for: %s', (intent, expected) => {
    const result = findWorkflowOperators({ stepIntent: intent })
    expect(result.candidates.length).toBeGreaterThan(0)
    const ids = result.candidateBlockIds
    for (const id of expected) expect(ids).toContain(id)
  })
  it('returns a stable ranked set ordered by score', () => {
    const result = findWorkflowOperators({ stepIntent: 'click the login button', limit: 5 })
    expect(result.candidates.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < result.candidates.length; i++) {
      const prev = result.candidates[i - 1]!
      const cur = result.candidates[i]!
      expect(prev.score).toBeGreaterThanOrEqual(cur.score)
    }
    expect(result.candidateBlockIds).toContain('event-click')
  })
  it('never exposes javascript-code as a normal candidate', () => {
    const result = findWorkflowOperators({ stepIntent: 'do something complicated on the page' })
    expect(result.candidateBlockIds).not.toContain('javascript-code')
  })
})
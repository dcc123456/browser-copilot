import { describe, expect, it } from 'vitest'
import {
  REFLECTION_MIN_STRATEGY_CONFIDENCE,
  buildReflectionMessages,
  parseRepairReflection,
  renderReflectionHistory,
  strategySuggestionOf,
  type RepairReflection,
} from '../../src/lib/workflow/repair-reflection'

function reflection(overrides: Partial<RepairReflection> = {}): RepairReflection {
  return {
    rootCause: 'the selector matched the wrapper, not the button',
    evidence: 'div.card matched 1 element but it is not clickable',
    nextApproach: 'target the inner button.testid instead',
    confidence: 0.8,
    ...overrides,
  }
}

describe('parseRepairReflection', () => {
  it('reads a well-formed object', () => {
    const parsed = parseRepairReflection({
      rootCause: 'stale selector',
      evidence: '#old is gone',
      nextApproach: 'use [data-testid=submit]',
      suggestedStrategy: 'locator-repair',
      confidence: 0.9,
    })
    expect(parsed).toMatchObject({
      rootCause: 'stale selector',
      evidence: '#old is gone',
      nextApproach: 'use [data-testid=submit]',
      suggestedStrategy: 'locator-repair',
      confidence: 0.9,
    })
  })

  it('extracts the JSON object out of surrounding prose', () => {
    const parsed = parseRepairReflection(
      'Let me think. {"rootCause":"timing","evidence":"elapsed 40ms","nextApproach":"wait for the node","confidence":0.7} Done.',
    )
    expect(parsed?.rootCause).toBe('timing')
    expect(parsed?.nextApproach).toBe('wait for the node')
  })

  // A reflection that mangled its output must leave the caller on its
  // no-reflection path — it can never invent a conclusion.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'no patch proposed'],
    ['a prose blob with no JSON', 'I think the selector is wrong somehow'],
    ['an array', [{ rootCause: 'x' }]],
    ['a JSON array', '[]'],
    ['an object missing rootCause', { nextApproach: 'do x' }],
    ['an object missing nextApproach', { rootCause: 'y' }],
    ['an object with blank required fields', { rootCause: '   ', nextApproach: '' }],
    ['a number', 42],
  ])('degrades to null for %s', (_label, raw) => {
    expect(parseRepairReflection(raw as unknown)).toBeNull()
  })

  it('fills a missing evidence field rather than dropping the reflection', () => {
    const parsed = parseRepairReflection({ rootCause: 'x', nextApproach: 'y' })
    expect(parsed?.evidence).toBe('(no page evidence reported)')
  })

  it('clamps confidence into 0..1', () => {
    expect(
      parseRepairReflection({ rootCause: 'x', nextApproach: 'y', confidence: 5 })?.confidence,
    ).toBe(1)
    expect(
      parseRepairReflection({ rootCause: 'x', nextApproach: 'y', confidence: -3 })?.confidence,
    ).toBe(0)
  })

  it('drops a non-numeric confidence to the neutral default', () => {
    const parsed = parseRepairReflection({
      rootCause: 'x',
      nextApproach: 'y',
      confidence: 'very sure',
    })
    expect(parsed?.confidence).toBe(0.5)
  })

  it('drops a suggested strategy the model is not confident about', () => {
    const parsed = parseRepairReflection({
      rootCause: 'x',
      nextApproach: 'y',
      suggestedStrategy: 'locator-repair',
      confidence: REFLECTION_MIN_STRATEGY_CONFIDENCE - 0.01,
    })
    expect(parsed).not.toHaveProperty('suggestedStrategy')
    expect(strategySuggestionOf(parsed)).toBeUndefined()
  })

  it('rejects a suggested strategy that is not a plain strategy name', () => {
    const parsed = parseRepairReflection({
      rootCause: 'x',
      nextApproach: 'y',
      suggestedStrategy: 'rm -rf everything',
      confidence: 1,
    })
    expect(parsed).not.toHaveProperty('suggestedStrategy')
  })

  it('caps a runaway field instead of shipping it whole', () => {
    const parsed = parseRepairReflection({ rootCause: 'x'.repeat(2000), nextApproach: 'y' })
    expect(parsed!.rootCause.length).toBeLessThanOrEqual(401)
    expect(parsed!.rootCause.endsWith('…')).toBe(true)
  })
})

describe('strategySuggestionOf', () => {
  it('returns a confident suggestion', () => {
    expect(strategySuggestionOf(reflection({ suggestedStrategy: 'parameter-repair' }))).toBe(
      'parameter-repair',
    )
  })

  it('returns undefined when there is no reflection at all', () => {
    expect(strategySuggestionOf(null)).toBeUndefined()
    expect(strategySuggestionOf(undefined)).toBeUndefined()
  })
})

describe('renderReflectionHistory', () => {
  it('renders each reflection as one line carrying cause, evidence and next step', () => {
    const rendered = renderReflectionHistory([reflection()])
    expect(rendered).toContain('the selector matched the wrapper')
    expect(rendered).toContain('div.card matched 1 element')
    expect(rendered).toContain('target the inner button.testid')
  })

  it('keeps only the most recent reflections', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      reflection({ rootCause: `cause-${index}` }),
    )
    const rendered = renderReflectionHistory(many)
    expect(rendered).toContain('cause-8')
    expect(rendered).not.toContain('cause-0')
  })

  it('renders an empty string for no reflections', () => {
    expect(renderReflectionHistory([])).toBe('')
  })
})

describe('buildReflectionMessages', () => {
  const parts = {
    workflowName: 'publish post',
    failedNode: { nodeId: 'n5', blockId: 'event-click', locator: '#old-submit' },
    originalFailure: 'element not found: #old-submit',
    attemptedStrategy: 'locator-repair',
    attemptedReason: 'switch to .btn-primary',
    outcome: 'replay failed: .btn-primary matched 0 elements',
    pageInspection: { target: { found: false }, interactive: [{ selector: '#submit' }] },
    history: [reflection()],
    exhaustedStrategies: ['readiness-recovery'],
  }

  it('gives the model the failure scene and the dead ends it must avoid', () => {
    const messages = buildReflectionMessages(parts)
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user')
    expect(messages[0]?.content).toContain('ONLY a JSON object')
    expect(messages[0]?.content).toContain('not to propose new patches')
    expect(messages[1]?.content).toContain('#submit')
    expect(messages[1]?.content).toContain('readiness-recovery')
    expect(messages[1]?.content).toContain('earlierReflections')
  })

  it('omits the optional sections when they are absent', () => {
    const messages = buildReflectionMessages({
      failedNode: { nodeId: 'n1', blockId: 'get-text' },
      originalFailure: 'boom',
      attemptedStrategy: 'locator-repair',
      outcome: 'still failing',
    })
    expect(messages[1]?.content).not.toContain('pageEvidenceAfterFailure')
    expect(messages[1]?.content).not.toContain('earlierReflections')
    expect(messages[1]?.content).not.toContain('alreadyTriedAndAbandoned')
    expect(messages[0]?.content).not.toContain('earlierReflections')
  })
})

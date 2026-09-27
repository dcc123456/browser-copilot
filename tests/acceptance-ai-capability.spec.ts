import { describe, expect, it } from 'vitest'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
import { operatorEntry } from '../src/lib/workflow/operator-registry'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
describe('V18 ai-agent is a formal capability', () => {
  it('has registry metadata with on-demand exposure and real executor', () => {
    const entry = operatorEntry('ai-agent')!
    expect(entry.aiExposure).toBe('on-demand')
    expect(entry.hasExecutor).toBe(true)
    expect(entry.capabilities.length).toBeGreaterThan(0)
    expect(entry.allowGeneration).toBe(true)
  })
  it('is discovered for a semantic-generation task via the discovery intent', () => {
    const result = findWorkflowOperators({ stepIntent: 'draft a personalized follow-up email' })
    expect(result.detectedIntents.some((d) => d.intent === 'semantic-generation')).toBe(true)
    expect(result.candidateBlockIds).toContain('ai-agent')
  })
  it('has inputs, an output variable and success criteria', () => {
    const contract = resolveNodeGoalContract('ai-agent', { variableName: 'reply' })
    expect(contract).toBeDefined()
    expect(contract!.successCriteria).toContainEqual({ kind: 'variableExists', name: 'reply' })
  })
})
describe('V43 ai-agent output variable is traceable', () => {
  it('the recorded contract references the produced variable', () => {
    const contract = resolveNodeGoalContract('ai-agent', { variableName: 'emailDraft' })!
    expect(JSON.stringify(contract)).toContain('emailDraft')
  })
})
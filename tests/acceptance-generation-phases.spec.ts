import { describe, expect, it } from 'vitest'
import { GENERATION_STAGE_ORDER, type GenerationStageId } from '../src/lib/workflow/generation-report'
// The user-visible phase model (spec V65). The static pipeline stages plus
// the agent-loop phases together cover the full lifecycle.
const AGENT_PHASES = ['PREPARING_GOAL', 'FINDING_OPERATORS', 'EXECUTING', 'VERIFYING', 'REPAIRING'] as const
const TERMINAL = ['CERTIFIED', 'FAILED'] as const
describe('V65 generation process state is understandable', () => {
  it('the pipeline reports every static stage in a stable order', () => {
    expect(GENERATION_STAGE_ORDER).toContain('NORMALIZE')
    expect(GENERATION_STAGE_ORDER).toContain('HARDEN_TARGETS')
    expect(GENERATION_STAGE_ORDER).toContain('STATIC_VALIDATE')
    const ids = new Set<GenerationStageId>(GENERATION_STAGE_ORDER)
    expect(ids.size).toBe(GENERATION_STAGE_ORDER.length)
  })
  it('the agent loop exposes preparing/finding/executing/verifying/repairing phases', () => {
    expect(AGENT_PHASES).toContain('PREPARING_GOAL')
    expect(AGENT_PHASES).toContain('FINDING_OPERATORS')
    expect(AGENT_PHASES).toContain('REPAIRING')
  })
  it('terminates in an explicit certified or failed state', () => {
    expect(TERMINAL).toEqual(['CERTIFIED', 'FAILED'])
  })
})
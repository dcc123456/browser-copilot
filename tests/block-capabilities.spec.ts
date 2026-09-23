/**
 * Block capability catalog tests (计划 T01.2).
 *
 * The capability catalog answers, for every block the palette offers:
 * what it acts on, which variables it consumes/produces, whether it has side
 * effects, whether it is engine-interpreted, and which block implements each
 * semantic action. These tests pin the derivation rules and the explicit
 * overrides the later IR compilers/validators depend on.
 */
import { describe, expect, it } from 'vitest'

import {
  BLOCK_CAPABILITIES,
  capabilityOf,
  blocksForSemanticAction,
  inferBlockCapability,
  semanticActionsOfBlock,
} from '../src/lib/workflow/block-capabilities'

import type { BlockCapability, SemanticActionName } from '../src/lib/workflow/block-capabilities'

describe('block capability catalog', () => {
  it('provides a capability for every palette block id', () => {
    const ids = [...BLOCK_CAPABILITIES.keys()]
    expect(ids.length).toBeGreaterThanOrEqual(50)
    for (const [id, capability] of BLOCK_CAPABILITIES) {
      expect(capability.blockId).toBe(id)
    }
  })

  it('marks event-click as a click-acting, side-effect-capable interaction block', () => {
    const capability = capabilityOf('event-click')
    expect(capability).toBeDefined()
    expect(capability!.actions).toContain('click')
    expect(capability!.hasSideEffect).toBe(true)
    expect(capability!.needsTarget).toBe(true)
    expect(capability!.kind).toBe('interaction')
    expect(capability!.engineInterpreted).toBe(false)
  })

  it('records the explicit fill/submit capabilities of forms', () => {
    const capability = capabilityOf('forms')!
    expect(capability.actions).toEqual(
      expect.arrayContaining(['fill', 'select', 'check', 'submit']),
    )
    expect(capability.hasSideEffect).toBe(true)
    expect(capability.needsTarget).toBe(true)
  })

  it('marks get-text as a pure read with an output variable', () => {
    const capability = capabilityOf('get-text')!
    expect(capability.actions).toContain('read-text')
    expect(capability.hasSideEffect).toBe(false)
    expect(capability.outputsVars).toContain('variableName')
  })

  it('classifies new-tab as navigation with url param and side effect', () => {
    const capability = capabilityOf('new-tab')!
    expect(capability.actions).toContain('navigate')
    expect(capability.params).toContain('url')
    expect(capability.hasSideEffect).toBe(true)
  })

  it('classifies delay as wait with no target and no side effect', () => {
    const capability = capabilityOf('delay')!
    expect(capability.actions.some((a) => a.startsWith('wait-'))).toBe(true)
    expect(capability.needsTarget).toBe(false)
    expect(capability.hasSideEffect).toBe(false)
  })

  it('flags engine-interpreted blocks (loops, conditions, execute-workflow)', () => {
    expect(capabilityOf('while-loop')!.engineInterpreted).toBe(true)
    expect(capabilityOf('loop-data')!.engineInterpreted).toBe(true)
    expect(capabilityOf('loop-elements')!.engineInterpreted).toBe(true)
    expect(capabilityOf('execute-workflow')!.engineInterpreted).toBe(true)
    expect(capabilityOf('conditions')!.engineInterpreted).toBe(true)
  })

  it('maps semantic actions to implementing blocks, click first', () => {
    const clickBlocks = blocksForSemanticAction('click')
    expect(clickBlocks).toContain('event-click')
    expect(clickBlocks[0]).toBe('event-click')

    expect(blocksForSemanticAction('fill')).toContain('forms')
    expect(blocksForSemanticAction('navigate')).toContain('new-tab')
    expect(blocksForSemanticAction('read-text')).toContain('get-text')
  })

  it('answers the reverse lookup: semantic actions implemented by a block', () => {
    expect(semanticActionsOfBlock('event-click')).toEqual(['click'])
    expect(semanticActionsOfBlock('forms')).toEqual(
      expect.arrayContaining(['fill', 'select', 'check', 'submit']),
    )
  })

  it('derives capabilities for unknown blocks from catalog metadata', () => {
    const inferred: BlockCapability = inferBlockCapability({
      blockId: 'some-block',
      kind: 'general',
      inputs: 1,
      outputs: 1,
      params: ['description'],
      refDataKeys: [],
    })
    expect(inferred.blockId).toBe('some-block')
    expect(inferred.kind).toBe('general')
    expect(inferred.actions).toEqual([])
  })

  it('exposes the full semantic action name vocabulary', () => {
    const names: SemanticActionName[] = [
      'navigate',
      'click',
      'fill',
      'select',
      'check',
      'submit',
      'read-text',
      'read-attribute',
      'wait-element',
      'wait-time',
      'scroll',
      'press-key',
      'hover',
      'element-exists',
      'execute-js',
    ]
    expect(names).toHaveLength(15)
  })
})

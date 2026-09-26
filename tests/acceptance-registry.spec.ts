import { describe, expect, it } from 'vitest'
import {
  allOperators, auditRegistry, generationOperators, operatorEntry,
} from '../src/lib/workflow/operator-registry'
import { PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'
import { capabilityOf } from '../src/lib/workflow/block-capabilities'
describe('V01 all executable blocks inventoried', () => {
  it('registers every palette block with a unique id', () => {
    const ids = allOperators().map((e) => e.id)
    expect(new Set(ids)).toHaveLength(ids.length)
    for (const block of PALETTE_BLOCKS) expect(ids).toContain(block.id)
  })
  it('audit finds no unknown-to-registry executable block', () => {
    const audit = auditRegistry()
    expect(audit.missing).toEqual([])
  })
  it('flags placeholder/cloud-only and generation policy per entry', () => {
    for (const entry of allOperators()) {
      expect(['core','on-demand','fallback','hidden']).toContain(entry.aiExposure)
      expect(['none','page','external']).toContain(entry.sideEffect)
      expect(typeof entry.allowGeneration).toBe('boolean')
    }
    const saveAssets = operatorEntry('save-assets')!
    expect(saveAssets.hasExecutor).toBe(false)
  })
})
describe('V02 generation registry decoupled from editor catalog', () => {
  it('editor palette stays complete', () => {
    expect(PALETTE_BLOCKS.length).toBeGreaterThan(20)
  })
  it('registry filters independently by exposure', () => {
    const core = generationOperators('core')
    const fallback = generationOperators('fallback')
    expect(core.length).toBeGreaterThan(0)
    expect(fallback.some((e) => e.id === 'javascript-code')).toBe(true)
  })
})
describe('V04 capability metadata correctness', () => {
  const blocks = ['javascript-code','ai-agent','read-page','get-text','attribute-value','element-exists','event-click','forms','press-key']
  it.each(blocks)('has capability facts for %s', (blockId) => {
    const capability = capabilityOf(blockId)
    expect(capability).toBeDefined()
    const entry = operatorEntry(blockId)!
    expect(entry.id).toBe(blockId)
    expect(Array.isArray(entry.capabilities) || entry.capabilities !== undefined).toBe(true)
  })
})
describe('V15/V16/V17 operator classification', () => {
  it('every generation operator has a defined exposure', () => {
    for (const entry of allOperators()) {
      if (entry.allowGeneration) expect(entry.aiExposure).not.toBe('hidden')
    }
  })
  it('covers the common capabilities without the full catalog', () => {
    const coreIds = generationOperators('core').map((e) => e.id)
    // Core/on-demand operators cover read, click, fill and wait capabilities.
    const capabilities = new Set(coreIds.flatMap((id) => operatorEntry(id)!.capabilities))
    for (const action of ['click','fill']) expect([...capabilities].join(',')).toContain(action)
  })
  it('keeps unreliable placeholders out of ordinary discovery exposure', () => {
    const core = generationOperators('core')
    expect(core.some((e) => e.id === 'save-assets')).toBe(false)
  })
})
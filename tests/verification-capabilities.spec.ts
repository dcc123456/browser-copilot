import { describe, expect, it } from 'vitest'
import {
  allVerificationCapabilitiesResolvable, describeVerificationCapability,
  isVerificationCapabilityId, verificationBlock, VERIFICATION_CAPABILITY_IDS,
} from '../src/lib/workflow/verification-capabilities'
import { compileExtractRecord, normalizeExtractRecordSpec } from '../src/lib/workflow/extract-record'
describe('verification capabilities', () => {
  it('maps every verify intent to an implementing block', () => {
    for (const id of VERIFICATION_CAPABILITY_IDS) {
      expect(verificationBlock(id)).toBeTruthy()
      expect(describeVerificationCapability(id).length).toBeGreaterThan(0)
    }
    expect(allVerificationCapabilitiesResolvable()).toBe(true)
  })
  it('guards untrusted ids', () => {
    expect(isVerificationCapabilityId('verify-url')).toBe(true)
    expect(isVerificationCapabilityId('nope')).toBe(false)
  })
})
describe('extract-record compilation', () => {
  it('normalizes a spec with a target and fields', () => {
    const spec = normalizeExtractRecordSpec({
      target: '.row',
      fields: [
        { key: 'title', type: 'text' },
        { key: 'link', type: 'attribute', name: 'href' },
      ],
    })
    expect(spec).toBeDefined()
    expect(spec!.fields).toHaveLength(2)
  })
  it('compiles to a loop + reads + insert sequence', () => {
    const spec = normalizeExtractRecordSpec({
      target: '.row',
      fields: [{ key: 'title', type: 'text' }],
    })!
    const plan = compileExtractRecord(spec)
    const blockKinds = plan.map((s) => s.blockId)
    expect(blockKinds).toContain('loop-elements')
    expect(blockKinds).toContain('get-text')
    expect(blockKinds).toContain('insert-data')
  })
  it('rejects a spec without a target or fields', () => {
    expect(normalizeExtractRecordSpec({ fields: [] })).toBeUndefined()
  })
})
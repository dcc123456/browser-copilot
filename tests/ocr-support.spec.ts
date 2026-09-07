import { describe, expect, it } from 'vitest'
import { OCR_SUPPORTED } from '../src/lib/ocr-support'
import { CUSTOM_BLOCKS } from '../src/lib/workflow/blocks/custom'
import { PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'

/**
 * Pins the two-build OCR contract (see vite.config.ts `__OCR__`):
 * - the compile-time flag resolves to TRUE in the default/test build;
 * - exactly the OCR-dependent operators are marked `requiresOcr`, so the
 *   no-ocr release gray-out targets the right blocks.
 */
describe('ocr build flag contract', () => {
  it('OCR_SUPPORTED is true unless built with --mode no-ocr', () => {
    expect(OCR_SUPPORTED).toBe(true)
  })

  it('the ocr block is the only operator that requires OCR', () => {
    const flagged = PALETTE_BLOCKS.filter((b) => b.requiresOcr).map((b) => b.id)
    expect(flagged).toEqual(['ocr'])
    expect(CUSTOM_BLOCKS.find((b) => b.id === 'ocr')?.requiresOcr).toBe(true)
  })
})

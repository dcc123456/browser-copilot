import { describe, expect, it } from 'vitest'
import {
  evaluateCapabilityGap,
  evaluateJsPermission,
} from '../src/lib/workflow/capability-gap'

describe('evaluateJsPermission (unified javascript-code gate)', () => {
  const fullGap = {
    missingCapability: 'generate a canvas PNG via toDataURL',
    triedOperators: ['get-text', 'forms', 'event-click'],
    whyInsufficient: 'No declarative operator can draw on a canvas or produce a binary image.',
    expectedResult: 'A data URL string is produced.',
  }

  it('accepts a complete capabilityGap object', () => {
    const result = evaluateJsPermission({
      stepIntent: 'generate a canvas image and upload it',
      args: { code: 'automaNextBlock()', capabilityGap: fullGap },
    })
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.justification).toContain('canvas PNG')
      expect(result.justification).toContain('get-text')
    }
  })

  it('accepts a justification without a capabilityGap', () => {
    const result = evaluateJsPermission({
      stepIntent: 'call the page internal SDK to sign a payload',
      args: {
        code: 'automaNextBlock()',
        justification:
          'The signing value needs the page SDK: get-text reads text only, forms fills fields, webhook would call our own server rather than the page API.',
      },
    })
    expect(result.allowed).toBe(true)
  })

  it('refuses a call carrying neither', () => {
    const result = evaluateJsPermission({
      stepIntent: 'call the page internal SDK to sign a payload',
      args: { code: 'automaNextBlock()' },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.error).toContain('capabilityGap')
      expect(result.error).toContain('justification')
    }
  })

  it.each([
    ['missingCapability', { missingCapability: '' }],
    ['triedOperators', { triedOperators: [] }],
    ['whyInsufficient', { whyInsufficient: '' }],
    ['expectedResult', { expectedResult: '' }],
  ])('refuses a partial capabilityGap (%s)', (_field, patch) => {
    const result = evaluateJsPermission({
      stepIntent: 'generate a canvas image',
      args: {
        code: 'automaNextBlock()',
        capabilityGap: { ...fullGap, ...patch },
      },
    })
    expect(result.allowed).toBe(false)
  })

  it('refuses regardless of gap when a native operator covers the intent', () => {
    const result = evaluateJsPermission({
      stepIntent: 'click the submit button',
      args: { code: 'automaNextBlock()', capabilityGap: fullGap },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.nativeBlockIds).toContain('event-click')
  })

  it('still supports evaluateCapabilityGap for the four-field contract', () => {
    const decision = evaluateCapabilityGap({
      stepIntent: 'read encrypted payload inside a closed canvas widget',
      gap: fullGap,
    })
    expect(decision.allowed).toBe(true)
  })
})

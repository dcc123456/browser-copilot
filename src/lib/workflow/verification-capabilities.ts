/**
 * Verification capability registry (spec §26).
 *
 * The model must be able to request a VERIFICATION by intent, not by
 * understanding how to compose the low-level blocks. This module exposes the
 * semantic verification ids and maps each onto the existing block that
 * performs the check — so no new blocks are required while the registry still
 * advertises "verify-*" capabilities to the model.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/verification-capabilities
 */

import { operatorEntry } from './operator-registry'

/** Semantic verification capability ids (spec §26). */
export type VerificationCapabilityId =
  | 'verify-element'
  | 'verify-text'
  | 'verify-attribute'
  | 'verify-url'
  | 'verify-variable'
  | 'verify-page-state'
  | 'verify-workflow-goal'

/** Mapping of a verify intent to the existing block that implements it. */
const VERIFY_BLOCK_MAP: Record<VerificationCapabilityId, string> = {
  'verify-element': 'element-exists',
  'verify-text': 'get-text',
  'verify-attribute': 'attribute-value',
  'verify-url': 'tab-url',
  'verify-variable': 'conditions',
  'verify-page-state': 'element-exists',
  'verify-workflow-goal': 'conditions',
}

/** Human descriptions (en) of what each verify capability checks. */
const VERIFY_DESCRIPTIONS: Record<VerificationCapabilityId, string> = {
  'verify-element': 'Verify a target element exists (and optionally is visible).',
  'verify-text': 'Verify the text content of an element matches an expected value.',
  'verify-attribute': 'Verify an element attribute equals an expected value.',
  'verify-url': 'Verify the current tab URL matches an expectation.',
  'verify-variable': 'Verify a workflow variable exists or equals an expected value.',
  'verify-page-state': 'Verify the combined page state (URL + element + text).',
  'verify-workflow-goal': "Verify the workflow goal's success conditions hold.",
}

export const VERIFICATION_CAPABILITY_IDS: readonly VerificationCapabilityId[] = [
  'verify-element',
  'verify-text',
  'verify-attribute',
  'verify-url',
  'verify-variable',
  'verify-page-state',
  'verify-workflow-goal',
]

/** Resolve the implementing block id for a verification capability. */
export function verificationBlock(id: VerificationCapabilityId): string {
  return VERIFY_BLOCK_MAP[id]
}

/** Whether every verification capability maps to a known operator. */
export function allVerificationCapabilitiesResolvable(): boolean {
  return VERIFICATION_CAPABILITY_IDS.every((id) => !!operatorEntry(VERIFY_BLOCK_MAP[id]))
}

/** Describe one verification capability for discovery/tool text. */
export function describeVerificationCapability(id: VerificationCapabilityId): string {
  return VERIFY_DESCRIPTIONS[id]
}

/** Type guard for untrusted verification-capability strings. */
export function isVerificationCapabilityId(value: unknown): value is VerificationCapabilityId {
  return (
    typeof value === 'string' &&
    (VERIFICATION_CAPABILITY_IDS as readonly string[]).includes(value)
  )
}

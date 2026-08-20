/**
 * Tests for the page-read confirmation gate.
 *
 * Ticking "Attach current page" is explicit consent for that page, so the model
 * calling `read_current_page` in the same turn must not pop a redundant prompt.
 * But the waiver has to be narrow: it covers the page the user attached, not
 * "any page for the rest of the turn". These tests pin both halves, because the
 * failure modes point in opposite directions — a gate that is too strict is
 * merely annoying, while one that is too loose reads a page the user never
 * agreed to and ships it to a third-party model endpoint.
 */
import { describe, expect, it } from 'vitest'
import { needsConfirmation } from '../src/background/agent'

const PAGE = 'https://example.com/article'

describe('needsConfirmation · which tools are gated', () => {
  it('never gates use_skill, which only re-reads the user’s own text', () => {
    expect(needsConfirmation('use_skill', undefined, undefined)).toBe(false)
    expect(needsConfirmation('use_skill', PAGE, PAGE)).toBe(false)
  })

  it('does not gate an unknown tool name', () => {
    // Nothing else exists today; if a tool is added it must opt in explicitly
    // rather than inherit a prompt by accident.
    expect(needsConfirmation('something_new', undefined, undefined)).toBe(false)
  })

  it('gates a page read that the user did not attach', () => {
    // The original behaviour, unchanged: a model deciding on its own must ask.
    expect(needsConfirmation('read_current_page', undefined, PAGE)).toBe(true)
  })
})

describe('needsConfirmation · waiver after an attach', () => {
  it('waives the prompt when the attached page is still the active tab', () => {
    // The reported bug: the user ticked the box, then was asked anyway.
    expect(needsConfirmation('read_current_page', PAGE, PAGE)).toBe(false)
  })

  it('waives it despite fragment and trailing-slash differences', () => {
    // Chrome's tab URL and the page's own location.href routinely differ here.
    expect(needsConfirmation('read_current_page', PAGE, `${PAGE}#section`)).toBe(false)
    expect(needsConfirmation('read_current_page', 'https://example.com/', 'https://example.com')).toBe(
      false,
    )
  })

  it('waives it when an SPA rewrote the query string', () => {
    expect(
      needsConfirmation('read_current_page', 'https://example.com/app?tab=1', 'https://example.com/app?tab=9'),
    ).toBe(false)
  })
})

describe('needsConfirmation · the waiver stays narrow', () => {
  it('re-gates when the user switched to a different page', () => {
    // Consent covered one page, not every page from then on.
    expect(needsConfirmation('read_current_page', PAGE, 'https://example.com/other')).toBe(true)
  })

  it('re-gates when the user switched to a different site', () => {
    expect(needsConfirmation('read_current_page', PAGE, 'https://evil.com/article')).toBe(true)
  })

  it('re-gates on a subdomain, which is a different origin', () => {
    expect(needsConfirmation('read_current_page', PAGE, 'https://sub.example.com/article')).toBe(
      true,
    )
  })

  it('re-gates when the active tab cannot be determined', () => {
    // A missing tab URL proves nothing, so it must not satisfy the grant.
    expect(needsConfirmation('read_current_page', PAGE, undefined)).toBe(true)
    expect(needsConfirmation('read_current_page', PAGE, '')).toBe(true)
  })

  it('re-gates when either URL is unparseable', () => {
    expect(needsConfirmation('read_current_page', 'not a url', 'not a url')).toBe(true)
    expect(needsConfirmation('read_current_page', PAGE, 'not a url')).toBe(true)
  })

  it('ignores an empty grant string, so a failed attach grants nothing', () => {
    // The worker leaves the grant unset when the read failed: nothing was
    // disclosed, so there is nothing to have consented to.
    expect(needsConfirmation('read_current_page', '', PAGE)).toBe(true)
  })
})

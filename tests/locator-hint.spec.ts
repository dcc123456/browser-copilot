/**
 * Tests for the compact locator hint (`locatorHintOf`) the agent snapshot
 * exposes per element: stable specs (#id / data-testid / name) render as
 * copyable CSS locators; unstable ones (role/text/css-path) render nothing.
 */
import { describe, expect, it } from 'vitest'
import { locatorHintOf } from '../src/lib/ops'

describe('locatorHintOf', () => {
  it('renders id / testid / name specs as CSS locators', () => {
    expect(locatorHintOf({ primary: { how: 'id', value: 'login-btn' } })).toBe('#login-btn')
    expect(locatorHintOf({ primary: { how: 'testid', value: 'submit' } })).toBe('[data-testid="submit"]')
    expect(locatorHintOf({ primary: { how: 'testid', value: 'data-qa=submit' } })).toBe('[data-qa=submit]')
    expect(locatorHintOf({ primary: { how: 'name', value: 'email' } })).toBe('[name="email"]')
    expect(locatorHintOf({ primary: { how: 'name', value: 'data-x=email', tag: 'input' } })).toBe('[data-x=email]')
  })

  it('renders nothing for unstable or unusable specs', () => {
    expect(locatorHintOf({ primary: { how: 'css', value: 'div > ul > li:nth-child(2)' } })).toBeUndefined()
    expect(locatorHintOf({ primary: { how: 'text', value: '下单' } })).toBeUndefined()
    expect(locatorHintOf({ primary: { how: 'role', value: '提交', role: 'button' } })).toBeUndefined()
    expect(locatorHintOf({ primary: { how: 'id', value: '' } })).toBeUndefined()
    expect(locatorHintOf({ primary: { how: 'id', value: 'x'.repeat(80) } })).toBeUndefined()
    expect(locatorHintOf(undefined)).toBeUndefined()
    expect(locatorHintOf('nope')).toBeUndefined()
    expect(locatorHintOf({})).toBeUndefined()
    expect(locatorHintOf({ primary: { how: 'id' } })).toBeUndefined()
  })
})

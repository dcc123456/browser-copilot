import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  isNewerVersion,
  normalizeVersion,
  parseSemver,
} from '../src/lib/update/version'

describe('update version parsing', () => {
  it('accepts stable X.Y.Z with or without a leading v', () => {
    expect(parseSemver('0.6.7')).toEqual({ major: 0, minor: 6, patch: 7 })
    expect(parseSemver('v1.20.3')).toEqual({ major: 1, minor: 20, patch: 3 })
    expect(parseSemver(' 2.0.0 ')).toEqual({ major: 2, minor: 0, patch: 0 })
  })

  it('rejects prereleases, missing parts, leading zeros and suffixes', () => {
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('1.2.3-rc.1')).toBeNull()
    expect(parseSemver('1.2.3.4')).toBeNull()
    expect(parseSemver('01.2.3')).toBeNull()
    expect(parseSemver('v')).toBeNull()
    expect(parseSemver('latest')).toBeNull()
  })

  it('strips exactly one leading v', () => {
    expect(normalizeVersion('v0.6.7')).toBe('0.6.7')
    expect(normalizeVersion('vv0.6.7')).toBe('v0.6.7')
    expect(normalizeVersion('0.6.7')).toBe('0.6.7')
  })
})

describe('update version comparison', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareSemver(parseSemver('0.6.10')!, parseSemver('0.6.9')!)).toBeGreaterThan(0)
    expect(compareSemver(parseSemver('0.6.9')!, parseSemver('0.6.10')!)).toBeLessThan(0)
    expect(compareSemver(parseSemver('1.0.0')!, parseSemver('0.99.99')!)).toBeGreaterThan(0)
    expect(compareSemver(parseSemver('1.2.3')!, parseSemver('1.2.3')!)).toBe(0)
  })

  it('reports only strictly newer versions as available', () => {
    expect(isNewerVersion('0.6.8', '0.6.7')).toBe(true)
    expect(isNewerVersion('0.7.0', '0.6.9')).toBe(true)
    expect(isNewerVersion('0.6.7', '0.6.7')).toBe(false)
    expect(isNewerVersion('0.6.6', '0.6.7')).toBe(false)
    expect(isNewerVersion('0.6.8-rc.1', '0.6.7')).toBe(false)
    expect(isNewerVersion('nope', '0.6.7')).toBe(false)
  })
})

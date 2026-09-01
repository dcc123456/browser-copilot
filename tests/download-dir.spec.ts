import { describe, expect, it } from 'vitest'
import { resolveTransferMode, type SaveMode } from '../src/lib/download-dir'

const makeCase = (saveMode: SaveMode, globalAuto: boolean, hasDir: boolean) =>
  resolveTransferMode(saveMode, globalAuto, hasDir)

describe('resolveTransferMode', () => {
  it('force always auto-saves, ignoring global flag', () => {
    expect(makeCase('force', false, true)).toBe('auto')
    expect(makeCase('force', true, true)).toBe('auto')
  })
  it('force without a directory falls back to manual', () => {
    expect(makeCase('force', true, false)).toBe('manual')
  })
  it('manual always confirms', () => {
    expect(makeCase('manual', true, true)).toBe('manual')
    expect(makeCase('manual', false, false)).toBe('manual')
  })
  it('auto follows global flag AND presence of directory', () => {
    expect(makeCase('auto', true, true)).toBe('auto')
    expect(makeCase('auto', true, false)).toBe('manual')
    expect(makeCase('auto', false, true)).toBe('manual')
    expect(makeCase('auto', false, false)).toBe('manual')
  })
})
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envOverrides, maskSecret, readConfigFile, writeConfigPatch } from '../src/config-store'

describe('config store', () => {
  let dir: string
  let prevConfig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-cfg-'))
    prevConfig = process.env['BC_CONFIG']
    process.env['BC_CONFIG'] = join(dir, 'config.json')
  })

  afterEach(() => {
    if (prevConfig === undefined) delete process.env['BC_CONFIG']
    else process.env['BC_CONFIG'] = prevConfig
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes whitelisted patches, merging into existing sections', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ port: 9001, token: 'keep-me', custom: { a: 1 } }),
      'utf8',
    )
    const written = writeConfigPatch({
      token: 'changed',
      runTimeoutMs: 12_345,
      llm: { apiKey: 'sk-1', headers: { 'X-A': 'b' } },
      feishu: { botEnabled: true },
      browser: { maxConcurrent: 5 },
      evil: 'dropped',
    } as never)
    expect(written).toBe(1)

    const file = readConfigFile()
    expect(file['token']).toBe('changed')
    expect(file['runTimeoutMs']).toBe(12_345)
    expect(file['port']).toBe(9001) // not writable via the API, preserved
    expect((file['custom'] as Record<string, unknown>)['a']).toBe(1)
    expect(file['evil']).toBeUndefined()

    const llm = file['llm'] as Record<string, unknown>
    expect(llm['apiKey']).toBe('sk-1')
    expect(llm['model']).toBeUndefined() // only provided keys merge in
    expect((file['feishu'] as Record<string, unknown>)['botEnabled']).toBe(true)
    const browser = file['browser'] as Record<string, unknown>
    expect(browser['maxConcurrent']).toBe(5)
    expect(browser['mode']).toBeUndefined()
  })

  it('creates the file when missing', () => {
    expect(writeConfigPatch({ feishu: { appId: 'cli_1' } })).toBe(1)
    expect(readConfigFile()).toMatchObject({ feishu: { appId: 'cli_1' } })
  })

  it('writes nothing when the patch has no writable values', () => {
    expect(writeConfigPatch({ evil: 1, browser: { maxConcurrent: 999 } } as never)).toBe(0)
    expect(readConfigFile()).toEqual({})
  })

  it('throws on a malformed config file', () => {
    writeFileSync(join(dir, 'config.json'), '{oops', 'utf8')
    expect(() => readConfigFile()).toThrow()
  })

  it('envOverrides lists present BC_ variables', () => {
    expect(envOverrides()).not.toContain('llm.apiKey')
    process.env['BC_LLM_API_KEY'] = 'x'
    try {
      expect(envOverrides()).toContain('llm.apiKey')
    } finally {
      delete process.env['BC_LLM_API_KEY']
    }
  })

  it('maskSecret hides secret values', () => {
    expect(maskSecret('')).toEqual({ set: false, masked: '' })
    expect(maskSecret('short')).toEqual({ set: true, masked: '••••' })
    const masked = maskSecret('super-secret-token')
    expect(masked).toEqual({ set: true, masked: 'supe…oken' })
    expect(masked.masked).not.toContain('secret')
  })
})

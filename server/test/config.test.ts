import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'

const ENV_KEYS = [
  'BC_CONFIG',
  'BC_PORT',
  'BC_TOKEN',
  'BC_DATA_DIR',
  'BC_WORKFLOWS_FILE',
  'BC_BROWSER_MODE',
  'BC_CDP_ENDPOINT',
  'BC_MAX_CONCURRENT',
  'BC_LLM_BASE_URL',
  'BC_LLM_API_KEY',
  'BC_LLM_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('loadConfig', () => {
  it('falls back to defaults when no file and no env', () => {
    const config = loadConfig()
    expect(config.port).toBe(8787)
    expect(config.token).toBe('')
    expect(config.browser.mode).toBe('local')
    expect(config.browser.headless).toBe(true)
    expect(config.runTimeoutMs).toBe(600_000)
    // Relative paths resolve against the server root, not the CWD.
    expect(config.workflowsFile).toMatch(/[\\/]workflows\.json$/)
  })

  it('reads a config file and applies env overrides on top', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-config-'))
    try {
      const file = join(dir, 'config.json')
      writeFileSync(
        file,
        JSON.stringify({ port: 9999, token: 'file-secret', browser: { maxConcurrent: 5 } }),
        'utf8',
      )
      process.env['BC_CONFIG'] = file
      process.env['BC_PORT'] = '7777'
      process.env['BC_TOKEN'] = 'env-secret'

      const config = loadConfig()
      expect(config.port).toBe(7777) // env wins
      expect(config.token).toBe('env-secret') // env wins
      expect(config.browser.maxConcurrent).toBe(5) // file value kept
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when cdp mode has no endpoint', () => {
    process.env['BC_BROWSER_MODE'] = 'cdp'
    expect(() => loadConfig()).toThrow(/BC_CDP_ENDPOINT/)
  })

  it('accepts cdp mode with an endpoint', () => {
    process.env['BC_BROWSER_MODE'] = 'cdp'
    process.env['BC_CDP_ENDPOINT'] = 'ws://127.0.0.1:9222'
    expect(loadConfig().browser.cdpEndpoint).toBe('ws://127.0.0.1:9222')
  })
})

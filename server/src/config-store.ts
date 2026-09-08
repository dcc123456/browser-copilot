/**
 * Reading and writing the server's `config.json` from the Web console.
 *
 * The config file stays the single source of truth for hand-edited values:
 * `loadConfig()` always resolves `BC_*` env vars ON TOP of the file, so a
 * patch written here can be shadowed by the environment. Callers surface that
 * via {@link envOverrides} and the API marks such fields accordingly.
 *
 * Only a whitelist of fields may be written through the API — anything else
 * (port, data paths, workflows file) keeps requiring a manual edit + restart,
 * which is the safer failure mode for runner-critical settings.
 *
 * @module server/config-store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFilePath } from './config'

/** The fields the Web console may persist to `config.json`. */
export interface ConfigPatch {
  token?: string
  runTimeoutMs?: number
  browser?: {
    mode?: 'local' | 'cdp'
    cdpEndpoint?: string
    headless?: boolean
    maxConcurrent?: number
  }
  llm?: {
    baseUrl?: string
    apiKey?: string
    model?: string
    headers?: Record<string, string>
  }
  feishu?: {
    botEnabled?: boolean
    appId?: string
    appSecret?: string
    webhookUrl?: string
    webhookSecret?: string
  }
}

/** Fields whose effective value changes only after a process restart. */
export const RESTART_REQUIRED_FIELDS = ['port', 'browser.mode', 'browser.cdpEndpoint', 'browser.headless']

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

function int(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/** Whitelist-filters an untrusted patch; unknown keys are dropped silently. */
function sanitizePatch(patch: unknown): ConfigPatch {
  const src = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const out: ConfigPatch = {}
  const token = str(src['token'])
  if (token !== undefined) out.token = token
  const timeout = int(src['runTimeoutMs'], 1_000, 86_400_000)
  if (timeout !== undefined) out.runTimeoutMs = timeout

  const browser = src['browser']
  if (browser && typeof browser === 'object') {
    const b = browser as Record<string, unknown>
    const mode = str(b['mode'])
    const headless = bool(b['headless'])
    const maxConcurrent = int(b['maxConcurrent'], 1, 16)
    const cdpEndpoint = str(b['cdpEndpoint'])
    const entry: NonNullable<ConfigPatch['browser']> = {}
    if (mode === 'local' || mode === 'cdp') entry.mode = mode
    if (cdpEndpoint !== undefined) entry.cdpEndpoint = cdpEndpoint
    if (headless !== undefined) entry.headless = headless
    if (maxConcurrent !== undefined) entry.maxConcurrent = maxConcurrent
    if (Object.keys(entry).length > 0) out.browser = entry
  }

  const llm = src['llm']
  if (llm && typeof llm === 'object') {
    const l = llm as Record<string, unknown>
    const entry: NonNullable<ConfigPatch['llm']> = {}
    for (const key of ['baseUrl', 'apiKey', 'model'] as const) {
      const value = str(l[key])
      if (value !== undefined) entry[key] = value
    }
    const headers = l['headers']
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof k === 'string' && k && typeof v === 'string') clean[k] = v
      }
      entry.headers = clean
    }
    if (Object.keys(entry).length > 0) out.llm = entry
  }

  const feishu = src['feishu']
  if (feishu && typeof feishu === 'object') {
    const f = feishu as Record<string, unknown>
    const entry: NonNullable<ConfigPatch['feishu']> = {}
    const botEnabled = bool(f['botEnabled'])
    if (botEnabled !== undefined) entry.botEnabled = botEnabled
    for (const key of ['appId', 'appSecret', 'webhookUrl', 'webhookSecret'] as const) {
      const value = str(f[key])
      if (value !== undefined) entry[key] = value
    }
    if (Object.keys(entry).length > 0) out.feishu = entry
  }

  return out
}

/** The raw config file contents (`{}` when absent). Throws on malformed JSON. */
export function readConfigFile(): Record<string, unknown> {
  try {
    const raw = readFileSync(configFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    throw error
  }
}

/**
 * Persists a sanitized patch onto `config.json` (atomic tmp+rename). Returns
 * the number of keys actually written (0 when the patch contained nothing
 * writable). Does NOT reload or hot-apply — the API layer owns that.
 */
export function writeConfigPatch(patch: unknown): number {
  const clean = sanitizePatch(patch)
  if (Object.keys(clean).length === 0) return 0

  const file = readConfigFile()
  if (clean.token !== undefined) file['token'] = clean.token
  if (clean.runTimeoutMs !== undefined) file['runTimeoutMs'] = clean.runTimeoutMs
  for (const [section, entry] of Object.entries({
    browser: clean.browser,
    llm: clean.llm,
    feishu: clean.feishu,
  })) {
    if (!entry) continue
    const current = file[section]
    const base = current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}
    file[section] = { ...base, ...entry }
  }

  const path = configFilePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, path)
  return 1
}

/**
 * Which config fields the `BC_*` environment currently shadows — writing them
 * to `config.json` has no effect until the env var is removed.
 */
export function envOverrides(): string[] {
  const env = process.env
  const out: string[] = []
  if (env['BC_TOKEN']) out.push('token')
  if (env['BC_RUN_TIMEOUT_MS']) out.push('runTimeoutMs')
  if (env['BC_BROWSER_MODE']) out.push('browser.mode')
  if (env['BC_CDP_ENDPOINT']) out.push('browser.cdpEndpoint')
  if (env['BC_BROWSER_HEADLESS'] || env['BC_BROWSER_HEADED']) out.push('browser.headless')
  if (env['BC_MAX_CONCURRENT']) out.push('browser.maxConcurrent')
  if (env['BC_LLM_BASE_URL']) out.push('llm.baseUrl')
  if (env['BC_LLM_API_KEY']) out.push('llm.apiKey')
  if (env['BC_LLM_MODEL']) out.push('llm.model')
  if (env['BC_FEISHU_BOT_ENABLED']) out.push('feishu.botEnabled')
  if (env['BC_FEISHU_APP_ID']) out.push('feishu.appId')
  if (env['BC_FEISHU_APP_SECRET']) out.push('feishu.appSecret')
  if (env['BC_FEISHU_WEBHOOK_URL']) out.push('feishu.webhookUrl')
  if (env['BC_FEISHU_WEBHOOK_SECRET']) out.push('feishu.webhookSecret')
  return out
}

/** Masks a secret for API responses: `abcd…wxyz`, `••••` for short values. */
export function maskSecret(value: string): { set: boolean; masked: string } {
  if (!value) return { set: false, masked: '' }
  if (value.length <= 8) return { set: true, masked: '••••' }
  return { set: true, masked: `${value.slice(0, 4)}…${value.slice(-4)}` }
}

/** The server-root-relative default path (exported for tests/docs). */
export function defaultConfigPath(root: string): string {
  return join(root, 'config.json')
}

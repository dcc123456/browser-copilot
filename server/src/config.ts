/**
 * Server runner configuration.
 *
 * Precedence: environment variables (`BC_*`) override `config.json`, which
 * overrides the defaults below. The config file is looked up at `BC_CONFIG`
 * (when set) or `server/config.json`; `server/config.example.json` is the
 * documented template.
 *
 * @module server/config
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  headers: Record<string, string>
}

export interface BrowserConfig {
  /** `local` launches Playwright's Chromium; `cdp` connects over CDP. */
  mode: 'local' | 'cdp'
  /** CDP endpoint, e.g. `ws://127.0.0.1:9222` or a browserless URL. */
  cdpEndpoint: string
  headless: boolean
  maxConcurrent: number
}

export interface FeishuConfig {
  botEnabled: boolean
  appId: string
  appSecret: string
  /** Optional group custom-bot webhook used to push run results. */
  webhookUrl: string
  webhookSecret: string
}

export interface RunnerConfig {
  port: number
  /** Bearer token for the HTTP API; empty disables auth (LAN use only). */
  token: string
  /** Root for runs/artifacts/profiles; relative paths resolve to server/. */
  dataDir: string
  /** The extension-format workflow library file (see docs/server.md). */
  workflowsFile: string
  /** Optional extra directory of `*.json` workflow files merged in. */
  workflowsExtraDir: string
  browser: BrowserConfig
  llm: LlmConfig
  feishu: FeishuConfig
  /** Hard wall-clock budget per run. */
  runTimeoutMs: number
}

const DEFAULTS: RunnerConfig = {
  port: 8787,
  token: '',
  dataDir: 'data',
  workflowsFile: 'workflows.json',
  workflowsExtraDir: 'workflows.d',
  browser: { mode: 'local', cdpEndpoint: '', headless: true, maxConcurrent: 2 },
  llm: { baseUrl: '', apiKey: '', model: '', headers: {} },
  feishu: { botEnabled: false, appId: '', appSecret: '', webhookUrl: '', webhookSecret: '' },
  runTimeoutMs: 600_000,
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Deep-merges a partial JSON object onto a base, mutating and returning it. */
function mergeInto<T>(base: Mutable<T>, patch: unknown): Mutable<T> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      mergeInto(current, value)
    } else if (value !== undefined) {
      ;(base as Record<string, unknown>)[key] = value
    }
  }
  return base
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function bool(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Applies the `BC_*` environment overrides onto the config. */
function applyEnv(config: Mutable<RunnerConfig>): void {
  const env = process.env
  const port = Number(env['BC_PORT'])
  if (Number.isFinite(port) && port > 0) config.port = Math.floor(port)
  const token = str(env['BC_TOKEN'])
  if (token !== undefined) config.token = token
  const dataDir = str(env['BC_DATA_DIR'])
  if (dataDir !== undefined) config.dataDir = dataDir
  const workflowsFile = str(env['BC_WORKFLOWS_FILE'])
  if (workflowsFile !== undefined) config.workflowsFile = workflowsFile
  const workflowsExtraDir = env['BC_WORKFLOWS_EXTRA_DIR']
  if (typeof workflowsExtraDir === 'string') config.workflowsExtraDir = workflowsExtraDir
  const timeout = Number(env['BC_RUN_TIMEOUT_MS'])
  if (Number.isFinite(timeout) && timeout > 0) config.runTimeoutMs = timeout

  const mode = str(env['BC_BROWSER_MODE'])
  if (mode === 'local' || mode === 'cdp') config.browser.mode = mode
  const cdp = env['BC_CDP_ENDPOINT']
  if (typeof cdp === 'string' && cdp) config.browser.cdpEndpoint = cdp
  const headless = bool(env['BC_BROWSER_HEADED'] === '1' ? 'false' : env['BC_BROWSER_HEADLESS'])
  if (headless !== undefined) config.browser.headless = headless
  const maxConcurrent = Number(env['BC_MAX_CONCURRENT'])
  if (Number.isFinite(maxConcurrent) && maxConcurrent > 0)
    config.browser.maxConcurrent = Math.floor(maxConcurrent)

  const baseUrl = str(env['BC_LLM_BASE_URL'])
  if (baseUrl !== undefined) config.llm.baseUrl = baseUrl
  const apiKey = str(env['BC_LLM_API_KEY'])
  if (apiKey !== undefined) config.llm.apiKey = apiKey
  const model = str(env['BC_LLM_MODEL'])
  if (model !== undefined) config.llm.model = model

  const botEnabled = bool(env['BC_FEISHU_BOT_ENABLED'])
  if (botEnabled !== undefined) config.feishu.botEnabled = botEnabled
  const appId = str(env['BC_FEISHU_APP_ID'])
  if (appId !== undefined) config.feishu.appId = appId
  const appSecret = str(env['BC_FEISHU_APP_SECRET'])
  if (appSecret !== undefined) config.feishu.appSecret = appSecret
  const webhookUrl = str(env['BC_FEISHU_WEBHOOK_URL'])
  if (webhookUrl !== undefined) config.feishu.webhookUrl = webhookUrl
  const webhookSecret = env['BC_FEISHU_WEBHOOK_SECRET']
  if (typeof webhookSecret === 'string') config.feishu.webhookSecret = webhookSecret
}

/** Loads the runner config from disk + environment. Throws on a malformed file. */
export function loadConfig(): RunnerConfig {
  const config = structuredClone(DEFAULTS) as Mutable<RunnerConfig>

  const configPath = process.env['BC_CONFIG']
    ? resolve(process.env['BC_CONFIG'])
    : join(SERVER_ROOT, 'config.json')
  try {
    const raw = readFileSync(configPath, 'utf8')
    mergeInto(config, JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error(`Malformed config file ${configPath}: ${(error as Error).message}`)
    }
    // No config file — env + defaults only. That is a valid setup.
  }
  applyEnv(config)

  // Relative paths resolve against the server root so the process CWD is
  // irrelevant (Docker, systemd and terminals disagree about CWD).
  if (!isAbsolute(config.dataDir)) config.dataDir = join(SERVER_ROOT, config.dataDir)
  if (!isAbsolute(config.workflowsFile)) config.workflowsFile = join(SERVER_ROOT, config.workflowsFile)
  if (config.workflowsExtraDir && !isAbsolute(config.workflowsExtraDir))
    config.workflowsExtraDir = join(SERVER_ROOT, config.workflowsExtraDir)

  if (config.browser.mode === 'cdp' && !config.browser.cdpEndpoint) {
    throw new Error('BC_BROWSER_MODE=cdp requires BC_CDP_ENDPOINT (e.g. ws://127.0.0.1:9222)')
  }
  return config
}

/** The server root directory (used by modules that need sibling paths). */
export function serverRoot(): string {
  return SERVER_ROOT
}

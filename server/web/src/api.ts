/**
 * Typed API client for the runner's HTTP API.
 *
 * The bearer token lives in localStorage (entered once on the login screen);
 * every request carries it. A 401 clears it and bounces back to login.
 */

const TOKEN_KEY = 'bc-runner-token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(value: string): void {
  if (value) localStorage.setItem(TOKEN_KEY, value)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; missing?: string[]; hint?: string; reason?: string } | null,
  ) {
    super(body?.error ?? `HTTP ${status}`)
  }
}

let onUnauthorized: (() => void) | null = null

/** Registers the 401 handler (wired once from the app shell). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

async function request<T>(method: string, path: string, json?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['authorization'] = `Bearer ${token}`
  if (json !== undefined) headers['content-type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    })
  } catch (error) {
    throw new ApiError(0, { error: `无法连接服务器：${(error as Error).message}` })
  }

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: text.slice(0, 300) }
    }
  }

  if (response.status === 401) {
    setToken('')
    onUnauthorized?.()
    throw new ApiError(401, body as never)
  }
  if (!response.ok) throw new ApiError(response.status, body as never)
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, json?: unknown) => request<T>('POST', path, json),
  put: <T>(path: string, json: unknown) => request<T>('PUT', path, json),
  del: <T>(path: string) => request<T>('DELETE', path),
}

// --- Shared response shapes ---------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled'
export type TriggerKind = 'manual' | 'interval' | 'specific-day' | 'date' | 'scheduled'

export interface RunStep {
  at: number
  kind: string
  text: string
}

export interface RunRecord {
  id: string
  workflowId?: string
  label: string
  source: string
  status: RunStatus
  profile?: string
  startedAt?: number
  finishedAt?: number
  summary?: string
  error?: string
  steps?: RunStep[]
}

export interface MaskedSecret {
  set: boolean
  masked: string
}

export interface ConfigView {
  port: number
  runTimeoutMs: number
  token: MaskedSecret
  browser: { mode: 'local' | 'cdp'; cdpEndpoint: string; headless: boolean; maxConcurrent: number }
  llm: { baseUrl: string; model: string; apiKey: MaskedSecret; headers: string[] }
  feishu: {
    botEnabled: boolean
    appId: string
    webhookUrl: string
    appSecret: MaskedSecret
    webhookSecret: MaskedSecret
  }
}

export interface ConfigResponse {
  config: ConfigView
  envOverrides: string[]
  feishuConnected: boolean
  restartRequired: string[]
}

export interface ScheduleEntry {
  workflowId: string
  name: string
  kind: TriggerKind
  detail: string
  enabled: boolean
  armed: boolean
  nextRunAt?: string
}

export interface WorkflowListItem {
  id: string
  name: string
  description?: string
  updatedAt: number
}

export interface ImportEntryResult {
  index: number
  id: string
  name: string
  ok: boolean
  error?: string
  warnings: string[]
  missing: string[]
}

export interface ImportResult {
  imported: number
  skipped: number
  entries: ImportEntryResult[]
}

export interface WorkflowReference {
  nodeId: string
  nodeLabel: string
  childId: string
}

export interface ReferenceReport {
  id: string
  name: string
  references: WorkflowReference[]
  missing: string[]
  cycles: string[][]
}

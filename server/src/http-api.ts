/**
 * The runner's HTTP API (Fastify).
 *
 * Auth: when `config.token` is set, every `/api/*` route requires
 * `Authorization: Bearer <token>`. The comparison is timing-safe and there is
 * NO query-string fallback (`?token=`) — URLs leak into access logs, browser
 * history and Referer headers, so a token must never travel in one. Static
 * console assets (`/`, `/assets/*`) are served WITHOUT auth: the page is just
 * a login shell that collects the token from the operator. Booting with no
 * token is refused by `main.ts` unless `BC_ALLOW_UNAUTHENTICATED=1` is set
 * (see main.ts), so an accidentally-open API is not possible by default.
 *
 * Cross-cutting concerns live here too: CORS (localhost by default, overridable
 * via `BC_CORS_ORIGIN`), per-IP rate limiting (`BC_RATE_LIMIT_MAX` /
 * `BC_RATE_LIMIT_WINDOW`), zod-validated request bodies (invalid input is a
 * structured 400, never a 500) and request/response logging with a propagated
 * request id.
 *
 * @module server/http-api
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import type { Workflow } from '../../src/lib/workflow/types'
import { sendWebhookText } from '../../src/lib/feishu'
import { streamCompletion, type WireMessage } from '../../src/lib/llm'
import type { RunnerConfig } from './config'
import { loadConfig } from './config'
import { envOverrides, maskSecret, RESTART_REQUIRED_FIELDS, writeConfigPatch } from './config-store'
import { logger } from './observability'
import type { RunService } from './run-service'
import { MissingWorkflowError } from './run-service'
import type { ScheduleEntry } from './scheduler'
import type { WorkflowLibrary } from './workflow-library'

// --- Request schemas ----------------------------------------------------------

const jsonObject = z.record(z.string(), z.unknown())

const runBodySchema = z.looseObject({
  workflowId: z.string().min(1).optional(),
  workflow: jsonObject.optional(),
  variables: jsonObject.optional(),
  profile: z.string().optional(),
  proxy: z
    .looseObject({
      server: z.string().min(1),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  source: z.enum(['api', 'cron', 'webhook', 'feishu']).optional(),
})

const hookParamsSchema = z.looseObject({ workflowId: z.string().min(1) })

const hookBodySchema = z.looseObject({ variables: jsonObject.optional() })

const configPatchSchema = z.looseObject({
  token: z.string().optional(),
  runTimeoutMs: z.coerce.number().int().min(1_000).max(86_400_000).optional(),
  browser: z
    .looseObject({
      mode: z.enum(['local', 'cdp']).optional(),
      cdpEndpoint: z.string().optional(),
      headless: z.boolean().optional(),
      maxConcurrent: z.coerce.number().int().min(1).max(16).optional(),
    })
    .optional(),
  llm: z
    .looseObject({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  feishu: z
    .looseObject({
      botEnabled: z.boolean().optional(),
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      webhookUrl: z.string().optional(),
      webhookSecret: z.string().optional(),
    })
    .optional(),
})

/** Flattens zod issues into the `details` array of a 400 response. */
function issueDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

/** The single shape every validation failure returns: `{ error, details }`. */
function invalidInput(reply: FastifyReply, error: string, details: unknown): FastifyReply {
  return reply.code(400).send({ error, details })
}

/**
 * Constant-time string comparison. `timingSafeEqual` throws when the buffers
 * differ in length, so the length is checked first; only the length (not the
 * contents) is allowed to leak, which is unavoidable for a hash-free compare.
 */
function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/**
 * Resolves whether a request origin may be reflected by CORS.
 *
 * `BC_CORS_ORIGIN=*` allows everything; a comma-separated list allow-lists
 * exact origins; with no override only localhost/127.0.0.1/[::1] are reflected.
 * Requests without an Origin header (curl, same-origin, the SPA served by the
 * runner itself) are always allowed.
 */
async function corsOrigin(origin: string | undefined): Promise<boolean> {
  if (origin === undefined) return true
  const configured = process.env['BC_CORS_ORIGIN']
  if (configured === '*') return true
  if (configured && configured.trim().length > 0) {
    return configured
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .includes(origin)
  }
  return LOCALHOST_ORIGIN.test(origin)
}

export function buildHttpApi(opts: {
  config: RunnerConfig
  library: WorkflowLibrary
  runs: RunService
  onLibraryChanged: () => void
  /** Re-applies side-effect services (Feishu bot) after a config change. */
  onConfigChanged?: () => void
  /** Feishu long-connection status for the console's settings page. */
  feishuConnected?: () => boolean
  /** Combined armed/disabled schedule view for the console. */
  schedulesOverview?: () => ScheduleEntry[]
}): FastifyInstance {
  const app = Fastify({
    // The shared pino instance is passed as `loggerInstance` (Fastify v5's
    // `logger` option only accepts a config object). Fastify's own request
    // logging is disabled because the hooks below emit exactly one line per
    // request with the fields we care about.
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => {
      const header = request.headers['x-request-id']
      return typeof header === 'string' && header.length > 0 ? header : randomUUID()
    },
  })
  const { config, library, runs } = opts

  // --- Cross-cutting middleware -------------------------------------------------

  void app.register(cors, { origin: corsOrigin, credentials: false })

  const rateMax = Number(process.env['BC_RATE_LIMIT_MAX'])
  const rateWindow = process.env['BC_RATE_LIMIT_WINDOW'] ?? '1 minute'
  void app.register(rateLimit, {
    max: Number.isFinite(rateMax) && rateMax > 0 ? rateMax : 300,
    timeWindow: rateWindow,
  })

  const startedAt = new WeakMap<FastifyRequest, bigint>()

  app.addHook('onRequest', async (request) => {
    startedAt.set(request, process.hrtime.bigint())
    request.log.info(
      { method: request.method, url: request.url, reqId: request.id },
      'request started',
    )
  })

  // Auth runs in `preHandler`, not `onRequest`: the rate-limit plugin also
  // registers an `onRequest` hook, and root hooks added here execute before it.
  // Rejecting in `preHandler` guarantees unauthenticated brute-force attempts
  // are still counted and throttled (401 ×N then 429) instead of bypassing the
  // limiter. Body parsing happens first, so a malformed body on an
  // unauthenticated request is a 400 rather than a 401 — acceptable, as it
  // reveals nothing about the token.
  app.addHook('preHandler', async (request, reply) => {
    // CORS preflight carries no Authorization header; let @fastify/cors answer it.
    if (request.method === 'OPTIONS') return
    if (!config.token || request.url === '/healthz' || request.url.startsWith('/healthz?')) return
    // Only the JSON API is protected; the static console loads without auth.
    if (!request.url.startsWith('/api')) return
    const header = request.headers.authorization
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!presented || !timingSafeEquals(presented, config.token)) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  app.addHook('onResponse', async (request, reply) => {
    const start = startedAt.get(request)
    const durationMs =
      start === undefined ? undefined : Number(process.hrtime.bigint() - start) / 1e6
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs,
        reqId: request.id,
      },
      'request completed',
    )
  })

  app.setErrorHandler<Error & { statusCode?: number }>((error, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500
    request.log.error({ err: error, statusCode, reqId: request.id }, 'request failed')
    if (reply.sent) return
    if (statusCode >= 500) {
      return reply.code(statusCode).send({ error: 'Internal Server Error' })
    }
    return reply.code(statusCode).send({ error: error.message, details: { name: error.name } })
  })

  app.get('/healthz', async () => ({ ok: true }))

  // --- Workflows ----------------------------------------------------------------

  app.get('/api/workflows', async () => {
    return {
      workflows: library.list().map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        updatedAt: workflow.updatedAt,
      })),
      cycles: library.allCycles(),
    }
  })

  app.get('/api/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const workflow = library.get(id)
    if (!workflow) return reply.code(404).send({ error: `Workflow ${id} not found` })
    return { workflow, report: library.reportFor(id) }
  })

  app.get('/api/workflows/:id/references', async (request, reply) => {
    const { id } = request.params as { id: string }
    const report = library.reportFor(id)
    if (!report) return reply.code(404).send({ error: `Workflow ${id} not found` })
    return {
      id,
      name: report.workflow.name,
      references: report.references,
      missing: report.missing,
      cycles: report.cycles,
    }
  })

  app.put('/api/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Partial<Workflow> | undefined
    if (!body || typeof body !== 'object')
      return reply.code(400).send({ error: 'Body must be a workflow JSON object' })
    const stored = library.upsert({ ...(body as Workflow), id })
    opts.onLibraryChanged()
    return { workflow: stored, report: library.reportFor(id) }
  })

  app.post('/api/workflows/import', async (request) => {
    const result = library.importPayload(request.body)
    opts.onLibraryChanged()
    return result
  })

  app.post('/api/workflows/reload', async () => {
    library.load()
    opts.onLibraryChanged()
    return { ok: true, count: library.list().length }
  })

  app.delete('/api/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = library.remove(id)
    if (!result.ok) {
      const status = result.reason === 'not-found' ? 404 : 409
      const error =
        result.reason === 'not-found'
          ? `Workflow ${id} not found`
          : `工作流 ${id} 来自 workflows.d 额外目录，请在服务器上删除对应 json 文件后 POST /api/workflows/reload`
      return reply.code(status).send({ error, reason: result.reason })
    }
    opts.onLibraryChanged()
    return { ok: true, id }
  })

  // --- Runs ---------------------------------------------------------------------

  app.post('/api/runs', async (request, reply) => {
    const parsed = runBodySchema.safeParse(request.body ?? {})
    if (!parsed.success)
      return invalidInput(reply, 'Invalid run request', issueDetails(parsed.error))
    const body = parsed.data
    let workflow: Workflow | undefined
    let workflowId: string | undefined

    if (body.workflowId) {
      workflow = library.get(body.workflowId)
      if (!workflow) return reply.code(404).send({ error: `Workflow ${body.workflowId} not found` })
      workflowId = body.workflowId
    } else if (body.workflow) {
      workflow = body.workflow as unknown as Workflow
    } else {
      return invalidInput(reply, 'Provide `workflowId` or an inline `workflow` JSON', [
        { path: 'workflowId', message: 'workflowId or workflow is required' },
      ])
    }

    try {
      const runId = runs.start({
        workflow,
        ...(workflowId ? { workflowId } : {}),
        source: body.source ?? 'api',
        ...(body.variables ? { variables: body.variables } : {}),
        ...(body.profile ? { profile: body.profile } : {}),
        ...(body.proxy ? { proxy: body.proxy } : {}),
      })
      return reply.code(202).send({ runId, status: 'queued' })
    } catch (error) {
      if (error instanceof MissingWorkflowError) {
        return reply.code(422).send({
          error: error.message,
          missing: error.missing,
          hint: '被引用的子工作流不在服务器工作流库中：把包含它们的 workflows.json 一并导入（POST /api/workflows/import），或用 GET /api/workflows/:id/references 查看完整引用树。',
        })
      }
      throw error
    }
  })

  app.get('/api/runs', async () => {
    return {
      runs: runs.list().map((run) => ({ ...run, steps: undefined })),
    }
  })

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const run = runs.get(id)
    if (!run) return reply.code(404).send({ error: `Run ${id} not found` })
    return run
  })

  app.delete('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const cancelled = runs.cancel(id)
    if (!cancelled)
      return reply
        .code(409)
        .send({ error: `Run ${id} is not cancellable (unknown or already finished)` })
    return { ok: true }
  })

  // --- Webhook trigger ------------------------------------------------------------

  app.post('/api/hooks/:workflowId', async (request, reply) => {
    const params = hookParamsSchema.safeParse(request.params)
    if (!params.success)
      return invalidInput(reply, 'Invalid hook request', issueDetails(params.error))
    const { workflowId } = params.data
    const body = hookBodySchema.safeParse(request.body ?? {})
    if (!body.success) return invalidInput(reply, 'Invalid hook body', issueDetails(body.error))
    const workflow = library.get(workflowId)
    if (!workflow) return reply.code(404).send({ error: `Workflow ${workflowId} not found` })
    try {
      const runId = runs.start({
        workflow,
        workflowId,
        source: 'webhook',
        ...(body.data.variables ? { variables: body.data.variables } : {}),
      })
      return reply.code(202).send({ runId, status: 'queued' })
    } catch (error) {
      if (error instanceof MissingWorkflowError) {
        return reply.code(422).send({ error: error.message, missing: error.missing })
      }
      throw error
    }
  })

  // --- Config (Web console) ------------------------------------------------------

  /** The config as the console sees it: secrets masked, headers key-only. */
  function maskedConfig() {
    return {
      port: config.port,
      runTimeoutMs: config.runTimeoutMs,
      token: maskSecret(config.token),
      browser: { ...config.browser },
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKey: maskSecret(config.llm.apiKey),
        headers: Object.keys(config.llm.headers),
      },
      feishu: {
        botEnabled: config.feishu.botEnabled,
        appId: config.feishu.appId,
        webhookUrl: config.feishu.webhookUrl,
        appSecret: maskSecret(config.feishu.appSecret),
        webhookSecret: maskSecret(config.feishu.webhookSecret),
      },
    }
  }

  app.get('/api/config', async () => {
    return {
      config: maskedConfig(),
      envOverrides: envOverrides(),
      feishuConnected: opts.feishuConnected?.() ?? false,
      restartRequired: RESTART_REQUIRED_FIELDS,
    }
  })

  app.put('/api/config', async (request, reply) => {
    const parsed = configPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success)
      return invalidInput(reply, 'Invalid config patch', issueDetails(parsed.error))
    const body = parsed.data
    // Reject a cdp switch that would leave the runner unlaunchable on restart.
    if (body.browser?.mode === 'cdp') {
      const endpoint = body.browser.cdpEndpoint ?? config.browser.cdpEndpoint
      if (!endpoint && !process.env['BC_CDP_ENDPOINT']) {
        return invalidInput(reply, '切换到 cdp 模式需要同时填写 cdpEndpoint', [
          { path: 'browser.cdpEndpoint', message: 'cdpEndpoint is required when mode is cdp' },
        ])
      }
    }

    const written = writeConfigPatch(body)
    // Reload with env applied, then hot-apply onto the SHARED config object —
    // the auth hook and RunService read it live. Restart-only fields
    // (port/browser.mode/cdpEndpoint/headless) are intentionally untouched.
    let reloaded
    try {
      reloaded = loadConfig()
    } catch (error) {
      return reply.code(400).send({ error: `配置已保存但无法生效：${(error as Error).message}` })
    }
    config.token = reloaded.token
    config.runTimeoutMs = reloaded.runTimeoutMs
    config.llm = reloaded.llm
    config.feishu = reloaded.feishu
    config.browser.maxConcurrent = reloaded.browser.maxConcurrent
    opts.onConfigChanged?.()

    return {
      ok: true,
      written: written > 0,
      config: maskedConfig(),
      envOverrides: envOverrides(),
      restartRequired: RESTART_REQUIRED_FIELDS,
    }
  })

  app.post('/api/config/test-llm', async (request, reply) => {
    const { apiKey, baseUrl, model, headers } = config.llm
    if (!apiKey || !baseUrl || !model) {
      return reply.code(400).send({
        ok: false,
        error:
          '未配置完整模型：需要 llm.baseUrl / llm.apiKey / llm.model（或对应 BC_LLM_* 环境变量）',
      })
    }
    const started = Date.now()
    try {
      const result = await streamCompletion({
        apiKey,
        baseUrl,
        model,
        messages: [{ role: 'user', content: '只回复两个字：OK' } satisfies WireMessage],
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal: AbortSignal.timeout(15_000),
      })
      return {
        ok: true,
        latencyMs: Date.now() - started,
        sample: String(result.content).slice(0, 120),
      }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: (error as Error).message }
    }
  })

  app.post('/api/config/test-feishu', async (request, reply) => {
    if (config.feishu.webhookUrl) {
      try {
        const result = await sendWebhookText(
          config.feishu.webhookUrl,
          'Browser Copilot runner 测试消息（来自 Web 控制台）',
          config.feishu.webhookSecret,
        )
        return { ok: result.ok, via: 'webhook', status: result.status, body: result.body }
      } catch (error) {
        return { ok: false, via: 'webhook', error: (error as Error).message }
      }
    }
    if (config.feishu.botEnabled) {
      const connected = opts.feishuConnected?.() ?? false
      return {
        ok: connected,
        via: 'long-connection',
        hint: connected
          ? '长连接机器人已在线；在飞书私聊机器人发送 /help 验证命令。'
          : '长连接未建立：检查 appId/appSecret 是否正确、应用是否开启长连接模式，并查看服务启动日志。',
      }
    }
    return reply
      .code(400)
      .send({ ok: false, error: '未配置飞书：请填写 webhookUrl，或启用机器人（appId/appSecret）' })
  })

  // --- Schedules (Web console) ---------------------------------------------------

  app.get('/api/schedules', async () => {
    return { schedules: opts.schedulesOverview?.() ?? [] }
  })

  return app
}

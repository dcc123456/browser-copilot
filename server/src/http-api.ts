/**
 * The runner's HTTP API (Fastify).
 *
 * Auth: when `config.token` is set, every `/api/*` route requires
 * `Authorization: Bearer <token>` — webhooks that cannot set headers may pass
 * `?token=` instead. Static console assets (`/`, `/assets/*`) are served
 * WITHOUT auth: the page is just a login shell that collects the token from
 * the operator. With no token configured the API is open; the server warns at
 * startup and the docs recommend LAN-only use.
 *
 * @module server/http-api
 */

import Fastify, { type FastifyInstance } from 'fastify'
import type { Workflow } from '../../src/lib/workflow/types'
import { sendWebhookText } from '../../src/lib/feishu'
import { streamCompletion, type WireMessage } from '../../src/lib/llm'
import type { RunnerConfig } from './config'
import { loadConfig } from './config'
import {
  envOverrides,
  maskSecret,
  RESTART_REQUIRED_FIELDS,
  writeConfigPatch,
} from './config-store'
import type { RunService, RunSource } from './run-service'
import { MissingWorkflowError } from './run-service'
import type { ScheduleEntry } from './scheduler'
import type { WorkflowLibrary } from './workflow-library'

interface RunBody {
  workflowId?: string
  workflow?: Workflow
  variables?: Record<string, unknown>
  profile?: string
  proxy?: { server: string; username?: string; password?: string }
  source?: RunSource
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
  const app = Fastify({ logger: false })
  const { config, library, runs } = opts

  app.addHook('onRequest', async (request, reply) => {
    if (!config.token || request.url === '/healthz' || request.url.startsWith('/healthz?')) return
    // Only the JSON API is protected; the static console loads without auth.
    if (!request.url.startsWith('/api')) return
    const authorized =
      request.headers.authorization === `Bearer ${config.token}` ||
      (request.query as Record<string, unknown>)['token'] === config.token
    if (!authorized) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
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
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'Body must be a workflow JSON object' })
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
    const body = (request.body ?? {}) as RunBody
    let workflow: Workflow | undefined
    let workflowId: string | undefined

    if (typeof body.workflowId === 'string' && body.workflowId) {
      workflow = library.get(body.workflowId)
      if (!workflow) return reply.code(404).send({ error: `Workflow ${body.workflowId} not found` })
      workflowId = body.workflowId
    } else if (body.workflow && typeof body.workflow === 'object') {
      workflow = body.workflow
    } else {
      return reply.code(400).send({ error: 'Provide `workflowId` or an inline `workflow` JSON' })
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
    if (!cancelled) return reply.code(409).send({ error: `Run ${id} is not cancellable (unknown or already finished)` })
    return { ok: true }
  })

  // --- Webhook trigger ------------------------------------------------------------

  app.post('/api/hooks/:workflowId', async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string }
    const workflow = library.get(workflowId)
    if (!workflow) return reply.code(404).send({ error: `Workflow ${workflowId} not found` })
    const body = (request.body ?? {}) as { variables?: Record<string, unknown> }
    try {
      const runId = runs.start({
        workflow,
        workflowId,
        source: 'webhook',
        ...(body.variables ? { variables: body.variables } : {}),
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
    const body = (request.body ?? {}) as {
      browser?: { mode?: string; cdpEndpoint?: string }
    }
    // Reject a cdp switch that would leave the runner unlaunchable on restart.
    if (body.browser?.mode === 'cdp') {
      const endpoint = body.browser.cdpEndpoint ?? config.browser.cdpEndpoint
      if (!endpoint && !process.env['BC_CDP_ENDPOINT']) {
        return reply.code(400).send({ error: '切换到 cdp 模式需要同时填写 cdpEndpoint' })
      }
    }

    const written = writeConfigPatch(request.body)
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
        error: '未配置完整模型：需要 llm.baseUrl / llm.apiKey / llm.model（或对应 BC_LLM_* 环境变量）',
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
      return { ok: true, latencyMs: Date.now() - started, sample: String(result.content).slice(0, 120) }
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
    return reply.code(400).send({ ok: false, error: '未配置飞书：请填写 webhookUrl，或启用机器人（appId/appSecret）' })
  })

  // --- Schedules (Web console) ---------------------------------------------------

  app.get('/api/schedules', async () => {
    return { schedules: opts.schedulesOverview?.() ?? [] }
  })

  return app
}

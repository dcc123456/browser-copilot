/**
 * The runner's HTTP API (Fastify).
 *
 * Auth: when `config.token` is set, every route except `/healthz` requires
 * `Authorization: Bearer <token>` — webhooks that cannot set headers may pass
 * `?token=` instead. With no token configured the API is open; the server
 * warns at startup and the docs recommend LAN-only use.
 *
 * @module server/http-api
 */

import Fastify, { type FastifyInstance } from 'fastify'
import type { Workflow } from '../../src/lib/workflow/types'
import type { RunnerConfig } from './config'
import type { RunService, RunSource } from './run-service'
import { MissingWorkflowError } from './run-service'
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
}): FastifyInstance {
  const app = Fastify({ logger: false })
  const { config, library, runs } = opts

  app.addHook('onRequest', async (request, reply) => {
    if (!config.token || request.url === '/healthz' || request.url.startsWith('/healthz?')) return
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

  return app
}

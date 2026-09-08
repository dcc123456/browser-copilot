import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHttpApi } from '../src/http-api'
import { loadConfig } from '../src/config'
import { WorkflowLibrary } from '../src/workflow-library'
import { RunService } from '../src/run-service'
import { BrowserPool } from '../src/browser-pool'
import type { FastifyInstance } from 'fastify'

function makeWorkflow(id: string, name: string, children: string[] = []): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [
    { id: 't1', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
  ]
  children.forEach((childId, index) => {
    nodes.push({
      id: `sub-${index}`,
      label: 'execute-workflow',
      position: { x: 100 + index * 40, y: 0 },
      data: { blockId: 'execute-workflow', values: { workflowId: childId } },
    })
  })
  const chain = ['t1', ...children.map((_, index) => `sub-${index}`)]
  const edges = chain
    .slice(0, -1)
    .map((source, i) => ({ id: `e-${i}`, source, target: chain[i + 1] }))
  return { id, name, drawflow: { nodes, edges } }
}

let dir: string
let app: FastifyInstance
let library: WorkflowLibrary
let runs: RunService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-api-'))
  const config = {
    ...loadConfig(),
    dataDir: dir,
    workflowsFile: join(dir, 'workflows.json'),
    workflowsExtraDir: '',
    token: '',
  }
  library = new WorkflowLibrary(config.workflowsFile)
  library.load()
  runs = new RunService(config, new BrowserPool(config), library)
  app = buildHttpApi({ config, library, runs, onLibraryChanged: () => {} })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('http api', () => {
  it('exposes healthz without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('lists imported workflows with cycle report', async () => {
    library.importPayload([makeWorkflow('a', 'A'), makeWorkflow('b', 'B', ['a'])])
    const res = await app.inject({ method: 'GET', url: '/api/workflows' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.workflows).toHaveLength(2)
    expect(body.cycles).toEqual([])
  })

  it('returns the full reference report for a workflow', async () => {
    // Only `parent` is imported: BOTH of its children are missing.
    library.importPayload(makeWorkflow('parent', '父', ['child', 'ghost']))
    const res = await app.inject({ method: 'GET', url: '/api/workflows/parent/references' })
    const body = res.json()
    expect(body.references.map((r: { childId: string }) => r.childId).sort()).toEqual(['child', 'ghost'])
    expect(body.missing.sort()).toEqual(['child', 'ghost'])
  })

  it('404s for unknown workflow ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows/nope/references' })
    expect(res.statusCode).toBe(404)
  })

  it('refuses to run a workflow whose children are missing (422 + copy hint)', async () => {
    library.importPayload(makeWorkflow('lone', '孤立', ['ghost-1']))
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workflowId: 'lone' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().missing).toEqual(['ghost-1'])
    expect(res.json().hint).toContain('/api/workflows/import')
  })

  it('accepts an inline workflow run (no library id required)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workflow: makeWorkflow('inline-1', '内联') },
    })
    expect(res.statusCode).toBe(202)
    const { runId } = res.json()
    // The queued run record exists and references nothing missing.
    const run = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
    expect(run.statusCode).toBe(200)
    expect(['queued', 'running', 'failed']).toContain(run.json().status)
  })

  it('imports via POST /api/workflows/import and returns per-entry results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/import',
      payload: { workflows: [makeWorkflow('c1', '子'), makeWorkflow('p1', '父', ['c1', 'gone'])] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.imported).toBe(2)
    expect(body.entries[1]?.missing).toEqual(['gone'])
  })

  it('upserts via PUT /api/workflows/:id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflows/w9',
      payload: makeWorkflow('ignored-id', '重命名'),
    })
    expect(res.statusCode).toBe(200)
    expect(library.get('w9')?.name).toBe('重命名')
  })

  it('requires a bearer token when configured (webhook ?token= also works)', async () => {
    const config = {
      ...loadConfig(),
      dataDir: dir,
      workflowsFile: join(dir, 'workflows.json'),
      token: 'sekret',
    }
    const lib2 = new WorkflowLibrary(config.workflowsFile)
    lib2.load()
    const runs2 = new RunService(config, new BrowserPool(config), lib2)
    const secured = buildHttpApi({ config, library: lib2, runs: runs2, onLibraryChanged: () => {} })

    const denied = await secured.inject({ method: 'GET', url: '/api/workflows' })
    expect(denied.statusCode).toBe(401)

    const header = await secured.inject({
      method: 'GET',
      url: '/api/workflows',
      headers: { authorization: 'Bearer sekret' },
    })
    expect(header.statusCode).toBe(200)

    const query = await secured.inject({ method: 'GET', url: '/api/workflows?token=sekret' })
    expect(query.statusCode).toBe(200)

    // /healthz stays open even with a token configured.
    const health = await secured.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)
    await secured.close()
  })
})

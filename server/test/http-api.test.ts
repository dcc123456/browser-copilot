import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('serves non-API paths (console shell) without auth even when a token is set', async () => {
    const config = { ...loadConfig(), dataDir: dir, workflowsFile: join(dir, 'workflows.json'), token: 'sekret' }
    const lib2 = new WorkflowLibrary(config.workflowsFile)
    lib2.load()
    const runs2 = new RunService(config, new BrowserPool(config), lib2)
    const secured = buildHttpApi({ config, library: lib2, runs: runs2, onLibraryChanged: () => {} })
    // No static plugin mounted in unit tests → 404, but NEVER 401: the console
    // shell must load so the operator can type the token.
    const root = await secured.inject({ method: 'GET', url: '/' })
    expect(root.statusCode).not.toBe(401)
    await secured.close()
  })

  it('deletes a primary workflow via DELETE /api/workflows/:id', async () => {
    library.importPayload(makeWorkflow('del-1', '待删除'))
    const ok = await app.inject({ method: 'DELETE', url: '/api/workflows/del-1' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().id).toBe('del-1')
    const gone = await app.inject({ method: 'GET', url: '/api/workflows/del-1' })
    expect(gone.statusCode).toBe(404)
    const repeat = await app.inject({ method: 'DELETE', url: '/api/workflows/del-1' })
    expect(repeat.statusCode).toBe(404)
  })

  it('refuses to delete extra-dir workflows (409 with hint)', async () => {
    const extra = join(dir, 'extra')
    mkdirSync(extra, { recursive: true })
    writeFileSync(join(extra, 'e.json'), JSON.stringify([makeWorkflow('extra-1', '额外')]), 'utf8')
    const config = {
      ...loadConfig(),
      dataDir: dir,
      workflowsFile: join(dir, 'wf.json'),
      workflowsExtraDir: extra,
      token: '',
    }
    const lib2 = new WorkflowLibrary(config.workflowsFile, extra)
    lib2.load()
    const runs2 = new RunService(config, new BrowserPool(config), lib2)
    const app2 = buildHttpApi({ config, library: lib2, runs: runs2, onLibraryChanged: () => {} })
    const res = await app2.inject({ method: 'DELETE', url: '/api/workflows/extra-1' })
    expect(res.statusCode).toBe(409)
    expect(res.json().reason).toBe('extra-source')
    expect(res.json().error).toContain('workflows.d')
    expect(lib2.get('extra-1')).toBeDefined() // untouched
    await app2.close()
  })

  it('masks secrets in GET /api/config', async () => {
    const config = { ...loadConfig(), dataDir: dir, workflowsFile: join(dir, 'wf.json'), token: 'super-secret-token' }
    const lib2 = new WorkflowLibrary(config.workflowsFile)
    lib2.load()
    const runs2 = new RunService(config, new BrowserPool(config), lib2)
    const secured = buildHttpApi({ config, library: lib2, runs: runs2, onLibraryChanged: () => {} })
    const res = await secured.inject({
      method: 'GET',
      url: '/api/config',
      headers: { authorization: 'Bearer super-secret-token' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.config.token).toEqual({ set: true, masked: 'supe…oken' })
    expect(body.config.llm.apiKey.set).toBe(false)
    expect(body.config.feishu.appSecret.set).toBe(false)
    expect(Array.isArray(body.envOverrides)).toBe(true)
    expect(Array.isArray(body.restartRequired)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('super-secret-token')
    await secured.close()
  })

  it('PUT /api/config persists to config.json and hot-applies the token', async () => {
    const configFile = join(dir, 'config.json')
    const prevConfig = process.env['BC_CONFIG']
    process.env['BC_CONFIG'] = configFile
    try {
      const config = { ...loadConfig(), dataDir: dir, workflowsFile: join(dir, 'wf.json'), token: 'old-token' }
      const lib2 = new WorkflowLibrary(config.workflowsFile)
      lib2.load()
      const runs2 = new RunService(config, new BrowserPool(config), lib2)
      const secured = buildHttpApi({ config, library: lib2, runs: runs2, onLibraryChanged: () => {} })

      const put = await secured.inject({
        method: 'PUT',
        url: '/api/config',
        headers: { authorization: 'Bearer old-token' },
        payload: {
          token: 'new-token',
          llm: { baseUrl: 'https://api.test/v1', apiKey: 'sk-abc12345678901234', model: 'test-model' },
          browser: { maxConcurrent: 3 },
        },
      })
      expect(put.statusCode).toBe(200)
      const body = put.json()
      expect(body.written).toBe(true)
      expect(body.config.token.masked).toBe('new-…oken')
      expect(body.config.llm.apiKey.masked).toBe('sk-a…1234')

      // The shared config object was hot-applied: old token now 401s.
      const oldAuth = await secured.inject({ method: 'GET', url: '/api/workflows' })
      expect(oldAuth.statusCode).toBe(401)
      const newAuth = await secured.inject({
        method: 'GET',
        url: '/api/workflows',
        headers: { authorization: 'Bearer new-token' },
      })
      expect(newAuth.statusCode).toBe(200)

      // The patch landed in the config file (env-free machine).
      const file = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(configFile, 'utf8')))
      expect(file['token']).toBe('new-token')
      expect(file['llm']['model']).toBe('test-model')
      expect(file['browser']['maxConcurrent']).toBe(3)
      await secured.close()
    } finally {
      if (prevConfig === undefined) delete process.env['BC_CONFIG']
      else process.env['BC_CONFIG'] = prevConfig
    }
  })

  it('rejects a cdp switch without an endpoint (400)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: { browser: { mode: 'cdp' } } })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/config/test-llm reports missing configuration (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/test-llm' })
    expect(res.statusCode).toBe(400)
    expect(res.json().ok).toBe(false)
  })

  it('POST /api/config/test-feishu reports missing configuration (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/test-feishu' })
    expect(res.statusCode).toBe(400)
    expect(res.json().ok).toBe(false)
  })

  it('GET /api/schedules returns the scheduler overview rows', async () => {
    const overview = [
      {
        workflowId: 's1',
        name: 'S',
        kind: 'interval' as const,
        detail: '每 30 分钟',
        enabled: true,
        armed: true,
        nextRunAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    const app2 = buildHttpApi({
      config: { ...loadConfig(), dataDir: dir, workflowsFile: join(dir, 'wf.json'), token: '' },
      library,
      runs,
      onLibraryChanged: () => {},
      schedulesOverview: () => overview,
    })
    const res = await app2.inject({ method: 'GET', url: '/api/schedules' })
    expect(res.statusCode).toBe(200)
    expect(res.json().schedules[0]).toMatchObject({ workflowId: 's1', kind: 'interval', armed: true })
    await app2.close()
  })
})

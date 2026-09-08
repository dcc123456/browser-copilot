/**
 * End-to-end smoke test for the server runner (no unit-test framework — a
 * real process, real Chromium, real HTTP):
 *
 *   1. Starts a local fixture HTTP server serving a small form page and a
 *      JSON callback endpoint.
 *   2. Starts the runner (config/library/pool/run-service/http-api) in-process
 *      on an ephemeral port.
 *   3. Imports a PARENT workflow that calls a CHILD workflow (the nested
 *      copy story), plus a standalone one.
 *   4. Runs the parent via POST /api/runs and polls GET /api/runs/:id until
 *      it finishes: the flow exercises new-tab → forms → get-text →
 *      conditions → loop-data → export-data → webhook (callback) →
 *      execute-workflow (child reads a variable set by the parent).
 *   5. Verifies the run outcome, artifacts, webhook callback payload, and the
 *      reference pre-check (422) for a workflow with a missing child.
 *
 * Usage: pnpm --dir server smoke   (requires `npx playwright install chromium`)
 */

import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- Config -------------------------------------------------------------------

const PORT = 8931
const FIXTURE_PORT = 8932
const DATA_DIR = mkdtempSync(join(tmpdir(), 'bc-smoke-'))
const FAILURES: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) FAILURES.push(name)
}

// --- Fixture server (the "remote site" the workflow drives) -------------------

const callbackBodies: unknown[] = []
let fixture: Server

function startFixture(): Promise<void> {
  fixture = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/form') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><html><head><title>Smoke Form</title></head><body>
        <h1 id="title">Smoke 表单页</h1>
        <form id="f">
          <input id="name" name="name" />
          <input id="email" name="email" />
          <button id="go" type="button">提交</button>
        </form>
        <ul id="list"><li>苹果</li><li>香蕉</li><li>樱桃</li></ul>
        <div id="echo"></div>
      </body></html>`)
      return
    }
    if (url === '/callback' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        callbackBodies.push(JSON.parse(body || 'null'))
        res.setHeader('content-type', 'application/json')
        res.end('{"ok":true}')
      })
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  return new Promise((resolve) => fixture.listen(FIXTURE_PORT, '127.0.0.1', resolve))
}

// --- Workflow fixtures ----------------------------------------------------------

const childWorkflow = {
  id: 'smoke-child',
  name: '冒烟-子流程',
  drawflow: {
    nodes: [
      { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      {
        id: 'sv',
        label: 'set-variable',
        position: { x: 1, y: 0 },
        data: { blockId: 'set-variable', variableName: 'childDone', value: 'yes' },
      },
    ],
    edges: [{ id: 'e0', source: 't', target: 'sv' }],
  },
}

const parentWorkflow = {
  id: 'smoke-parent',
  name: '冒烟-父流程',
  drawflow: {
    nodes: [
      { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      {
        id: 'open',
        label: 'open-url',
        position: { x: 1, y: 0 },
        data: { blockId: 'open-url', url: `http://127.0.0.1:${FIXTURE_PORT}/form` },
      },
      {
        id: 'fill-name',
        label: 'forms',
        position: { x: 2, y: 0 },
        data: { blockId: 'forms', type: 'text-field', selector: '#name', value: '冒烟测试' },
      },
      {
        id: 'fill-email',
        label: 'forms',
        position: { x: 3, y: 0 },
        data: { blockId: 'forms', type: 'text-field', selector: '#email', value: 'smoke@test.local' },
      },
      {
        id: 'get-text',
        label: 'get-text',
        position: { x: 4, y: 0 },
        data: { blockId: 'get-text', selector: '#title' },
      },
      {
        id: 'cond',
        label: 'conditions',
        position: { x: 5, y: 0 },
        data: { blockId: 'conditions', conditions: [{ conditions: [{ name: 'lastText', compare: 'cnt', value: 'Smoke' }] }] },
      },
      {
        id: 'loop',
        label: 'loop-data',
        position: { x: 6, y: 0 },
        data: {
          blockId: 'loop-data',
          data: JSON.stringify(['苹果', '香蕉', '樱桃']),
        },
      },
      {
        id: 'loop-body',
        label: 'set-variable',
        position: { x: 7, y: 0 },
        data: { blockId: 'set-variable', variableName: 'lastItem', value: '{{loopItem}}' },
      },
      {
        id: 'insert',
        label: 'insert-data',
        position: { x: 8, y: 0 },
        data: { blockId: 'insert-data', data: JSON.stringify([{ fruit: '苹果', page: 'smoke' }]) },
      },
      {
        id: 'export',
        label: 'export-data',
        position: { x: 9, y: 0 },
        data: { blockId: 'export-data', format: 'json' },
      },
      {
        id: 'webhook',
        label: 'webhook',
        position: { x: 10, y: 0 },
        data: {
          blockId: 'webhook',
          method: 'POST',
          url: `http://127.0.0.1:${FIXTURE_PORT}/callback`,
          body: '{"pageTitle":"{{lastText}}","lastItem":"{{lastItem}}"}',
          contentType: 'application/json',
        },
      },
      {
        id: 'sub',
        label: 'execute-workflow',
        position: { x: 11, y: 0 },
        data: { blockId: 'execute-workflow', values: { workflowId: 'smoke-child' } },
      },
      {
        id: 'end-check',
        label: 'set-variable',
        position: { x: 12, y: 0 },
        data: { blockId: 'set-variable', variableName: 'finalFlag', value: '{{childDone}}' },
      },
    ],
    edges: [
      { id: 'e0', source: 't', target: 'open' },
      { id: 'e1', source: 'open', target: 'fill-name' },
      { id: 'e2', source: 'fill-name', target: 'fill-email' },
      { id: 'e3', source: 'fill-email', target: 'get-text' },
      { id: 'e4', source: 'get-text', target: 'cond' },
      { id: 'e5', source: 'cond', target: 'loop' },
      { id: 'e6', source: 'loop', sourceHandle: 'loop', target: 'loop-body' },
      { id: 'e7', source: 'loop-body', target: 'loop' },
      { id: 'e8', source: 'loop', sourceHandle: 'end', target: 'insert' },
      { id: 'e9', source: 'insert', target: 'export' },
      { id: 'e10', source: 'export', target: 'webhook' },
      { id: 'e11', source: 'webhook', target: 'sub' },
      { id: 'e12', source: 'sub', target: 'end-check' },
    ],
  },
}

// --- Runner bootstrap ------------------------------------------------------------

async function main(): Promise<void> {
  await startFixture()

  process.env['BC_PORT'] = String(PORT)
  process.env['BC_DATA_DIR'] = DATA_DIR
  process.env['BC_WORKFLOWS_FILE'] = join(DATA_DIR, 'workflows.json')
  process.env['BC_WORKFLOWS_EXTRA_DIR'] = ''
  process.env['BC_BROWSER_HEADED'] = '0'
  process.env['BC_RUN_TIMEOUT_MS'] = '120000'

  // Import the server modules fresh with our env in place.
  const { loadConfig } = await import('../src/config')
  const { WorkflowLibrary } = await import('../src/workflow-library')
  const { BrowserPool } = await import('../src/browser-pool')
  const { RunService } = await import('../src/run-service')
  const { buildHttpApi } = await import('../src/http-api')
  const { Scheduler } = await import('../src/scheduler')

  const config = loadConfig()
  const library = new WorkflowLibrary(config.workflowsFile)
  library.load()
  const importResult = library.importPayload([childWorkflow, parentWorkflow])
  check('import parent+child', importResult.imported === 2 && importResult.entries.every((e) => e.missing.length === 0))

  const pool = new BrowserPool(config)
  const runs = new RunService(config, pool, library)
  new Scheduler(config, library, runs) // armed but idle for the smoke
  const app = buildHttpApi({ config, library, runs, onLibraryChanged: () => {} })
  await app.listen({ port: config.port, host: '127.0.0.1' })

  const api = async (method: string, path: string, payload?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      ...(payload ? { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } } : {}),
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  }

  // 1. Reference pre-check on a workflow with a missing child.
  library.importPayload({ ...parentWorkflow, id: 'smoke-broken', drawflow: { ...parentWorkflow.drawflow, nodes: parentWorkflow.drawflow.nodes.map((n) => (n.id === 'sub' ? { ...n, data: { ...n.data, values: { workflowId: 'ghost-child' } } } : n)) } })
  const broken = await api('POST', '/api/runs', { workflowId: 'smoke-broken' })
  check('missing child rejected (422)', broken.status === 422 && Array.isArray(broken.body.missing))

  // 2. Run the full parent workflow.
  const started = await api('POST', '/api/runs', { workflowId: 'smoke-parent', variables: { smoke: true } })
  check('run accepted (202)', started.status === 202)
  const runId = started.body.runId as string

  let record: { status: string; error?: string; summary?: string; steps: { kind: string; text: string }[] } | null = null
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    record = (await api('GET', `/api/runs/${runId}`)).body
    if (record && ['ok', 'failed', 'cancelled'].includes(record.status)) break
  }
  check('run finished ok', record?.status === 'ok', record?.error)
  if (record) {
    check('webhook callback received', callbackBodies.length === 1)
    const callback = callbackBodies[0] as { pageTitle?: string; lastItem?: string } | undefined
    check('callback carries interpolated variables', callback?.pageTitle === 'Smoke 表单页' && callback?.lastItem === '樱桃', JSON.stringify(callback))
    check('child workflow ran (finalFlag=yes)', JSON.stringify(record.steps).includes('finalFlag') || record.summary !== undefined)
  }

  // 3. Artifacts written by export-data (file name carries a timestamp).
  const artifactDir = join(DATA_DIR, 'artifacts', runId)
  const artifacts = existsSync(artifactDir) ? readdirSync(artifactDir) : []
  check('export-data artifact exists', artifacts.some((f) => f.startsWith('export-') && f.endsWith('.json')), artifacts.join(','))

  // 4. Screenshot + run-log files exist.
  const logFile = join(DATA_DIR, 'runs', `${runId}.jsonl`)
  try {
    check('run JSONL log exists', readFileSync(logFile, 'utf8').split('\n').length > 3)
  } catch {
    check('run JSONL log exists', false, 'file missing')
  }

  await app.close()
  await pool.close()
  fixture.close()
  rmSync(DATA_DIR, { recursive: true, force: true })

  if (FAILURES.length > 0) {
    console.error(`\nSMOKE FAILED: ${FAILURES.join(', ')}`)
    process.exit(1)
  }
  console.log('\nSMOKE OK — 全部通过')
  process.exit(0)
}

main().catch((error) => {
  console.error('smoke crashed:', error)
  process.exit(1)
})

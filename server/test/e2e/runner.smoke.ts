/**
 * End-to-end smoke test: boot the runner's real Fastify app on an ephemeral
 * port and exercise the security contract over actual HTTP.
 *
 * Unlike the unit tests in `test/http-api.test.ts` (which use `app.inject`),
 * this binds a socket and uses `fetch`, so it also covers the HTTP layer the
 * unit tests bypass: request-id propagation, CORS/rate-limit registration and
 * the live auth hook. It is intentionally small — the goal is a fast canary
 * that fails loudly if boot, auth or validation regress.
 *
 * `BC_ALLOW_UNAUTHENTICATED=1` is set to mirror the documented local-dev boot
 * path; a token is still configured, because the point of this test is to
 * prove that a configured token is actually enforced.
 *
 * @module server/test/e2e/runner.smoke
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildHttpApi } from '../../src/http-api'
import { loadConfig } from '../../src/config'
import { WorkflowLibrary } from '../../src/workflow-library'
import { RunService } from '../../src/run-service'
import { BrowserPool } from '../../src/browser-pool'

const TOKEN = 'smoke-test-token'

let dir: string
let app: FastifyInstance
let pool: BrowserPool
let baseUrl: string
let prevConfig: string | undefined
let prevAllowUnauthenticated: string | undefined

beforeAll(async () => {
  prevConfig = process.env['BC_CONFIG']
  prevAllowUnauthenticated = process.env['BC_ALLOW_UNAUTHENTICATED']
  dir = mkdtempSync(join(tmpdir(), 'bc-smoke-'))
  process.env['BC_CONFIG'] = join(dir, 'config.json')
  process.env['BC_ALLOW_UNAUTHENTICATED'] = '1'

  const config = {
    ...loadConfig(),
    port: 0,
    token: TOKEN,
    dataDir: dir,
    workflowsFile: join(dir, 'workflows.json'),
    workflowsExtraDir: '',
  }
  const library = new WorkflowLibrary(config.workflowsFile)
  library.load()
  pool = new BrowserPool(config)
  const runs = new RunService(config, pool, library)
  app = buildHttpApi({ config, library, runs, onLibraryChanged: () => {} })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await app.close()
  await pool.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  if (prevConfig === undefined) delete process.env['BC_CONFIG']
  else process.env['BC_CONFIG'] = prevConfig
  if (prevAllowUnauthenticated === undefined) delete process.env['BC_ALLOW_UNAUTHENTICATED']
  else process.env['BC_ALLOW_UNAUTHENTICATED'] = prevAllowUnauthenticated
})

describe('runner e2e smoke', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const response = await fetch(`${baseUrl}/api/workflows`)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'Unauthorized' })
  })

  it('rejects a token passed in the query string', async () => {
    const response = await fetch(`${baseUrl}/api/workflows?token=${TOKEN}`)
    expect(response.status).toBe(401)
  })

  it('accepts an authenticated request', async () => {
    const response = await fetch(`${baseUrl}/api/workflows`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { workflows: unknown[] }
    expect(Array.isArray(body.workflows)).toBe(true)
  })

  it('leaves /healthz open', async () => {
    const response = await fetch(`${baseUrl}/healthz`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('returns a structured 400 for a malformed config patch', async () => {
    const response = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ browser: { maxConcurrent: 999 } }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; details: unknown }
    expect(typeof body.error).toBe('string')
    expect(body.details).toBeDefined()
  })
})

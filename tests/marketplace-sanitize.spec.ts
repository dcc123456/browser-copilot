import { describe, expect, it } from 'vitest'
import { toPublishableWorkflow } from '../src/lib/marketplace/sanitize'
import type { Workflow } from '../src/lib/workflow/types'

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'local-1',
    name: 'Scrape orders',
    description: 'Open the orders page and copy every row.',
    plan: 'internal reasoning that must not be shared',
    folderId: 'folder-a',
    createdAt: 1,
    updatedAt: 2,
    table: { id: 'table-1' },
    revision: 3,
    revisionHistory: [{ revision: 3, updatedAt: 2, source: 'manual-edit' }],
    marketplace: {
      repo: 'dcc123456/BC-workflow',
      slug: 'scrape-orders-abcdef',
      version: 1,
      hash: 'a'.repeat(64),
      author: 'octocat',
      appliedAt: 1,
    },
    trigger: {
      type: 'scheduled',
      schedule: '0 9 * * *',
      enabled: true,
      menuItemId: 'local-menu-id',
      urlPattern: 'https://shop.example/*',
    },
    settings: {
      saveLog: true,
      debugMode: true,
      notification: true,
      reuseLastState: true,
      defaultWaitMs: 5000,
      pageContext: { origin: 'https://shop.example' },
      goalVerification: { ok: true },
      trialRun: false,
    },
    drawflow: {
      position: { x: 12, y: 34 },
      zoom: 0.75,
      nodes: [
        {
          id: 'n1',
          label: 'Fill form',
          position: { x: 10, y: 20 },
          data: {
            runLog: 'previous run output',
            logs: ['noise'],
            selector: '#password',
            password: 'hunter2',
            token: '{{token}}',
            screenshot: 'data:image/png;base64,AAAA',
            nested: { apiKey: 'sk-live-123', ok: 'kept' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n1' }],
    },
    ...overrides,
  }
}

describe('publish sanitizer', () => {
  it('keeps only the graph, trigger behaviour and default settings', () => {
    const { workflow } = toPublishableWorkflow(makeWorkflow(), 'scrape-orders-abcdef')

    expect(workflow.id).toBe('scrape-orders-abcdef')
    expect(workflow.name).toBe('Scrape orders')
    expect(workflow.description).toBe('Open the orders page and copy every row.')
    expect(workflow.settings).toEqual({
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    })
    expect(workflow).not.toHaveProperty('plan')
    expect(workflow).not.toHaveProperty('folderId')
    expect(workflow).not.toHaveProperty('revision')
    expect(workflow).not.toHaveProperty('revisionHistory')
    expect(workflow).not.toHaveProperty('marketplace')
    expect(workflow).not.toHaveProperty('table')
    expect(workflow).not.toHaveProperty('createdAt')
    expect(workflow).not.toHaveProperty('updatedAt')
  })

  it('resets canvas placement and disables the trigger', () => {
    const { workflow } = toPublishableWorkflow(makeWorkflow(), 'scrape-orders-abcdef')
    expect(workflow.drawflow).not.toHaveProperty('position')
    expect(workflow.drawflow).not.toHaveProperty('zoom')
    expect(workflow.trigger).toEqual({
      type: 'scheduled',
      schedule: '0 9 * * *',
      urlPattern: 'https://shop.example/*',
      enabled: false,
    })
  })

  it('strips runtime keys and embedded screenshots from node data', () => {
    const { workflow, warnings } = toPublishableWorkflow(
      makeWorkflow(),
      'scrape-orders-abcdef',
    )
    const data = workflow.drawflow.nodes[0]!.data
    expect(data).not.toHaveProperty('runLog')
    expect(data).not.toHaveProperty('logs')
    expect(data['screenshot']).toBe('')
    expect(data['selector']).toBe('#password')
    expect(warnings).toContainEqual({
      kind: 'embedded-data',
      nodeLabel: 'Fill form',
      param: 'screenshot',
    })
  })

  it('warns on literal credentials but not on references', () => {
    const { warnings } = toPublishableWorkflow(makeWorkflow(), 'scrape-orders-abcdef')
    expect(warnings).toContainEqual({
      kind: 'credential-literal',
      nodeLabel: 'Fill form',
      param: 'password',
    })
    expect(warnings).toContainEqual({
      kind: 'credential-literal',
      nodeLabel: 'Fill form',
      param: 'nested.apiKey',
    })
    expect(warnings.some((warning) => warning.param === 'token')).toBe(false)
  })

  it('refuses a workflow that is too large to publish', () => {
    const huge = makeWorkflow()
    huge.drawflow.nodes[0]!.data['payload'] = 'x'.repeat(600 * 1024)
    expect(() => toPublishableWorkflow(huge, 'scrape-orders-abcdef')).toThrow(/too large/i)
  })
})

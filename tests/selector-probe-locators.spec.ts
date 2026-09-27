/**
 * C2 live-locator evidence: the pure `locatorConcernLines` copy and the
 * background `probeWorkflowLocators` pass that adds actionability.
 *
 * Three states drive the warnings:
 *   - ambiguous (matches > 1) → the step may hit the wrong element
 *   - actionable:false (unique but hidden/obscured) → the click/fill no-ops
 *   - unique + actionable → healthy, no warning
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  locatorConcernLines,
  type SelectorProbeResult,
} from '../src/lib/workflow/selector-probe'
import { probeWorkflowLocators } from '../src/background/selector-probe'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import { newId } from '../src/lib/storage'

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, resolveAutomationTab: vi.fn() }
})

import { resolveAutomationTab } from '../src/background/driver'

function probe(nodeId: string, overrides: Partial<SelectorProbeResult> = {}): SelectorProbeResult {
  return {
    nodeId,
    blockId: 'event-click',
    selector: '#go',
    matches: 1,
    status: 'unique',
    ...overrides,
  }
}

describe('locatorConcernLines (C2)', () => {
  it('emits an ambiguous line for a multi-match selector', () => {
    const lines = locatorConcernLines([probe('a', { matches: 3, status: 'ambiguous' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Ambiguous locator')
    expect(lines[0]).toContain('#go')
  })

  it('emits a not-actionable line for a hidden unique element', () => {
    const lines = locatorConcernLines([
      probe('b', { matches: 1, status: 'unique', actionable: false }),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Not actionable')
  })

  it('emits nothing for a unique, actionable element', () => {
    const lines = locatorConcernLines([
      probe('c', { matches: 1, status: 'unique', actionable: true }),
    ])
    expect(lines).toHaveLength(0)
  })

  it('emits nothing when there are no probes', () => {
    expect(locatorConcernLines([])).toHaveLength(0)
  })
})

describe('probeWorkflowLocators (C2)', () => {
  beforeEach(() => {
    vi.mocked(resolveAutomationTab).mockResolvedValue({
      id: 1,
      url: 'https://example.com/',
    } as chrome.tabs.Tab)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function stubRows(rows: { matches: number; actionable?: boolean }[]): void {
    vi.stubGlobal('chrome', {
      scripting: { executeScript: vi.fn(async () => [{ result: rows }]) },
      tabs: { get: vi.fn() },
    })
  }

  function node(blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
    return { id: newId(), label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
  }

  function workflowWithSelector(selector: string): Workflow {
    const trigger = node('trigger', { type: 'manual' })
    return {
      id: 'wf',
      name: 'wf',
      createdAt: 0,
      updatedAt: 0,
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: { nodes: [trigger, node('event-click', { selector })], edges: [] },
      trigger: { type: 'manual', enabled: true },
    }
  }

  it('returns a unique, actionable probe for a single visible element', async () => {
    stubRows([{ matches: 1, actionable: true }])
    const probes = await probeWorkflowLocators(workflowWithSelector('#go'))
    expect(probes).toHaveLength(1)
    expect(probes![0]).toMatchObject({ status: 'unique', actionable: true, matches: 1 })
  })

  it('returns an ambiguous probe for a multi-match selector', async () => {
    stubRows([{ matches: 4 }])
    const probes = await probeWorkflowLocators(workflowWithSelector('.card'))
    expect(probes![0]).toMatchObject({ status: 'ambiguous', matches: 4 })
    expect(probes![0]!.actionable).toBeUndefined()
  })

  it('returns a not-actionable probe for a unique but obscured element', async () => {
    stubRows([{ matches: 1, actionable: false }])
    const probes = await probeWorkflowLocators(workflowWithSelector('#hidden'))
    expect(probes![0]).toMatchObject({ status: 'unique', actionable: false })
  })

  it('returns null when the page cannot be probed', async () => {
    vi.mocked(resolveAutomationTab).mockResolvedValue(undefined)
    const probes = await probeWorkflowLocators(workflowWithSelector('#go'))
    expect(probes).toBeNull()
  })
})
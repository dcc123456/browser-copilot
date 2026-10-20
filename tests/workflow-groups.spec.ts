/**
 * Workflow groups: bucketing and the export envelope.
 *
 * The group table holds metadata only — membership lives on the workflow's own
 * `folderId` — so the two rules worth pinning down are the bucketing (a stale
 * pointer must not hide a workflow) and the export shape (a group file has to
 * carry the group name, or re-importing scatters its members).
 */
import { describe, expect, it } from 'vitest'
import {
  asWorkflowGroup,
  buildWorkflowGroupExport,
  groupWorkflows,
  isWorkflowGroupExport,
} from '../src/lib/workflow/groups'
import type { Workflow } from '../src/lib/workflow/types'

function workflow(id: string, folderId?: string): Workflow {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    drawflow: { nodes: [], edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    ...(folderId ? { folderId } : {}),
  }
}

describe('asWorkflowGroup', () => {
  it('keeps a well-formed record', () => {
    const group = asWorkflowGroup({ id: 'g1', name: 'Daily', createdAt: 5, updatedAt: 6 })
    expect(group).toEqual({ id: 'g1', name: 'Daily', createdAt: 5, updatedAt: 6 })
  })

  it('rejects records without an id or a name', () => {
    expect(asWorkflowGroup({ name: 'No id' })).toBeNull()
    expect(asWorkflowGroup({ id: 'g1' })).toBeNull()
    expect(asWorkflowGroup(null)).toBeNull()
  })

  it('falls back to a placeholder name and timestamps', () => {
    const group = asWorkflowGroup({ id: 'g1', name: '   ' })
    expect(group?.name).toBe('Group')
    expect(typeof group?.createdAt).toBe('number')
  })
})

describe('groupWorkflows', () => {
  const groups = [
    { id: 'g1', name: 'A', createdAt: 1, updatedAt: 1 },
    { id: 'g2', name: 'B', createdAt: 2, updatedAt: 2 },
  ]

  it('buckets workflows by their folder', () => {
    const sections = groupWorkflows(
      [workflow('w1', 'g1'), workflow('w2', 'g2'), workflow('w3')],
      groups,
    )
    expect(sections.map((section) => section.group?.id ?? null)).toEqual(['g1', 'g2', null])
    expect(sections[0]?.workflows.map((w) => w.id)).toEqual(['w1'])
    expect(sections[2]?.workflows.map((w) => w.id)).toEqual(['w3'])
  })

  it('treats a workflow pointing at a deleted group as ungrouped', () => {
    const sections = groupWorkflows([workflow('w1', 'gone')], groups)
    const ungrouped = sections.find((section) => section.group === null)
    expect(ungrouped?.workflows.map((w) => w.id)).toEqual(['w1'])
  })

  it('drops the ungrouped bucket when every workflow is filed', () => {
    const sections = groupWorkflows([workflow('w1', 'g1')], groups)
    expect(sections.every((section) => section.group !== null)).toBe(true)
  })

  it('keeps the ungrouped bucket when there is nothing else to show', () => {
    const sections = groupWorkflows([], [])
    expect(sections).toHaveLength(1)
    expect(sections[0]?.group).toBeNull()
  })
})

describe('group export envelope', () => {
  it('carries the group name next to its members', () => {
    const members = [workflow('w1', 'g1'), workflow('w2', 'g1')]
    const payload = buildWorkflowGroupExport('Daily', members)
    expect(payload.type).toBe('workflow-group')
    expect(payload.name).toBe('Daily')
    expect(payload.workflows).toHaveLength(2)
    expect(isWorkflowGroupExport(payload)).toBe(true)
  })

  it('is not mistaken for a workflow or a list of workflows', () => {
    expect(isWorkflowGroupExport([workflow('w1')])).toBe(false)
    expect(isWorkflowGroupExport(workflow('w1'))).toBe(false)
    expect(isWorkflowGroupExport({ type: 'workflow-group' })).toBe(false)
  })
})

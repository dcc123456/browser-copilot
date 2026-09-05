/**
 * Round-trip regression for the ChatTab save-dialog path ("保存为工作流" →
 * AI review keep-set → derived workflow → workflows.save → workflows list).
 *
 * The dialog saves `applyAiPrefillOptions(applyNodeKeepSelection(base, keep),
 * aiSelections)` — the exact composition ChatTab's `derivePreview` performs —
 * so whatever lands in storage must be listed back intact.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const backing: Record<string, unknown> = {}

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (key in backing) out[key] = backing[key]
          return out
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(backing, items)
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete backing[key]
        },
      },
    },
  })
})

import { workflowFromHistory } from '../src/lib/storage'
import { applyNodeKeepSelection, reviewStepsOf } from '../src/lib/workflow/review-patch'
import { listWorkflows, saveWorkflow } from '../src/lib/workflow/storage'
import type { HistoryEntry } from '../src/lib/types'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'conv-1',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
  }
}

describe('chat save-dialog workflow round-trip', () => {
  it('persists the derived (AI-pruned) workflow and lists it back', async () => {
    const base = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('click', { target: { primary: { how: 'css', value: '.go' } } }),
        entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'hi' }),
      ],
      '对话生成',
    )
    expect(base).not.toBeNull()

    // The AI verdict drops the middle exploratory click, like a real review.
    const steps = reviewStepsOf(base!)
    const dropTarget = steps.find((step) => step.blockId === 'event-click')
    expect(dropTarget).toBeDefined()
    const keep: Record<string, boolean> = {}
    for (const step of steps) keep[step.id] = step.id !== dropTarget!.id

    // ChatTab derivePreview composition.
    const derived = applyNodeKeepSelection(base!, keep)
    await saveWorkflow(derived)

    const list = await listWorkflows()
    const saved = list.find((wf) => wf.id === base!.id)
    expect(saved).toBeDefined()
    expect(saved?.name).toBe('对话生成')
    // Trigger + new-tab + its page-load wait satellite + the surviving forms,
    // spine re-linked (the AI-dropped click and nothing else is gone).
    expect(saved?.drawflow.nodes.length).toBe(4)
    expect(saved?.drawflow.edges.length).toBe(3)
    const blockIds = saved!.drawflow.nodes.map((n) => n.data?.blockId)
    expect(blockIds).not.toContain('event-click')
    expect(blockIds).toContain('forms')
  })

  it('persists an all-kept workflow unchanged', async () => {
    const base = workflowFromHistory([entry('open_url', { url: 'https://b.com' })], 'wf-b')
    const derived = applyNodeKeepSelection(base!, {})
    await saveWorkflow(derived)
    const saved = (await listWorkflows()).find((wf) => wf.id === base!.id)
    expect(saved).toBeDefined()
    expect(saved?.drawflow.nodes.length).toBe(base!.drawflow.nodes.length)
  })
})

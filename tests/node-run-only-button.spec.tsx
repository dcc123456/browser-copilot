/**
 * The canvas node toolbar carries a "run this block only" button, and only
 * where a single-node run means something: engine-interpreted blocks (trigger,
 * loops, sub-workflows, groups) and placeholder executors do not get one, so
 * the UI never promises a test it cannot run.
 *
 * See specs/2026-11-25-run-current-node-design.md.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'
import { BlockNode } from '../src/workflow-editor/flow/BlockNode'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import type { BlockCatalogEntry } from '../src/lib/workflow/blocks/types'

// React 19's `act` only flushes without a warning when the test environment
// says it supports it (jsdom is set for this file above).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const actions = {
  onDelete: () => {},
  onDuplicate: () => {},
  onSettings: () => {},
  onEdit: () => {},
  onToggleDisable: () => {},
  onToggleBreakpoint: () => {},
  onRunNode: () => {},
  onRunFromHere: () => {},
}

function locale(): ReturnType<typeof makeEditorLocale> {
  return makeEditorLocale('en', (key) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key)
}

function blockEntry(blockId: string): BlockCatalogEntry {
  return {
    id: blockId,
    name: blockId,
    category: 'general',
    icon: 'ri-text',
    component: 'Default',
    inputs: 1,
    outputs: 1,
    data: {},
  } as unknown as BlockCatalogEntry
}

function nodeCard(blockId: string, extraActions: Record<string, unknown> = {}) {
  return createElement(
    EditorLocaleContext.Provider,
    { value: locale() },
    createElement(ReactFlowProvider, {
      children: createElement(BlockNode, {
        id: 'n1',
        data: {
          block: blockEntry(blockId),
          blockData: {},
          actions: { ...actions, ...extraActions },
        },
        selected: false,
      } as never),
    }),
  )
}

function card(blockId: string): string {
  return renderToStaticMarkup(nodeCard(blockId))
}

const runOnlyTitle = EDITOR_STRINGS.en.nodeRunOnly

describe('the run-this-block-only button', () => {
  it('renders for an executable operator', () => {
    expect(card('get-text')).toContain(`title="${runOnlyTitle}"`)
  })

  it('is absent for an engine-interpreted block', () => {
    const html = card('trigger')
    expect(html).not.toContain(`title="${runOnlyTitle}"`)
    // The run-from-here action is still there — only the single-node test is hidden.
    expect(html).toContain('Run workflow from here')
  })

  it('is absent for a placeholder executor', () => {
    expect(card('browser-event')).not.toContain(`title="${runOnlyTitle}"`)
  })

  it('asks the editor to run this node when clicked', () => {
    const onRunNode = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(nodeCard('get-text', { onRunNode })))
    const button = container.querySelector<HTMLButtonElement>(`button[title="${runOnlyTitle}"]`)
    expect(button).not.toBeNull()
    act(() => button?.click())
    expect(onRunNode).toHaveBeenCalledWith('n1')
    act(() => root.unmount())
    container.remove()
  })
})

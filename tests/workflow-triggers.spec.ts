/**
 * Trigger resolution: effectiveTriggerKind reads the Automa trigger block,
 * normalizeShortcut parses chords for the injected keyboard listener.
 */
import { describe, it, expect } from 'vitest'
import { effectiveTriggerKind, normalizeShortcut, triggerEnabled } from '../src/background/workflow-triggers'
import type { Workflow } from '../src/lib/workflow/types'

function wf(nodeType?: string, opts?: { top?: Workflow['trigger']; disabled?: boolean }): Workflow {
  return {
    id: 'w1',
    name: 't',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    trigger: opts?.top,
    drawflow: {
      nodes: nodeType
        ? [{ id: 'trig', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger', type: nodeType } }]
        : [],
      edges: [],
    },
  }
}

describe('effectiveTriggerKind', () => {
  it('reads the type from the trigger block', () => {
    expect(effectiveTriggerKind(wf('on-startup'))).toBe('on-startup')
    expect(effectiveTriggerKind(wf('keyboard-shortcut'))).toBe('keyboard-shortcut')
    expect(effectiveTriggerKind(wf('context-menu'))).toBe('context-menu')
  })

  it('falls back to the top-level trigger', () => {
    expect(effectiveTriggerKind(wf(undefined, { top: { type: 'scheduled' } }))).toBe('scheduled')
    expect(effectiveTriggerKind(wf(undefined, { top: { type: 'visit-web' } }))).toBe('visit-web')
    expect(effectiveTriggerKind(wf(undefined))).toBe('manual')
  })

  it('block type wins over top-level', () => {
    expect(effectiveTriggerKind(wf('on-startup', { top: { type: 'manual' } }))).toBe('on-startup')
  })
})

describe('triggerEnabled', () => {
  it('is enabled by default', () => {
    expect(triggerEnabled(wf('on-startup'))).toBe(true)
  })
  it('is disabled when top-level trigger.enabled is false', () => {
    expect(triggerEnabled(wf('on-startup', { top: { type: 'scheduled', enabled: false } }))).toBe(false)
  })
})

describe('normalizeShortcut', () => {
  it('parses modifier chords', () => {
    expect(normalizeShortcut('Ctrl+Shift+E')).toEqual({
      key: 'e',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    })
    expect(normalizeShortcut('Alt+Enter')).toEqual({
      key: 'enter',
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
    })
    expect(normalizeShortcut('Cmd+K').meta).toBe(true)
  })
})

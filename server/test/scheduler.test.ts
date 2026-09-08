import { describe, expect, it } from 'vitest'
import { Cron } from 'croner'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coerceIntervalMinutes } from '../../src/lib/schedule'
import { Scheduler, effectiveKind, enabled, parseTime, triggerNode } from '../src/scheduler'
import { loadConfig } from '../src/config'
import { WorkflowLibrary } from '../src/workflow-library'
import type { RunService } from '../src/run-service'
import type { Workflow } from '../../src/lib/workflow/types'

function wf(trigger: Record<string, unknown>, top?: Record<string, unknown>): Workflow {
  return {
    id: 'w',
    name: 'W',
    ...(top ? { trigger: top } : {}),
    drawflow: { nodes: [{ id: 't', label: 'trigger', data: trigger }], edges: [] },
  } as unknown as Workflow
}

describe('scheduler trigger parsing', () => {
  it('prefers the trigger-node data.type over top-level trigger', () => {
    expect(effectiveKind(wf({ blockId: 'trigger', type: 'interval' }, { type: 'scheduled' }))).toBe('interval')
  })

  it('falls back to top-level scheduled type (cron text)', () => {
    expect(effectiveKind(wf({ blockId: 'trigger' }, { type: 'scheduled', schedule: '0 9 * * 1-5' }))).toBe('scheduled')
    expect(effectiveKind(wf({ blockId: 'trigger' }))).toBe('manual')
  })

  it('enabled respects trigger.enabled=false', () => {
    expect(enabled(wf({ blockId: 'trigger' }, { enabled: false }))).toBe(false)
    expect(enabled(wf({ blockId: 'trigger' }))).toBe(true)
    expect(enabled(wf({ blockId: 'trigger' }, { enabled: true }))).toBe(true)
  })

  it('parses HH:MM with clamping', () => {
    expect(parseTime('09:30')).toEqual({ hour: 9, minute: 30 })
    expect(parseTime('9:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseTime('25:99')).toEqual({ hour: 23, minute: 59 })
    expect(parseTime('nonsense')).toEqual({ hour: 0, minute: 0 })
  })

  it('finds the trigger node by blockId or label', () => {
    expect(triggerNode(wf({ blockId: 'trigger' }))?.id).toBe('t')
    const noBlockId = wf({}) as Workflow
    expect(triggerNode(noBlockId)?.id).toBe('t')
  })

  it('croner accepts the specific-day dow pattern shape used by refresh()', () => {
    // Days 1 and 5 at 09:30 (Mon, Fri) — the exact pattern construction.
    const cron = new Cron(`30 9 * * 1,5`, () => {})
    expect(cron.nextRun()).not.toBeNull()
    cron.stop()
  })

  it('coerces interval minutes like the extension (1..1440, bad input → 60)', () => {
    expect(coerceIntervalMinutes(0)).toBe(1)
    expect(coerceIntervalMinutes(7)).toBe(7)
    expect(coerceIntervalMinutes(9999)).toBe(1440)
    expect(coerceIntervalMinutes(undefined)).toBe(60)
    expect(coerceIntervalMinutes('abc')).toBe(60)
  })
})

describe('schedule overview', () => {
  function triggerWf(id: string, triggerData: Record<string, unknown>, top?: Record<string, unknown>): Workflow {
    return {
      id,
      name: `W-${id}`,
      ...(top ? { trigger: top } : {}),
      drawflow: {
        nodes: [{ id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger', ...triggerData } }],
        edges: [],
      },
    } as unknown as Workflow
  }

  it('lists time-triggered workflows with armed state and next run; disabled stay listed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-sched-'))
    try {
      const config = {
        ...loadConfig(),
        dataDir: dir,
        workflowsFile: join(dir, 'wf.json'),
        workflowsExtraDir: '',
        token: '',
      }
      const library = new WorkflowLibrary(config.workflowsFile)
      library.load()
      library.importPayload([
        triggerWf('on', { type: 'interval', interval: 30 }),
        triggerWf('off', { type: 'interval', interval: 15 }, { type: 'interval', enabled: false }),
        triggerWf('manual', {}),
      ])

      const runs = { start: () => 'r1' } as unknown as RunService
      const scheduler = new Scheduler(config, library, runs)
      scheduler.refresh()

      const entries = scheduler.scheduleOverview()
      expect(entries.map((entry) => entry.workflowId).sort()).toEqual(['off', 'on'])

      const on = entries.find((entry) => entry.workflowId === 'on')!
      expect(on.kind).toBe('interval')
      expect(on.detail).toBe('每 30 分钟')
      expect(on.enabled).toBe(true)
      expect(on.armed).toBe(true)
      expect(on.nextRunAt).toBeTruthy()

      const off = entries.find((entry) => entry.workflowId === 'off')!
      expect(off.enabled).toBe(false)
      expect(off.armed).toBe(false)
      expect(off.nextRunAt).toBeUndefined()

      scheduler.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

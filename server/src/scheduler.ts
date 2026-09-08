/**
 * The server scheduler: arms time-based workflow triggers, the server
 * counterpart of `background/workflow-triggers.ts`.
 *
 * Supported trigger shapes (read from the trigger block node, falling back to
 * the top-level `trigger` field — same precedence as the extension):
 * - `interval` → re-arms `minutes` after each fire (no cron drift);
 * - `specific-day` → weekly days+time (cron dow list);
 * - `date` → a one-shot run at the given date+time;
 * - `scheduled` → a 5-field cron expression (server-only extension; the
 *   extension leaves this type unarmed).
 *
 * The schedule is recomputed on every {@link refresh} — the import / upsert
 * API calls it, so edited workflows re-arm without a restart.
 *
 * @module server/scheduler
 */

import { Cron } from 'croner'
import { coerceIntervalMinutes } from '../../src/lib/schedule'
import type { Workflow, WorkflowNode } from '../../src/lib/workflow/types'
import type { RunnerConfig } from './config'
import type { RunService } from './run-service'
import type { WorkflowLibrary } from './workflow-library'

type TriggerKind = 'manual' | 'interval' | 'specific-day' | 'date' | 'scheduled'

/** The trigger block node of a workflow (by blockId or label). */
export function triggerNode(wf: Workflow): WorkflowNode | undefined {
  return wf.drawflow.nodes.find(
    (node) => (node.data?.['blockId'] as string) === 'trigger' || node.label === 'trigger',
  )
}

/** Effective trigger kind: trigger-node `data.type`, then top-level `trigger.type`. */
export function effectiveKind(wf: Workflow): TriggerKind {
  const fromBlock = triggerNode(wf)?.data?.['type'] as TriggerKind | undefined
  if (fromBlock) return fromBlock
  const top = wf.trigger?.type
  if (top === 'scheduled') return 'scheduled'
  return 'manual'
}

/** Whether time-based arming is on (`trigger.enabled !== false`). */
export function enabled(wf: Workflow): boolean {
  return wf.trigger?.enabled !== false
}

/** Parses `HH:MM` (or `H:MM`) into clamped hour/minute; bad input → 00:00. */
export function parseTime(value: unknown): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof value === 'string' ? value : '')
  if (!match) return { hour: 0, minute: 0 }
  return { hour: clamp(Number(match[1]), 0, 23), minute: clamp(Number(match[2]), 0, 59) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isNaN(value) ? min : value)))
}

/** One armed workflow: its timer and what it does on fire. */
interface Armed {
  timer: ReturnType<typeof setTimeout>
  kind: 'interval' | 'once' | 'cron'
  cron?: Cron
}

export class Scheduler {
  private armed = new Map<string, Armed>()

  constructor(
    private readonly config: RunnerConfig,
    private readonly library: WorkflowLibrary,
    private readonly runs: RunService,
  ) {}

  /** (Re)arms every time-based workflow. Safe to call repeatedly. */
  refresh(): void {
    for (const [id, armed] of this.armed) {
      clearTimeout(armed.timer)
      armed.cron?.stop()
      this.armed.delete(id)
    }
    for (const workflow of this.library.list()) {
      if (!enabled(workflow)) continue
      const kind = effectiveKind(workflow)
      const data = triggerNode(workflow)?.data ?? {}
      try {
        if (kind === 'interval') {
          const minutes = coerceIntervalMinutes(data['interval'])
          this.armInterval(workflow.id, minutes)
        } else if (kind === 'specific-day') {
          const rawDays = Array.isArray(data['days']) ? (data['days'] as unknown[]) : []
          const days = [...new Set(rawDays.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
          if (days.length === 0) continue
          const { hour, minute } = parseTime(data['time'])
          // Cron dow: 0=Sunday…6=Saturday — matches Date.getDay().
          const pattern = `${minute} ${hour} * * ${days.join(',')}`
          this.armCron(workflow.id, pattern)
        } else if (kind === 'date') {
          const dateStr = typeof data['date'] === 'string' ? data['date'] : ''
          if (!dateStr) continue
          const { hour, minute } = parseTime(data['time'])
          const epoch = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime()
          if (!Number.isFinite(epoch) || epoch <= Date.now()) continue
          this.armOnce(workflow.id, epoch - Date.now())
        } else if (kind === 'scheduled') {
          const pattern = wfScheduleText(workflow)
          if (!pattern) continue
          this.armCron(workflow.id, pattern)
        }
      } catch (error) {
        console.warn(`[scheduler] workflow ${workflow.id} (${workflow.name}) trigger failed to arm: ${(error as Error).message}`)
      }
    }
    if (this.armed.size > 0) {
      console.log(`[scheduler] ${this.armed.size} workflow trigger(s) armed`)
    }
  }

  private armInterval(workflowId: string, minutes: number): void {
    const fire = (): void => {
      this.fire(workflowId, 'cron')
      const armed = this.armed.get(workflowId)
      if (!armed) return
      armed.timer = setTimeout(fire, minutes * 60_000)
    }
    const timer = setTimeout(fire, minutes * 60_000)
    this.armed.set(workflowId, { timer, kind: 'interval' })
  }

  private armOnce(workflowId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.armed.delete(workflowId)
      this.fire(workflowId, 'cron')
    }, delayMs)
    this.armed.set(workflowId, { timer, kind: 'once' })
  }

  private armCron(workflowId: string, pattern: string): void {
    const cron = new Cron(pattern, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, () => {
      this.fire(workflowId, 'cron')
    })
    const timer = setTimeout(() => {}, 0) // placeholder handle (cron manages itself)
    this.armed.set(workflowId, { timer, kind: 'cron', cron })
  }

  private fire(workflowId: string, source: 'cron'): void {
    const workflow = this.library.get(workflowId)
    if (!workflow) return
    console.log(`[scheduler] firing workflow ${workflow.name} (${workflowId})`)
    try {
      this.runs.start({ workflow, workflowId, source })
    } catch (error) {
      console.warn(`[scheduler] run start failed: ${(error as Error).message}`)
    }
  }

  stop(): void {
    for (const armed of this.armed.values()) {
      clearTimeout(armed.timer)
      armed.cron?.stop()
    }
    this.armed.clear()
  }
}

/** The cron text for a `scheduled` trigger (top-level field or node data). */
function wfScheduleText(workflow: Workflow): string | undefined {
  const top = typeof workflow.trigger?.schedule === 'string' ? workflow.trigger.schedule : undefined
  if (top && top.trim()) return top.trim()
  const fromNode = triggerNode(workflow)?.data?.['schedule']
  return typeof fromNode === 'string' && fromNode.trim() ? fromNode.trim() : undefined
}

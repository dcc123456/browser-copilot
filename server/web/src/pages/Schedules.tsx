import { useCallback, useEffect, useState } from 'react'
import { api, type ScheduleEntry } from '../api'
import { Badge, Btn, Card, Empty, Notice, formatTime } from '../ui'

// The edited workflow shape stays untyped here — the server is the schema.
type AnyWorkflow = Record<string, unknown>

const KIND_LABEL: Record<ScheduleEntry['kind'], string> = {
  manual: '手动',
  interval: '固定间隔',
  'specific-day': '每周定时',
  date: '指定日期',
  scheduled: 'Cron',
}

/**
 * The schedule overview: every workflow with a time trigger, armed or not.
 * The enable/disable toggle writes `trigger.enabled` on the workflow.
 */
export function SchedulesPage({ go }: { go: (page: 'workflows') => void }) {
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.get<{ schedules: ScheduleEntry[] }>('/api/schedules')
      setEntries(result.schedules)
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (entry: ScheduleEntry): Promise<void> => {
    setBusyId(entry.workflowId)
    try {
      const result = await api.get<{ workflow: AnyWorkflow }>(
        `/api/workflows/${encodeURIComponent(entry.workflowId)}`,
      )
      const workflow = result.workflow
      workflow['trigger'] = {
        // asWorkflow keeps the top-level trigger only when `type` is a string.
        type: entry.kind === 'manual' ? 'interval' : entry.kind,
        enabled: !entry.enabled,
      }
      await api.put(`/api/workflows/${encodeURIComponent(entry.workflowId)}`, workflow)
      await load()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-base font-semibold">定时任务（{entries.length}）</h1>
      {error && <Notice>{error}</Notice>}

      <Card>
        {entries.length === 0 ? (
          <Empty>没有配置定时触发的工作流 —— 在「工作流」页对某个工作流点「定时」配置</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">工作流</th>
                <th className="py-2 pr-3 font-medium">类型</th>
                <th className="py-2 pr-3 font-medium">规则</th>
                <th className="py-2 pr-3 font-medium">下次运行</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.workflowId} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3 font-medium">{entry.name}</td>
                  <td className="py-2 pr-3">
                    <Badge tone="accent">{KIND_LABEL[entry.kind]}</Badge>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{entry.detail}</td>
                  <td className="py-2 pr-3 text-xs">{entry.nextRunAt ? formatTime(new Date(entry.nextRunAt).getTime()) : '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={entry.armed ? 'ok' : 'warn'}>{entry.armed ? '运行中' : entry.enabled ? '待生效' : '已停用'}</Badge>
                  </td>
                  <td className="py-2">
                    <div className="flex gap-1.5">
                      <Btn disabled={busyId === entry.workflowId} onClick={() => void toggle(entry)}>
                        {entry.enabled ? '停用' : '启用'}
                      </Btn>
                      <Btn onClick={() => go('workflows')}>去工作流 →</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

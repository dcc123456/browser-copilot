import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type ConfigResponse,
  type RunRecord,
  type RunStatus,
  type ScheduleEntry,
  type WorkflowListItem,
} from '../api'
import { Badge, Btn, Card, Empty, Notice, formatDuration, formatTime } from '../ui'

const STATUS_TONE: Record<RunStatus, 'ok' | 'err' | 'warn' | 'accent' | 'muted'> = {
  ok: 'ok',
  failed: 'err',
  cancelled: 'warn',
  running: 'accent',
  queued: 'muted',
}

const STATUS_TEXT: Record<RunStatus, string> = {
  ok: '完成',
  failed: '失败',
  cancelled: '已取消',
  running: '运行中',
  queued: '排队中',
}

export function DashboardPage({ go }: { go: (page: 'runs') => void }) {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [runNotice, setRunNotice] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const [wf, sched, runList, cfg] = await Promise.all([
        api.get<{ workflows: WorkflowListItem[] }>('/api/workflows'),
        api.get<{ schedules: ScheduleEntry[] }>('/api/schedules'),
        api.get<{ runs: RunRecord[] }>('/api/runs'),
        api.get<ConfigResponse>('/api/config'),
      ])
      setWorkflows(wf.workflows)
      setSchedules(sched.schedules)
      setRuns(runList.runs)
      setConfig(cfg)
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const quickRun = async (): Promise<void> => {
    if (!selected) return
    setRunNotice('')
    try {
      const result = await api.post<{ runId: string }>('/api/runs', { workflowId: selected })
      setRunNotice(`已提交运行 ${result.runId}`)
      go('runs')
    } catch (cause) {
      setRunNotice((cause as Error).message)
    }
  }

  const armed = schedules.filter((entry) => entry.armed).length

  return (
    <div className="space-y-4">
      <h1 className="text-base font-semibold">仪表盘</h1>
      {error && <Notice>{error}</Notice>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <p className="text-xs text-muted">工作流</p>
          <p className="mt-1 text-2xl font-semibold">{workflows.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">定时任务（已启用 / 全部）</p>
          <p className="mt-1 text-2xl font-semibold">
            {armed}
            <span className="text-sm text-faint"> / {schedules.length}</span>
          </p>
        </Card>
        <Card>
          <p className="text-xs text-muted">浏览器</p>
          <p className="mt-1 text-sm font-medium">
            {config ? `${config.config.browser.mode === 'cdp' ? 'CDP 远端' : '本地 Chromium'}${config.config.browser.headless ? ' · 无头' : ''}` : '—'}
          </p>
          <p className="text-xs text-faint">并发上限 {config?.config.browser.maxConcurrent ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">飞书机器人</p>
          <p className="mt-1 text-sm font-medium">
            {config?.config.feishu.botEnabled ? (
              <span className={config.feishuConnected ? 'text-ok' : 'text-warn'}>
                {config.feishuConnected ? '● 已连接' : '● 未连接'}
              </span>
            ) : (
              <span className="text-faint">未启用</span>
            )}
          </p>
          <p className="text-xs text-faint">Token {config?.config.token.set ? '已设置' : '未设置'}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="快速运行">
          <div className="flex gap-2">
            <select className="flex-1 rounded-md border border-border bg-sunken px-2 py-1.5 text-sm" value={selected} onChange={(event) => setSelected(event.target.value)}>
              <option value="">选择要运行的工作流…</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
            <Btn tone="primary" disabled={!selected} onClick={() => void quickRun()}>
              运行
            </Btn>
          </div>
          {runNotice && <p className="mt-2 text-xs text-muted">{runNotice}</p>}
        </Card>

        <Card
          title="最近运行"
          actions={
            <Btn onClick={() => go('runs')}>全部记录 →</Btn>
          }
        >
          {runs.length === 0 ? (
            <Empty>还没有运行记录</Empty>
          ) : (
            <ul className="space-y-1.5">
              {runs.slice(0, 5).map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone={STATUS_TONE[run.status]}>{STATUS_TEXT[run.status]}</Badge>
                    <span className="truncate">{run.label}</span>
                  </span>
                  <span className="shrink-0 text-xs text-faint">
                    {formatTime(run.startedAt)} · {formatDuration(run.startedAt, run.finishedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

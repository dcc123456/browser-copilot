import { useCallback, useEffect, useState } from 'react'
import { api, type RunRecord, type RunStatus } from '../api'
import { Badge, Btn, Card, Empty, Notice, formatDuration, formatTime, inputClass } from '../ui'

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

const SOURCE_TEXT: Record<string, string> = {
  api: 'API',
  cron: '定时',
  webhook: 'Webhook',
  feishu: '飞书',
}

const STEP_COLOR: Record<string, string> = {
  info: 'text-muted',
  result: 'text-ok',
  error: 'text-err',
  warn: 'text-warn',
}

export function RunsPage() {
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [detail, setDetail] = useState<RunRecord | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.get<{ runs: RunRecord[] }>('/api/runs')
      setRuns(result.runs)
      setError('')
      // Refresh the open detail so a running run shows live steps.
      setDetail((current) => {
        if (!current) return current
        const fresh = result.runs.find((run) => run.id === current.id)
        return fresh ?? current
      })
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 4_000)
    return () => clearInterval(timer)
  }, [load])

  const openDetail = async (id: string): Promise<void> => {
    try {
      setDetail(await api.get<RunRecord>(`/api/runs/${encodeURIComponent(id)}`))
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const cancel = async (id: string): Promise<void> => {
    try {
      await api.del(`/api/runs/${encodeURIComponent(id)}`)
      await load()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const visible = filter
    ? runs.filter((run) => run.label.includes(filter) || run.id.includes(filter))
    : runs

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">运行记录</h1>
        <div className="flex items-center gap-2">
          <input
            className={`${inputClass} w-52`}
            placeholder="按名称或 runId 过滤"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <Btn onClick={() => void load()}>刷新</Btn>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}

      <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
        <Card>
          {visible.length === 0 ? (
            <Empty>暂无运行记录</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 pr-3 font-medium">工作流</th>
                  <th className="py-2 pr-3 font-medium">来源</th>
                  <th className="py-2 pr-3 font-medium">开始时间</th>
                  <th className="py-2 pr-3 font-medium">耗时</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr
                    key={run.id}
                    className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-hover ${detail?.id === run.id ? 'bg-accent-soft' : ''}`}
                    onClick={() => void openDetail(run.id)}
                  >
                    <td className="py-2 pr-3">
                      <Badge tone={STATUS_TONE[run.status]}>{STATUS_TEXT[run.status]}</Badge>
                    </td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{run.label}</span>
                      <span className="block font-mono text-xs text-faint">{run.id}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-faint">{SOURCE_TEXT[run.source] ?? run.source}</td>
                    <td className="py-2 pr-3 text-xs text-faint">{formatTime(run.startedAt)}</td>
                    <td className="py-2 pr-3 text-xs text-faint">{formatDuration(run.startedAt, run.finishedAt)}</td>
                    <td className="py-2">
                      {(run.status === 'queued' || run.status === 'running') && (
                        <Btn
                          tone="danger"
                          onClick={(event) => {
                            event.stopPropagation()
                            void cancel(run.id)
                          }}
                        >
                          取消
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={detail ? `运行详情 · ${detail.label}` : '运行详情'}>
          {!detail ? (
            <Empty>点击左侧记录查看逐步日志</Empty>
          ) : (
            <div className="space-y-3">
              <div className="text-xs text-muted">
                <p>runId: <span className="font-mono">{detail.id}</span></p>
                <p>
                  状态 <Badge tone={STATUS_TONE[detail.status]}>{STATUS_TEXT[detail.status]}</Badge> · 耗时{' '}
                  {formatDuration(detail.startedAt, detail.finishedAt)}
                </p>
                {detail.summary && <p className="mt-1 text-ink">摘要：{detail.summary}</p>}
                {detail.error && <p className="mt-1 text-err break-all">错误：{detail.error}</p>}
              </div>
              <div className="max-h-[60vh] space-y-1 overflow-y-auto rounded-md border border-border bg-sunken p-2">
                {(detail.steps ?? []).length === 0 ? (
                  <p className="text-xs text-faint">（无步骤记录）</p>
                ) : (
                  (detail.steps ?? []).map((step, index) => (
                    <p key={index} className="text-xs leading-relaxed">
                      <span className="mr-1 font-mono text-faint">
                        {new Date(step.at).toLocaleTimeString('zh-CN', { hour12: false })}
                      </span>
                      <span className={`${STEP_COLOR[step.kind] ?? 'text-muted'} break-all`}>{step.text}</span>
                    </p>
                  ))
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

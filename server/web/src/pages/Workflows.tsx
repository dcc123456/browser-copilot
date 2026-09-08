import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  ApiError,
  type ImportResult,
  type ReferenceReport,
  type ScheduleEntry,
  type TriggerKind,
  type WorkflowListItem,
} from '../api'
import { Badge, Btn, Card, Empty, Field, Modal, Notice, formatTime, inputClass } from '../ui'
import { JsonEditor } from '../json-editor'
import type { PageKey } from '../App'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWorkflow = Record<string, any>

const TRIGGER_LABEL: Record<TriggerKind, string> = {
  manual: '手动',
  interval: '固定间隔',
  'specific-day': '每周定时',
  date: '指定日期',
  scheduled: 'Cron',
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function blankWorkflow(): AnyWorkflow {
  const id = `wf-${Date.now().toString(36)}`
  return {
    id,
    name: '新工作流',
    drawflow: {
      nodes: [
        { id: 'trigger', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger', type: 'manual' } },
      ],
      edges: [],
    },
  }
}

function triggerNodeOf(workflow: AnyWorkflow): AnyWorkflow | undefined {
  const nodes = (workflow?.drawflow?.nodes ?? []) as AnyWorkflow[]
  return nodes.find((node) => node?.data?.blockId === 'trigger' || node?.label === 'trigger')
}

interface ScheduleForm {
  kind: TriggerKind
  enabled: boolean
  interval: string
  days: number[]
  time: string
  date: string
  cron: string
}

function scheduleFormOf(workflow: AnyWorkflow): ScheduleForm {
  const node = triggerNodeOf(workflow)
  const data = node?.data ?? {}
  const top = (workflow.trigger ?? {}) as AnyWorkflow
  const kind = (data.type ?? top.type ?? 'manual') as TriggerKind
  return {
    kind,
    enabled: top.enabled !== false,
    interval: String(data.interval ?? 60),
    days: Array.isArray(data.days) ? (data.days as number[]).map(Number) : [],
    time: typeof data.time === 'string' ? data.time : '09:00',
    date: typeof data.date === 'string' ? data.date : '',
    cron: typeof (data.schedule ?? top.schedule) === 'string' ? (data.schedule ?? top.schedule) : '0 9 * * 1-5',
  }
}

function applySchedule(workflow: AnyWorkflow, form: ScheduleForm): void {
  const node = triggerNodeOf(workflow)
  if (!node) throw new Error('该工作流没有 trigger 节点，无法配置定时（请在扩展中先加触发器）')
  node.data = { ...node.data, type: form.kind }
  for (const key of ['interval', 'days', 'time', 'date', 'schedule']) delete node.data[key]
  if (form.kind === 'interval') node.data.interval = Number(form.interval) || 60
  if (form.kind === 'specific-day') {
    node.data.days = form.days
    node.data.time = form.time
  }
  if (form.kind === 'date') {
    node.data.date = form.date
    node.data.time = form.time
  }
  if (form.kind === 'scheduled') node.data.schedule = form.cron

  if (form.kind === 'manual') delete workflow.trigger
  else
    workflow.trigger = {
      type: form.kind,
      enabled: form.enabled,
      ...(form.kind === 'scheduled' ? { schedule: form.cron } : {}),
    }
}

export function WorkflowsPage({ go }: { go: (page: 'runs') => void }) {
  const [items, setItems] = useState<WorkflowListItem[]>([])
  const [schedules, setSchedules] = useState<Map<string, ScheduleEntry>>(new Map())
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  // Modals.
  const [importOpen, setImportOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<{ id: string; name: string; text: string } | null>(null)
  const [scheduleTarget, setScheduleTarget] = useState<{ id: string; name: string; workflow: AnyWorkflow } | null>(null)
  const [references, setReferences] = useState<ReferenceReport | null>(null)
  const [runTarget, setRunTarget] = useState<WorkflowListItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkflowListItem | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [wf, sched] = await Promise.all([
        api.get<{ workflows: WorkflowListItem[] }>('/api/workflows'),
        api.get<{ schedules: ScheduleEntry[] }>('/api/schedules'),
      ])
      setItems(wf.workflows)
      setSchedules(new Map(sched.schedules.map((entry) => [entry.workflowId, entry])))
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">工作流（{items.length}）</h1>
        <div className="flex gap-2">
          <Btn onClick={() => setEditTarget({ id: '', name: '', text: JSON.stringify(blankWorkflow(), null, 2) })}>
            ＋ 新建
          </Btn>
          <Btn tone="primary" onClick={() => setImportOpen(true)}>
            导入 JSON
          </Btn>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}

      <Card>
        {items.length === 0 ? (
          <Empty>库中还没有工作流：从扩展导出 workflows.json 后导入，或新建一个</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">名称</th>
                <th className="py-2 pr-3 font-medium">触发</th>
                <th className="py-2 pr-3 font-medium">ID</th>
                <th className="py-2 pr-3 font-medium">更新时间</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const schedule = schedules.get(item.id)
                return (
                  <tr key={item.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{item.name}</span>
                      {item.description && <span className="block text-xs text-faint">{item.description}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {schedule ? (
                        <Badge tone={schedule.armed ? 'accent' : 'warn'}>
                          {TRIGGER_LABEL[schedule.kind]} · {schedule.armed ? '已启用' : '已停用'}
                        </Badge>
                      ) : (
                        <Badge>手动</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-faint">{item.id}</td>
                    <td className="py-2 pr-3 text-xs text-faint">{formatTime(item.updatedAt)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1.5">
                        <Btn tone="primary" onClick={() => setRunTarget(item)}>
                          运行
                        </Btn>
                        <Btn onClick={() => void openEditor(item.id)}>编辑</Btn>
                        <Btn onClick={() => void openSchedule(item.id)}>定时</Btn>
                        <Btn onClick={() => void openReferences(item.id)}>引用</Btn>
                        <Btn onClick={() => void download(item)}>下载</Btn>
                        <Btn tone="danger" onClick={() => setDeleteTarget(item)}>
                          删除
                        </Btn>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => void load()} />}
      {editTarget && (
        <EditModal
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null)
            void load()
          }}
        />
      )}
      {scheduleTarget && (
        <ScheduleModal
          target={scheduleTarget}
          onClose={() => setScheduleTarget(null)}
          onSaved={() => {
            setScheduleTarget(null)
            void load()
          }}
        />
      )}
      {references && <ReferencesModal report={references} onClose={() => setReferences(null)} />}
      {runTarget && <RunModal item={runTarget} onClose={() => setRunTarget(null)} go={go} />}
      {deleteTarget && (
        <DeleteModal
          item={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={() => {
            setDeleteTarget(null)
            void load()
          }}
        />
      )}
    </div>
  )

  async function openEditor(id: string): Promise<void> {
    try {
      const result = await api.get<{ workflow: AnyWorkflow }>(`/api/workflows/${encodeURIComponent(id)}`)
      setEditTarget({ id, name: result.workflow.name ?? id, text: JSON.stringify(result.workflow, null, 2) })
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function openSchedule(id: string): Promise<void> {
    try {
      const result = await api.get<{ workflow: AnyWorkflow }>(`/api/workflows/${encodeURIComponent(id)}`)
      setScheduleTarget({ id, name: result.workflow.name ?? id, workflow: result.workflow })
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function openReferences(id: string): Promise<void> {
    try {
      setReferences(await api.get<ReferenceReport>(`/api/workflows/${encodeURIComponent(id)}/references`))
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function download(item: WorkflowListItem): Promise<void> {
    try {
      const result = await api.get<{ workflow: AnyWorkflow }>(`/api/workflows/${encodeURIComponent(item.id)}`)
      const blob = new Blob([JSON.stringify(result.workflow, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${item.name || item.id}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }
}

// --- Modals --------------------------------------------------------------------

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const payload = JSON.parse(text) as unknown
      setResult(await api.post<ImportResult>('/api/workflows/import', payload))
      onDone()
    } catch (cause) {
      if (cause instanceof ApiError) setError(`${cause.message}${cause.body?.hint ? `\n${cause.body.hint}` : ''}`)
      else setError(`JSON 解析失败：${(cause as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async (file: File): Promise<void> => {
    setText(await file.text())
    setResult(null)
  }

  return (
    <Modal title="导入工作流 JSON" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          支持扩展导出的 workflows.json（数组、带 workflows 字段的对象或单个工作流对象）。嵌套子流程建议一并导入，导入结果会逐条报告缺失项。
        </p>
        <div className="flex gap-2">
          <input
            type="file"
            accept=".json,application/json"
            className="text-xs text-muted"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void pickFile(file)
            }}
          />
        </div>
        <textarea
          className={`${inputClass} h-40 font-mono text-xs`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='粘贴 JSON，例如 [{ "id": "…", "name": "…", "drawflow": { … } }]'
        />
        {error && <Notice>{error}</Notice>}
        {result && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted">
              导入 {result.imported} 条，跳过 {result.skipped} 条
            </p>
            {result.entries.map((entry) => (
              <div key={entry.index} className="rounded-md border border-border px-2.5 py-1.5 text-xs">
                <span className={entry.ok ? 'text-ok' : 'text-err'}>{entry.ok ? '✅' : '❌'} </span>
                <span className="font-medium">{entry.name || '(未命名)'}</span>
                <span className="ml-1 font-mono text-faint">{entry.id}</span>
                {entry.error && <span className="ml-2 text-err">{entry.error}</span>}
                {entry.ok && entry.warnings.length > 0 && <span className="ml-2 text-warn">校验警告 ×{entry.warnings.length}</span>}
                {entry.ok && entry.missing.length > 0 && (
                  <span className="ml-2 text-warn">缺少子工作流：{entry.missing.join('、')}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>关闭</Btn>
          <Btn tone="primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? '导入中…' : '导入'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function EditModal({
  target,
  onClose,
  onSaved,
}: {
  target: { id: string; name: string; text: string }
  onClose: () => void
  onSaved: () => void
}) {
  const [text, setText] = useState(target.text)
  const [id, setId] = useState(target.id)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const parsed = useMemo(() => {
    if (!text.trim()) return { ok: false as const, error: '内容为空' }
    try {
      const value = JSON.parse(text) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false as const, error: '必须是 JSON 对象' }
      return { ok: true as const, value: value as AnyWorkflow }
    } catch (cause) {
      return { ok: false as const, error: (cause as Error).message }
    }
  }, [text])

  const effectiveId = id.trim() || (parsed.ok ? String(parsed.value.id ?? '') : '')

  const save = async (): Promise<void> => {
    if (!parsed.ok) return
    if (!effectiveId) {
      setError('请填写工作流 ID（或让 JSON 中的 id 字段提供）')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.put(`/api/workflows/${encodeURIComponent(effectiveId)}`, parsed.value)
      onSaved()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={target.id ? `编辑工作流：${target.name}` : '新建工作流'} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="工作流 ID（保存目标，嵌套引用按此 ID 匹配）" hint="改 ID 等于新建；嵌套子流程按 ID 引用，改 ID 会断开父流程的引用。">
          <input className={inputClass} value={id} onChange={(event) => setId(event.target.value)} placeholder="来自 JSON 的 id 字段" />
        </Field>
        <JsonEditor
          key={`${target.id}-${target.text.length}`}
          value={text}
          onChange={setText}
        />
        {!parsed.ok && <Notice tone="warn">JSON 未通过校验：{parsed.error}</Notice>}
        {error && <Notice>{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Btn
            onClick={() => {
              if (parsed.ok) setText(JSON.stringify(parsed.value, null, 2))
            }}
            disabled={!parsed.ok}
          >
            格式化
          </Btn>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!parsed.ok || busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function ScheduleModal({
  target,
  onClose,
  onSaved,
}: {
  target: { id: string; name: string; workflow: AnyWorkflow }
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ScheduleForm>(() => scheduleFormOf(target.workflow))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const toggleDay = (day: number): void => {
    setForm((current) => ({
      ...current,
      days: current.days.includes(day) ? current.days.filter((value) => value !== day) : [...current.days, day].sort(),
    }))
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const workflow: AnyWorkflow = structuredClone(target.workflow)
      applySchedule(workflow, form)
      await api.put(`/api/workflows/${encodeURIComponent(target.id)}`, workflow)
      onSaved()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`定时设置：${target.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="触发方式">
          <select className={inputClass} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as TriggerKind })}>
            <option value="manual">手动（不定时）</option>
            <option value="interval">固定间隔</option>
            <option value="specific-day">每周指定日 + 时间</option>
            <option value="date">指定日期 + 时间（单次）</option>
            <option value="scheduled">Cron 表达式</option>
          </select>
        </Field>

        {form.kind === 'interval' && (
          <Field label="间隔（分钟，1–1440）">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={1440}
              value={form.interval}
              onChange={(event) => setForm({ ...form, interval: event.target.value })}
            />
          </Field>
        )}

        {form.kind === 'specific-day' && (
          <>
            <Field label="星期">
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((label, index) => (
                  <Btn
                    key={label}
                    tone={form.days.includes(index) ? 'primary' : 'ghost'}
                    onClick={() => toggleDay(index)}
                  >
                    {label}
                  </Btn>
                ))}
              </div>
            </Field>
            <Field label="时间">
              <input className={inputClass} type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
            </Field>
          </>
        )}

        {form.kind === 'date' && (
          <>
            <Field label="日期（单次运行）">
              <input className={inputClass} type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
            </Field>
            <Field label="时间">
              <input className={inputClass} type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
            </Field>
          </>
        )}

        {form.kind === 'scheduled' && (
          <Field label="Cron 表达式（5 段：分 时 日 月 周）" hint="例：0 9 * * 1-5 工作日每天 09:00；时区取服务器本地时区。">
            <input className={`${inputClass} font-mono`} value={form.cron} onChange={(event) => setForm({ ...form, cron: event.target.value })} />
          </Field>
        )}

        {form.kind !== 'manual' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
            启用定时触发
          </label>
        )}

        {error && <Notice>{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function ReferencesModal({ report, onClose }: { report: ReferenceReport; onClose: () => void }) {
  return (
    <Modal title={`引用检查：${report.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>
          <p className="mb-1 text-xs font-medium text-muted">execute-workflow 引用（{report.references.length}）</p>
          {report.references.length === 0 ? (
            <p className="text-xs text-faint">无嵌套引用</p>
          ) : (
            <ul className="space-y-1">
              {report.references.map((reference) => (
                <li key={reference.nodeId} className="text-xs">
                  <span className="font-mono text-faint">[{reference.nodeLabel}]</span> →{' '}
                  <span className="font-mono">{reference.childId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">缺失的子工作流（{report.missing.length}）</p>
          {report.missing.length === 0 ? (
            <p className="text-xs text-ok">完整，可直接运行</p>
          ) : (
            <Notice tone="warn">缺失：{report.missing.join('、')} —— 请把包含它们的 workflows.json 一并导入</Notice>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">循环引用（{report.cycles.length}）</p>
          {report.cycles.length === 0 ? (
            <p className="text-xs text-faint">无</p>
          ) : (
            <Notice tone="warn">
              {report.cycles.map((cycle) => cycle.join(' → ')).map((text, index) => (
                <span key={index} className="block font-mono text-xs">{text}</span>
              ))}
            </Notice>
          )}
        </div>
      </div>
    </Modal>
  )
}

function RunModal({
  item,
  onClose,
  go,
}: {
  item: WorkflowListItem
  onClose: () => void
  go: (page: 'runs') => void
}) {
  const [variablesText, setVariablesText] = useState('')
  const [error, setError] = useState('')
  const [runId, setRunId] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      let variables: Record<string, unknown> | undefined
      if (variablesText.trim()) {
        const parsed = JSON.parse(variablesText) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('变量必须是 JSON 对象')
        variables = parsed as Record<string, unknown>
      }
      const result = await api.post<{ runId: string }>('/api/runs', { workflowId: item.id, variables })
      setRunId(result.runId)
    } catch (cause) {
      if (cause instanceof ApiError && cause.body?.missing) {
        setError(`${cause.message}\n缺失：${cause.body.missing.join('、')}${cause.body.hint ? `\n${cause.body.hint}` : ''}`)
      } else {
        setError((cause as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`运行工作流：${item.name}`} onClose={onClose}>
      {runId ? (
        <div className="space-y-3">
          <Notice tone="ok">已提交运行（runId: {runId}）</Notice>
          <div className="flex justify-end gap-2">
            <Btn onClick={onClose}>关闭</Btn>
            <Btn tone="primary" onClick={() => { onClose(); go('runs') }}>
              查看运行记录 →
            </Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="运行变量（可选，JSON 对象）" hint="会注入工作流变量，如 {&quot;keyword&quot;: &quot;手机&quot;}">
            <textarea
              className={`${inputClass} h-24 font-mono text-xs`}
              value={variablesText}
              onChange={(event) => setVariablesText(event.target.value)}
              placeholder='{"keyword": "…"}'
            />
          </Field>
          {error && <Notice>{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Btn onClick={onClose}>取消</Btn>
            <Btn tone="primary" disabled={busy} onClick={() => void run()}>
              {busy ? '提交中…' : '开始运行'}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

function DeleteModal({ item, onClose, onDone }: { item: WorkflowListItem; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.del(`/api/workflows/${encodeURIComponent(item.id)}`)
      onDone()
    } catch (cause) {
      setError((cause as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="删除工作流" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">
          确认删除「{item.name}」
          <span className="ml-1 font-mono text-xs text-faint">({item.id})</span>？
          <span className="mt-1 block text-xs text-muted">若有其他工作流引用它作为子流程，那些流程将无法运行。</span>
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? '删除中…' : '确认删除'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

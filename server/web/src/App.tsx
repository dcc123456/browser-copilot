import { useCallback, useEffect, useState } from 'react'
import { api, getToken, setToken, setUnauthorizedHandler, type ConfigResponse } from './api'
import { Btn, Field, inputClass } from './ui'
import { DashboardPage } from './pages/Dashboard'
import { WorkflowsPage } from './pages/Workflows'
import { SchedulesPage } from './pages/Schedules'
import { RunsPage } from './pages/Runs'
import { SettingsPage } from './pages/Settings'

export type PageKey = 'dashboard' | 'workflows' | 'schedules' | 'runs' | 'settings'

const NAV: { key: PageKey; label: string; icon: string }[] = [
  { key: 'dashboard', label: '仪表盘', icon: '▦' },
  { key: 'workflows', label: '工作流', icon: '⇶' },
  { key: 'schedules', label: '定时任务', icon: '⏱' },
  { key: 'runs', label: '运行记录', icon: '☰' },
  { key: 'settings', label: '设置', icon: '⚙' },
]

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState(getToken())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setToken(value.trim())
    try {
      await api.get('/api/config')
      onSuccess()
    } catch (cause) {
      setToken('')
      setError(cause instanceof Error && cause.message ? cause.message : 'Token 验证失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-panel p-6"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h1 className="mb-1 text-lg font-semibold text-ink">Browser Copilot Runner</h1>
        <p className="mb-5 text-xs text-muted">输入 API Token（BC_TOKEN）进入控制台；服务器未启用鉴权时可直接进入。</p>
        <Field label="API Token">
          <input
            className={inputClass}
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="留空仅在服务器未设置 BC_TOKEN 时可用"
            autoFocus
          />
        </Field>
        {error && <p className="mt-3 text-xs text-err">{error}</p>}
        <div className="mt-5 flex justify-end">
          <Btn tone="primary" type="submit" disabled={busy}>
            {busy ? '验证中…' : '进入控制台'}
          </Btn>
        </div>
      </form>
    </div>
  )
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [noToken, setNoToken] = useState(false)
  const [page, setPage] = useState<PageKey>('dashboard')

  const probe = useCallback(async (): Promise<void> => {
    try {
      const result = await api.get<ConfigResponse>('/api/config')
      setNoToken(!result.config.token.set)
      setAuthed(true)
    } catch {
      setAuthed(false)
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
    void probe()
  }, [probe])

  if (authed === null) {
    return <div className="flex min-h-screen items-center justify-center bg-bg text-sm text-muted">连接中…</div>
  }
  if (!authed) return <LoginScreen onSuccess={() => void probe()} />

  return (
    <div className="flex min-h-screen bg-bg text-ink">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-panel">
        <div className="border-b border-border px-4 py-4">
          <p className="text-sm font-semibold">Browser Copilot</p>
          <p className="text-xs text-faint">服务器运行器控制台</p>
        </div>
        <nav className="flex-1 p-2">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPage(item.key)}
              className={`mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                page === item.key ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <span className="w-4 text-center">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <Btn className="w-full justify-center" onClick={() => { setToken(''); setAuthed(false) }}>
            退出登录
          </Btn>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        {noToken && (
          <div className="mb-4 rounded-md bg-warn-surface px-3 py-2 text-xs text-warn">
            服务器未设置 BC_TOKEN：HTTP API 无鉴权，仅建议内网使用。请在「设置 → 安全」中立即设置。
          </div>
        )}
        {page === 'dashboard' && <DashboardPage go={setPage} />}
        {page === 'workflows' && <WorkflowsPage go={setPage} />}
        {page === 'schedules' && <SchedulesPage go={setPage} />}
        {page === 'runs' && <RunsPage />}
        {page === 'settings' && <SettingsPage onTokenChanged={() => void probe()} />}
      </main>
    </div>
  )
}

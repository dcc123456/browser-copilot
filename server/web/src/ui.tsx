/** Small shared UI primitives — styling is Tailwind utility classes only. */
import type { ReactNode } from 'react'

export function Card({
  title,
  actions,
  children,
}: {
  title?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

const BADGE_TONES = {
  muted: 'bg-panel-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent border-accent-border',
  ok: 'bg-ok-surface text-ok border-transparent',
  err: 'bg-err-surface text-err border-transparent',
  warn: 'bg-warn-surface text-warn border-transparent',
} as const

export function Badge({ tone = 'muted', children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  )
}

const BTN_TONES = {
  primary: 'bg-accent text-on-accent hover:bg-accent-strong',
  ghost: 'border border-border bg-panel-2 text-ink hover:bg-hover',
  danger: 'border border-transparent bg-err-surface text-err hover:bg-hover',
} as const

export function Btn({
  tone = 'ghost',
  className = '',
  children,
  ...rest
}: { tone?: keyof typeof BTN_TONES } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BTN_TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'w-full rounded-md border border-border bg-sunken px-2.5 py-1.5 text-sm text-ink placeholder:text-faint focus:border-accent-border focus:outline-none'

export function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string
  onClose: () => void
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={`flex max-h-[88vh] w-full flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button type="button" className="cursor-pointer rounded px-2 text-muted hover:text-ink" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}

export function Notice({ tone = 'err', children }: { tone?: 'err' | 'ok' | 'warn'; children: ReactNode }) {
  const tones = { err: 'bg-err-surface text-err', ok: 'bg-ok-surface text-ok', warn: 'bg-warn-surface text-warn' }
  return <div className={`rounded-md px-3 py-2 text-xs break-all ${tones[tone]}`}>{children}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>
}

export function formatTime(epoch?: number): string {
  if (!epoch) return '—'
  return new Date(epoch).toLocaleString('zh-CN', { hour12: false })
}

export function formatDuration(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return '—'
  const end = finishedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

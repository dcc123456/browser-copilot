/**
 * Shared form field primitives for block edit forms.
 *
 * React port of Automa's ui-input / ui-textarea / ui-select / ui-checkbox /
 * ui-switch / ui-expand controls, styled with the editor's `--bc-*` variables
 * so they follow the browser light/dark theme. Every form component receives
 * `{ data, onChange }` and only renders labeled fields over those props.
 *
 * @module workflow-editor/blocks/shared/Field
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Merge a partial patch into the block data (Automa's updateData). */
export type Patch = (patch: Record<string, unknown>) => void

export function Field({
  label,
  title,
  children,
}: {
  label?: string
  title?: string
  children: ReactNode
}) {
  return (
    <div className="wf-field" title={title}>
      {label && <label>{label}</label>}
      {children}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  list,
}: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  /** Id of a <datalist> for suggestions. */
  list?: string
}) {
  return (
    <input
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      list={list}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** Auto-growing textarea (Automa's ui-textarea autoresize). */
export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 2,
  mono,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={rows}
      value={value ?? ''}
      placeholder={placeholder}
      className={`${mono ? 'wf-mono' : ''} ${className ?? ''}`}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[] | string[]
}) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        )
      })}
    </select>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  title?: string
}) {
  return (
    <label className="wf-field wf-field-check" title={title}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
}) {
  return (
    <label className="wf-field wf-field-check">
      <input type="checkbox" className="wf-switch" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** Collapsible section (Automa's ui-expand). */
export function Expand({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="wf-expand">
      <button type="button" className="wf-expand-header" onClick={() => setOpen(!open)}>
        <i
          className="ri-arrow-left-s-line"
          style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .15s' }}
        />
        <span>{title}</span>
      </button>
      {open && <div className="wf-expand-body">{children}</div>}
    </div>
  )
}

/** Small icon button used inside forms. */
export function IconButton({
  icon,
  title,
  disabled,
  onClick,
}: {
  icon: string
  title: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button type="button" className="wf-icon-btn" title={title} disabled={disabled} onClick={onClick}>
      <i className={icon} />
    </button>
  )
}

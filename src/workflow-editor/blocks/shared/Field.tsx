/**
 * Shared form field primitives for block edit forms.
 *
 * React port of Automa's ui-input / ui-textarea / ui-select / ui-checkbox /
 * ui-switch / ui-expand controls, styled with the editor's `--bc-*` variables
 * so they follow the browser light/dark theme. Every form component receives
 * `{ data, onChange }` and only renders labeled fields over those props.
 *
 * The two free-text controls also carry the `/` variable menu, so inserting a
 * `{{reference}}` is available in every block form at once — a form opts a field
 * OUT with `noSlash` when that field DEFINES a name instead of referencing one.
 * A field where `/` is ordinary text (a download-relative path) keeps that
 * trigger off and opts into the same menu through a `{}` button instead.
 *
 * @module workflow-editor/blocks/shared/Field
 */

import { Braces, ChevronLeft, Info, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditorLocale } from '../../locale-context'
import NumberInput from '../../../ui/NumberInput'
import { Switch as SharedSwitch } from '../../../ui/Switch'
import { useFieldSlashMenu } from './SlashVariableMenu'

/** Merge a partial patch into the block data (Automa's updateData). */
export type Patch = (patch: Record<string, unknown>) => void

/**
 * Blur-validating number input (shared with the side panel). Re-exported here
 * so block forms can import every field primitive from this one module.
 */
export { NumberInput }

export function Field({
  label,
  title,
  children,
}: {
  label?: string
  title?: string
  children: ReactNode
}) {
  const { bt } = useEditorLocale()
  return (
    <div className="wf-field" title={title ? bt(title) : undefined}>
      {label && <label>{bt(label)}</label>}
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
  fallback,
  noSlash,
  variableMenu,
}: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  /** Id of a <datalist> for suggestions. */
  list?: string
  /**
   * Default written back on blur when the field was left empty (失焦校验).
   * Never coerce on change: the field must stay clearable while typing.
   */
  fallback?: string
  /** Opt out of the `/` variable menu for fields that DEFINE a name. */
  noSlash?: boolean
  /**
   * Offer the same menu through a `{}` button rather than a `/` trigger — for
   * fields where a slash is ordinary text (download-relative file paths).
   */
  variableMenu?: boolean
}) {
  const { bt } = useEditorLocale()
  const ref = useRef<HTMLInputElement>(null)
  // Only a free-text caret can host the menu: a native datalist already
  // suggests there, and a color/range control has no text to anchor to.
  const slashable = !noSlash && !list && type === 'text'
  const menuButton = variableMenu === true && !list && type === 'text'
  const menu = useFieldSlashMenu({
    inputRef: ref,
    onChange,
    disabled: !slashable && !menuButton,
  })
  const input = (
    <input
      ref={ref}
      type={type}
      value={value ?? ''}
      placeholder={placeholder ? bt(placeholder) : placeholder}
      list={list}
      onChange={(e) => {
        onChange(e.target.value)
        // The on-demand list has no query to follow; typing dismisses it.
        if (slashable) menu.sync()
        else if (menuButton) menu.close()
      }}
      onClick={slashable ? () => menu.sync() : undefined}
      onKeyUp={slashable ? () => menu.sync() : undefined}
      onKeyDown={slashable || menuButton ? (e) => menu.onKeyDown(e) : undefined}
      onBlur={() => {
        menu.close()
        if (fallback != null && String(value ?? '').trim() === '') onChange(fallback)
      }}
    />
  )
  const menuNode = slashable || menuButton ? menu.node : null
  if (!menuButton) {
    return (
      <>
        {input}
        {menuNode}
      </>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{input}</div>
      <button
        type="button"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-muted hover:bg-hover hover:text-ink"
        title={bt('Insert variable')}
        aria-label={bt('Insert variable')}
        // Keep a caret the field already owns; `open()` focuses it otherwise.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => menu.open()}
      >
        <Braces size={14} />
      </button>
      {menuNode}
    </div>
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
  fallback,
  noSlash,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  className?: string
  /** Default written back on blur when the field was left empty (失焦校验). */
  fallback?: string
  /** Opt out of the `/` variable menu for fields that DEFINE a name. */
  noSlash?: boolean
}) {
  const { bt } = useEditorLocale()
  const ref = useRef<HTMLTextAreaElement>(null)
  const menu = useFieldSlashMenu({ inputRef: ref, onChange, disabled: noSlash })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <>
      <textarea
        ref={ref}
        rows={rows}
        value={value ?? ''}
        placeholder={placeholder ? bt(placeholder) : placeholder}
        className={`${mono ? 'wf-mono' : ''} ${className ?? ''}`}
        onChange={(e) => {
          onChange(e.target.value)
          if (!noSlash) menu.sync()
        }}
        onClick={noSlash ? undefined : () => menu.sync()}
        onKeyUp={noSlash ? undefined : () => menu.sync()}
        onKeyDown={noSlash ? undefined : (e) => menu.onKeyDown(e)}
        onBlur={() => {
          menu.close()
          if (fallback != null && String(value ?? '').trim() === '') onChange(fallback)
        }}
      />
      {noSlash ? null : menu.node}
    </>
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
  const { bt } = useEditorLocale()
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o
        return (
          <option key={opt.value} value={opt.value}>
            {bt(opt.label)}
          </option>
        )
      })}
    </select>
  )
}

/** Localize a checkbox/switch label when it is a plain string; JSX passes through. */
function LocalizedLabel({ label }: { label: ReactNode }) {
  const { bt } = useEditorLocale()
  if (typeof label !== 'string') return <>{label}</>
  return <>{bt(label)}</>
}

export function Checkbox({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  /** Optional: omit to render the bare control (label lives elsewhere). */
  label?: ReactNode
  title?: string
}) {
  const { bt } = useEditorLocale()
  return (
    <label className="wf-field wf-field-check" title={title ? bt(title) : undefined}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label != null && (
        <span>
          <LocalizedLabel label={label} />
        </span>
      )}
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
  /** Optional: omit to render the bare track (Automa's inline-flex switch). */
  label?: ReactNode
}) {
  return (
    <span className="wf-field wf-field-check">
      <SharedSwitch
        checked={!!checked}
        onChange={onChange}
        label={label != null ? <LocalizedLabel label={label} /> : undefined}
      />
    </span>
  )
}

/** Collapsible section (Automa's ui-expand). */
export function Expand({
  title,
  children,
  defaultOpen = false,
  help,
  helpLabel,
}: {
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  /** Explainer revealed by the header's info toggle; omit the prop for no toggle. */
  help?: ReactNode
  /** Localizable label for the toggle itself. */
  helpLabel?: string
}) {
  const { bt } = useEditorLocale()
  const [open, setOpen] = useState(defaultOpen)
  const [helpOpen, setHelpOpen] = useState(false)
  const helpText = helpLabel ? bt(helpLabel) : undefined
  return (
    <div className="wf-expand">
      <div className="flex items-center">
        <button type="button" className="wf-expand-header flex-1" onClick={() => setOpen(!open)}>
          <ChevronLeft
            size={14}
            style={{ transform: `rotate(${open ? 90 : -90}deg)`, transition: 'transform .2s' }}
          />
          <span>{typeof title === 'string' ? bt(title) : title}</span>
        </button>
        {help && (
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-muted hover:bg-hover hover:text-ink"
            title={helpText}
            aria-label={helpText}
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen(!helpOpen)}
          >
            <Info size={14} />
          </button>
        )}
      </div>
      {help && helpOpen && (
        <div className="mb-1 rounded-lg border border-border bg-sunken px-2.5 py-2 text-[11px] leading-relaxed text-muted">
          {help}
        </div>
      )}
      {open && <div className="wf-expand-body">{children}</div>}
    </div>
  )
}

/** Small icon button used inside forms. */
export function IconButton({
  icon: Icon,
  title,
  disabled,
  onClick,
}: {
  icon: LucideIcon
  title: string
  disabled?: boolean
  onClick?: () => void
}) {
  const { bt } = useEditorLocale()
  return (
    <button
      type="button"
      className="wf-icon-btn"
      title={bt(title)}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  )
}

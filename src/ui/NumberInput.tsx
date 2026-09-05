/**
 * Number input that never fights the user while typing.
 *
 * Plain controlled number inputs backed by "coerce on change" handlers
 * (`Number(v) || 500`, `Math.max(1, …)`) snap back to their fallback the
 * moment the field is cleared, so a value can never be fully deleted and
 * retyped. This component instead validates on blur (失焦校验):
 *
 * - while focused, the raw draft is displayed and only *valid* numbers are
 *   committed upward, so the rest of the UI stays live;
 * - clearing (or typing garbage) is allowed — nothing is committed while the
 *   draft is empty/invalid;
 * - on blur (or Enter), the draft is normalized: an empty/invalid draft is
 *   replaced by `fallback` (then `min`, then 0), a valid one is clamped to
 *   [min, max], and only a value that differs from the committed one is
 *   written back (回填默认值, no redundant patches).
 *
 * The rendered <input> is deliberately bare (no class names) so the styling
 * of the surrounding field (`.wf-field input`, `.field input`, …) applies
 * unchanged in both the workflow editor and the side panel.
 *
 * @module ui/number-input
 */

import { useState, type CSSProperties } from 'react'

export interface NumberInputProps {
  /** Committed value (block/task data). Numbers render as-is; strings parse. */
  value: number | string
  /** Called with the normalized number on live commit and on blur. */
  onChange: (v: number) => void
  /** Default backfilled on blur when the field is left empty or invalid. */
  fallback?: number
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
  /** Id of a <datalist> for suggestions. */
  list?: string
  style?: CSSProperties
  'aria-label'?: string
}

export default function NumberInput({
  value,
  onChange,
  fallback,
  min,
  max,
  placeholder,
  disabled,
  list,
  style,
  'aria-label': ariaLabel,
}: NumberInputProps) {
  // What the user is currently typing; null whenever the field is not being
  // edited so the committed `value` remains the displayed source of truth.
  const [draft, setDraft] = useState<string | null>(null)

  const clamp = (n: number): number => {
    let out = n
    if (min != null && out < min) out = min
    if (max != null && out > max) out = max
    return out
  }

  const numeric = typeof value === 'number' ? value : Number(value)
  const committed = Number.isFinite(numeric) ? numeric : Number.NaN
  const display =
    draft ?? (Number.isFinite(committed) ? String(committed) : String(value ?? ''))

  /** Write back only when the normalized value differs from the committed one. */
  const commit = (n: number) => {
    const out = clamp(n)
    if (out !== committed) onChange(out)
  }

  return (
    <input
      type="number"
      value={display}
      placeholder={placeholder}
      disabled={disabled}
      list={list}
      style={style}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        // Live-commit valid numbers so dependent UI updates while typing; an
        // empty or partial draft ("-") simply stays in the field.
        if (raw.trim() !== '') {
          const n = Number(raw)
          if (Number.isFinite(n)) commit(n)
        }
      }}
      onBlur={() => {
        if (draft === null) return
        const raw = draft.trim()
        setDraft(null)
        if (raw === '') {
          commit(fallback ?? min ?? 0)
          return
        }
        const n = Number(raw)
        commit(Number.isFinite(n) ? n : (fallback ?? min ?? 0))
      }}
      onFocus={(e) => {
        // Select the whole value on focus so a backfilled default (or the old
        // value) is replaced by the next keystroke — no caret shuffling: type
        // "50" right away instead of editing around the existing "1".
        e.currentTarget.select()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

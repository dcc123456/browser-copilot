/**
 * Shared on/off switch.
 *
 * One implementation for every surface that needs an enable/disable control:
 * the side panel, the workflow editor and the Runner web console. It is a
 * `<button role="switch">` rather than a styled checkbox so the control reads
 * as a switch to assistive tech and never inherits native checkbox rendering.
 *
 * Styling is Tailwind utility classes over the shared `--bc-*` tokens, so the
 * dark and light themes both come for free. The `!` suffixes are required:
 * the side panel stylesheet declares unlayered `button` rules that otherwise
 * beat Tailwind's layered utilities (same note as the side panel's own
 * buttons).
 *
 * The label is a `<span>`, not a `<label>`: the side panel styles bare
 * `label` elements (uppercase, 11px, muted) unlayered, which would override
 * the caller's own markup. The association is made with `aria-labelledby`
 * instead, and clicking the text still toggles the control.
 *
 * @module ui/Switch
 */
import { useId, type ReactNode } from 'react'

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  title,
  ariaLabel,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  /** Optional: omit to render the bare track (icon-only usage). */
  label?: ReactNode
  title?: string
  /** Required when there is no visible label. */
  ariaLabel?: string
}) {
  const id = useId()
  const trackClass = [
    'relative inline-flex h-5! w-9! shrink-0 items-center rounded-full! border! p-0!',
    'transition-colors duration-150',
    checked ? 'bg-accent! border-accent!' : 'bg-panel-2! border-border-strong!',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
  ].join(' ')
  const knobClass = [
    'pointer-events-none absolute top-0.5 left-0.5 h-3.5! w-3.5! rounded-full!',
    'transition-transform duration-150',
    checked ? 'translate-x-[18px]! bg-on-accent!' : 'translate-x-0! bg-ink!',
  ].join(' ')

  return (
    <span className="inline-flex items-center gap-2">
      <button
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-labelledby={label != null ? id : undefined}
        className={trackClass}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        role="switch"
        title={title}
        type="button"
      >
        <span className={knobClass} />
      </button>
      {label != null && (
        <span
          className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-muted"
          id={id}
          onClick={() => {
            if (!disabled) onChange(!checked)
          }}
        >
          {label}
        </span>
      )}
    </span>
  )
}

/**
 * Square icon-only button shared by the updater's banner and dialog.
 *
 * Every caller passes a localized label: it becomes both the tooltip and the
 * accessible name, since there is no visible text.
 *
 * @module sidepanel/update/IconButton
 */

import type { LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'

type Tone = 'primary' | 'secondary' | 'ghost'
type Size = 'sm' | 'md'

/**
 * The sidepanel's legacy unlayered `button` rule outranks Tailwind utilities, so
 * every sizing/colour class that rule also sets must be marked important.
 */
const BASE =
  'flex flex-none cursor-pointer items-center justify-center border p-0! transition-colors duration-150 disabled:cursor-default disabled:opacity-60!'

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-6! w-6! rounded-md!',
  md: 'h-8! w-8! rounded-lg!',
}

const TONE_CLASS: Record<Tone, string> = {
  primary: 'border-accent! bg-accent! text-on-accent! hover:bg-accent-strong!',
  secondary: 'border-border! bg-panel-2! text-muted! hover:bg-hover! hover:text-ink!',
  ghost: 'border-transparent! text-ink! hover:bg-hover!',
}

export default function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  size = 'md',
  tone = 'secondary',
}: {
  icon: LucideIcon
  /** Localized tooltip and accessible name. */
  label: string
  onClick: () => void
  disabled?: boolean
  size?: Size
  tone?: Tone
}): ReactElement {
  return (
    <button
      aria-label={label}
      className={[BASE, SIZE_CLASS[size], TONE_CLASS[tone]].join(' ')}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon
        aria-hidden="true"
        className="flex-none"
        size={size === 'sm' ? 14 : 16}
        strokeWidth={2}
      />
    </button>
  )
}

/**
 * Tiny local icon set.
 *
 * Renders the few icons used by the chat action bar as self-contained inline
 * SVGs. The ray paths are copied verbatim from `lucide-react` (MIT/ISC) so the
 * visuals match lucide exactly, but each icon is inlined here — no runtime
 * dependency that could fail to draw in the extension panel.
 */

import type { ReactNode, SVGProps } from 'react'

/** Shared svg element mirroring lucide's default presentational attributes. */
function Icon({
  size = 16,
  children,
  ...rest
}: {
  size?: number
  children: ReactNode
} & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
      {...rest}
    >
      {children}
    </svg>
  )
}

export function PaperclipIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
    </Icon>
  )
}

export function CheckIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

export function CopyIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect height="14" rx="2" ry="2" width="14" x="8" y="8" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  )
}

export function DownloadIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </Icon>
  )
}

export function GaugeIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </Icon>
  )
}
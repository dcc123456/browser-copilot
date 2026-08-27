/**
 * Block icon rendering.
 *
 * Automa renders block icons with v-remixicon: most are RemixIcon class names
 * (`riFlashlightLine`), a few are Material-Design icons registered as inline
 * SVG paths (the catalog generator already rewrites those to `path:<d>`), and
 * remote images use an `<img>`. This module provides the React equivalents so
 * the palette, nodes, and toolbars all render the exact same glyphs as Automa.
 *
 * The RemixIcon webfont is imported once here; Vite bundles the font files and
 * the `ri-<kebab>` classes resolve to them.
 *
 * Note: content scripts (element picker / recorder) cannot rely on this font
 * being injected into the page — they use inline SVG strings instead.
 *
 * @module lib/workflow/blocks/icons
 */

/**
 * The RemixIcon webfont stylesheet is imported once by each app entry point
 * (workflow-editor/main.tsx, sidepanel/main.tsx) — not here, so node-environment
 * unit tests can import these components without pulling in font/CSS assets.
 */

/** `riFlashlightLine` -> `ri-flashlight-line` (RemixIcon's webfont class). */
function remixClass(name: string): string {
  const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase()
  // "ri-flashlight-line" — the leading "ri-" prefix comes from `ri` + `-F...`.
  return kebab.startsWith('ri-') ? kebab : `ri-${kebab}`
}

export interface RemixIconProps {
  /** RemixIcon name in Pascal form, e.g. `riFlashlightLine`. */
  name: string
  size?: number
  className?: string
  title?: string
}

/** Renders a RemixIcon glyph via the webfont class. */
export function RemixIcon({ name, size = 20, className, title }: RemixIconProps) {
  return (
    <i
      className={`${remixClass(name)} ${className ?? ''}`}
      style={{ fontSize: size, lineHeight: 1, fontStyle: 'normal', display: 'inline-flex' }}
      title={title}
      aria-hidden={!title}
    />
  )
}

/** Inline SVG for the `path:<d>` icon spec (Material Design aliases). */
export function CustomPathIcon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  )
}

export interface BlockIconProps {
  /** Catalog icon spec: `riXxx` | `path:<d>` | `https://...`. */
  icon: string
  size?: number
  className?: string
  /** Apply the dark-mode image inversion Automa uses for remote icons. */
  invertInDark?: boolean
}

/** Renders a block icon regardless of which of the three icon forms it uses. */
export function BlockIcon({ icon, size = 20, className, invertInDark }: BlockIconProps) {
  if (icon.startsWith('http')) {
    return (
      <img
        src={icon}
        width={size}
        height={size}
        alt=""
        className={className}
        style={invertInDark ? { filter: 'var(--bc-icon-invert, none)' } : undefined}
      />
    )
  }
  if (icon.startsWith('path:')) {
    return (
      <span className={className} style={{ display: 'inline-flex' }}>
        <CustomPathIcon path={icon.slice('path:'.length)} size={size} />
      </span>
    )
  }
  return <RemixIcon name={icon} size={size} className={className} />
}

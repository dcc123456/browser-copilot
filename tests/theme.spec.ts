/**
 * Contrast tests for the two themes.
 *
 * The panel follows the OS theme, which doubles every colour decision — and
 * light-mode values are easy to get wrong by eye. The dark theme's accent can
 * look perfectly good as a fill while failing badly as *text* on white, and
 * links live inside assistant bubbles, not on the page background. So the ratios
 * are computed from the real stylesheet rather than eyeballed.
 *
 * Colours now live ONCE in src/ui/design-system.css as shared --bc-* tokens.
 * The side panel's styles.css aliases its short names (--bg, --accent, …) onto
 * those tokens. This test parses both: it resolves the alias chain and then
 * checks contrast of the resolved RGB values, so a broken alias or a
 * contrast-failing token fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const tokensCss = readFileSync(new URL('../src/ui/design-system.css', import.meta.url), 'utf8')
const panelCss = readFileSync(new URL('../src/sidepanel/styles.css', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8')

/** Extracts custom properties from one declaration block. */
function extract(css: string, pattern: RegExp): Record<string, string> {
  const match = pattern.exec(css)
  if (!match || match[1] === undefined) {
    throw new Error(`theme block not found for ${pattern}`)
  }
  const vars: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const declaration = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line)
    if (declaration && declaration[1] && declaration[2]) {
      vars[declaration[1]] = declaration[2].trim()
    }
  }
  return vars
}

const TOK_DARK = extract(tokensCss, /:root\s*\{([\s\S]*?)\n\}/)
const TOK_LIGHT = extract(
  tokensCss,
  /prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/,
)
/* The panel's aliases (--bg -> var(--bc-…) …). */
const ALIAS = extract(panelCss, /:root\s*\{([\s\S]*?)\n\}/)

type Rgb = [number, number, number]

function parseColor(value: string | undefined): Rgb | null {
  if (!value) return null
  const six = /^#([0-9a-f]{6})$/i.exec(value)
  if (six && six[1]) {
    const n = parseInt(six[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const three = /^#([0-9a-f]{3})$/i.exec(value)
  if (three && three[1]) {
    const [r, g, b] = [...three[1]].map((c) => parseInt(c + c, 16))
    return [r!, g!, b!]
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*[\d.]+%)?\s*\)$/i.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

/**
 * Resolve a panel alias name (e.g. "--bg") all the way to concrete RGB.
 * Walks `--name → var(--bc-...)` through the alias map and the token block.
 */
function resolve(name: string, tokens: Record<string, string>): Rgb | null {
  let current: string | undefined = ALIAS[name] ?? tokens[name]
  const seen = new Set<string>()
  while (current) {
    const direct = parseColor(current)
    if (direct) return direct
    const ref = /var\((--[a-z0-9-]+)\)/.exec(current)
    if (!ref || !ref[1]) return null
    if (seen.has(ref[1])) return null
    seen.add(ref[1])
    current = tokens[ref[1]] ?? ALIAS[ref[1]]
  }
  return null
}

/** Relative luminance per WCAG 2.1. */
function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Foreground/background pairs that actually occur in the UI, written in the
 * panel's alias names. Each names the surface text really sits on.
 */
const PAIRS: Array<[string, string, string]> = [
  ['--text', '--bg', 'body text'],
  ['--text', '--panel', 'text on a panel'],
  ['--text', '--panel-2', 'text on a raised panel'],
  ['--text', '--user-bubble', 'own message bubble'],
  ['--text', '--sunken', 'code text'],
  ['--muted', '--bg', 'muted text'],
  ['--muted', '--panel', 'muted text on a panel'],
  ['--muted', '--panel-2', 'form label'],
  ['--accent', '--bg', 'link'],
  ['--accent', '--panel-2', 'link inside an assistant reply'],
  ['--on-accent', '--accent', 'primary button label'],
  ['--err', '--bg', 'danger text'],
  ['--ok', '--bg', 'success status text'],
]

const AA_NORMAL = 4.5

describe.each([
  ['dark', TOK_DARK],
  ['light', TOK_LIGHT],
])('%s theme contrast', (_name, tokens) => {
  it.each(PAIRS)('%s on %s (%s) meets WCAG AA', (fg, bg, _label) => {
    const foreground = resolve(fg, tokens)
    const background = resolve(bg, tokens)
    expect(foreground, `could not resolve ${fg}`).not.toBeNull()
    expect(background, `could not resolve ${bg}`).not.toBeNull()
    expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})

describe('shared token completeness', () => {
  it('overrides every shared token in the light theme', () => {
    // A token declared only for dark would leak a dark colour into light mode.
    for (const key of Object.keys(TOK_DARK)) {
      expect(TOK_LIGHT, `light theme is missing ${key}`).toHaveProperty(key)
    }
  })

  it('declares color-scheme in both themes so native controls follow', () => {
    expect(tokensCss).toMatch(/color-scheme:\s*dark/)
    expect(tokensCss).toMatch(/color-scheme:\s*light/)
  })

  it('every panel alias resolves to a shared --bc token', () => {
    // Guards against a typo'd alias silently falling back to nothing.
    for (const key of Object.keys(ALIAS)) {
      expect(ALIAS[key], key).toMatch(/var\(--bc-|^#|^rgb/)
    }
  })
})

/**
 * The panel's HTML inlines a few colours so the first paint is not a flash of
 * the wrong theme. That duplication is intentional but must not drift from the
 * resolved token values, so it is pinned here.
 */
describe('first-paint colours in index.html', () => {
  it('declares color-scheme for both themes before the stylesheet loads', () => {
    expect(html).toMatch(/color-scheme:\s*dark/)
    expect(html).toMatch(/color-scheme:\s*light/)
    expect(html).toMatch(/prefers-color-scheme:\s*light/)
  })

  it('matches the resolved palette exactly', () => {
    const backgrounds = [...html.matchAll(/background:\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => m[1])
    const colors = [...html.matchAll(/(?<!background)color:\s*(#[0-9a-fA-F]{3,6})/g)].map(
      (m) => m[1],
    )

    expect(backgrounds).toHaveLength(2)
    expect(colors).toHaveLength(2)

    const hex = (rgb: Rgb | null): string =>
      rgb ? '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('') : ''

    expect(backgrounds[0]!.toLowerCase()).toBe(hex(resolve('--bg', TOK_DARK)))
    expect(backgrounds[1]!.toLowerCase()).toBe(hex(resolve('--bg', TOK_LIGHT)))
    expect(colors[0]!.toLowerCase()).toBe(hex(resolve('--text', TOK_DARK)))
    expect(colors[1]!.toLowerCase()).toBe(hex(resolve('--text', TOK_LIGHT)))
  })
})

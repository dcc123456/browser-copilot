/**
 * Contrast tests for the two themes.
 *
 * The panel follows the OS theme, which doubles every colour decision — and
 * light-mode values are easy to get wrong by eye. The dark theme's accent
 * (`#5b8cff`) looks perfectly good as a fill on white while failing badly as
 * *text* on white, and links live inside assistant bubbles, not on the page
 * background. So the ratios are computed from the real stylesheet rather than
 * eyeballed.
 *
 * Parsing the CSS instead of duplicating the palette here is deliberate: a copy
 * would drift, and a test that verifies a stale copy of the colours proves
 * nothing about what ships.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/*
  The fixtures are read from disk rather than imported.

  `?raw` was the obvious choice and does work for HTML, but Vite's CSS pipeline
  intercepts `styles.css?raw` and hands back an empty string — a test reading ""
  would have passed every "no hardcoded colours" assertion while checking nothing
  at all. Reading the file is immune to that.

  Node types are granted to `tests/` alone through tsconfig.tests.json, so `src/`
  still cannot import built-ins that do not exist in an extension at runtime.
*/
const css = readFileSync(new URL('../src/sidepanel/styles.css', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8')

/** Extracts custom properties from one declaration block. */
function extract(pattern: RegExp): Record<string, string> {
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

const DARK = extract(/:root\s*\{([\s\S]*?)\n\}/)
const LIGHT = extract(/prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/)

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
 * Foreground/background pairs that actually occur in the UI.
 *
 * Each entry names the surface the text really sits on — `--muted` on
 * `--panel-2` rather than on `--bg`, for instance — because a ratio against the
 * wrong background is a pass that means nothing.
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
  ['--muted', '--chip', 'tool-call chip'],
  ['--accent', '--bg', 'link'],
  ['--accent', '--panel-2', 'link inside an assistant reply'],
  ['--on-accent', '--accent', 'primary button label'],
  ['--err', '--err-surface', 'error banner'],
  ['--ok', '--ok-surface', 'success banner'],
  ['--warn', '--warn-surface', 'confirmation card'],
  ['--err', '--bg', 'danger button'],
  ['--ok', '--bg', 'success status text'],
]

/** WCAG AA for normal-size text. */
const AA_NORMAL = 4.5

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
])('%s theme contrast', (_name, vars) => {
  it.each(PAIRS)('%s on %s (%s) meets WCAG AA', (fg, bg, _label) => {
    const foreground = parseColor(vars[fg])
    const background = parseColor(vars[bg])
    // A missing or unparseable variable is a failure, not a skip: it would mean
    // the pair silently stopped being checked.
    expect(foreground, `${fg} = ${vars[fg]}`).not.toBeNull()
    expect(background, `${bg} = ${vars[bg]}`).not.toBeNull()
    expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})

describe('theme completeness', () => {
  it('overrides every colour variable in the light theme', () => {
    // A variable declared only in the dark block would leak a dark colour into
    // the light theme — the exact bug this whole structure exists to prevent.
    const skip = new Set(['color-scheme'])
    for (const key of Object.keys(DARK)) {
      if (skip.has(key)) continue
      expect(LIGHT, `light theme is missing ${key}`).toHaveProperty(key)
    }
  })

  it('declares color-scheme in both themes so native controls follow', () => {
    // Without this the browser keeps painting scrollbars, form-control internals
    // and focus rings for the wrong theme.
    expect(css).toMatch(/color-scheme:\s*dark/)
    expect(css).toMatch(/color-scheme:\s*light/)
  })

  it('keeps colours out of the rules themselves', () => {
    // Every colour must live in a theme block, or switching themes would require
    // auditing rules one by one instead of editing one palette.
    //
    // The two theme blocks are removed by locating them the same way the
    // extractors above do, rather than with a brace-counting regex that silently
    // matched too little and made this assertion pass for the wrong reason.
    let themeless = css
    for (const pattern of [
      /:root\s*\{[\s\S]*?\n\}/,
      /@media\s*\(prefers-color-scheme:\s*light\s*\)\s*\{[\s\S]*?\n\s*\}\s*\n\}/,
    ]) {
      const match = pattern.exec(themeless)
      expect(match, `could not locate theme block ${pattern}`).not.toBeNull()
      themeless = themeless.replace(pattern, '')
    }

    const literals = [
      ...themeless.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...themeless.matchAll(/\brgba?\(/g),
    ].map((match) => match[0])
    expect(literals).toEqual([])
  })
})

/**
 * The panel's HTML inlines a few colours so the first paint is not a white flash
 * in dark mode. That duplication is intentional but must not drift, so it is
 * pinned to the stylesheet here.
 */
describe('first-paint colours in index.html', () => {
  it('declares color-scheme for both themes before the stylesheet loads', () => {
    expect(html).toMatch(/color-scheme:\s*dark/)
    expect(html).toMatch(/color-scheme:\s*light/)
    expect(html).toMatch(/prefers-color-scheme:\s*light/)
  })

  it('matches the stylesheet palette exactly', () => {
    // Pull the two body backgrounds out of the inline <style>, in source order:
    // the dark default first, then the light override.
    const backgrounds = [...html.matchAll(/background:\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => m[1])
    const colors = [...html.matchAll(/(?<!background)color:\s*(#[0-9a-fA-F]{3,6})/g)].map(
      (m) => m[1],
    )

    expect(backgrounds).toHaveLength(2)
    expect(colors).toHaveLength(2)

    const norm = (value: string | undefined): string | undefined => value?.toLowerCase()
    expect(norm(backgrounds[0])).toBe(norm(DARK['--bg']))
    expect(norm(backgrounds[1])).toBe(norm(LIGHT['--bg']))
    expect(norm(colors[0])).toBe(norm(DARK['--text']))
    expect(norm(colors[1])).toBe(norm(LIGHT['--text']))
  })
})

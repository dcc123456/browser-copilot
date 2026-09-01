/**
 * Skill import / export helpers.
 *
 * Responsibilities:
 *  - Alias-based mapping from "generic skill JSON" shapes to the internal
 *    `Skill` type;
 *  - File parsing (`.json` / `.yaml` / `.yml` / `.md`) — both single-skill
 *    objects and arrays of skills; Markdown files are read as YAML frontmatter
 *    + body, where the body becomes the skill instructions if none is present;
 *  - Batch validation + report generation using the existing `validateSkill` /
 *    `normalizeSkill` primitives from `lib/skills`;
 *  - JSON round-trip export/import of the entire local skills list.
 *
 * Kept free of `chrome.*` APIs and DOM where possible so it stays testable in
 * Node. File parsing naturally requires `File` (browser), but the pure
 * preprocessing / mapping / batch-run logic is exposed separately.
 *
 * ## YAML parsing strategy
 *
 * We avoid introducing a dependency by accepting only JSON plus a very small
 * YAML subset that covers the common exported-skill layouts:
 *   - Flat `key: value` lines, indented 0–2 spaces
 *   - `instructions: |` / `instructions: >` block scalars (indented following
 *     lines)
 *   - Document separator `---` for multiple skills
 *   - Array shorthand `- key: value` only for top-level list items
 * Anything outside this subset rejects with "parseFailed" via `null` and the
 * caller can surface it; this gives us JSON round-trip parity without a dep.
 *
 * @module lib/skills-import
 */
import {
  MAX_INSTRUCTIONS_LENGTH,
  MAX_NAME_LENGTH,
  normalizeSkill,
  validateSkill,
  type SkillProblem,
} from './skills'
import type { Skill } from './types'

// --- Alias table -----------------------------------------------------------

const NAME_ALIASES = ['name', 'title', 'skillName', 'skill_name'] as const
const DESC_ALIASES = [
  'description',
  'desc',
  'summary',
  'about',
  'subtitle',
  'tagline',
] as const
const INSTR_ALIASES = [
  'instructions',
  'instruction',
  'prompt',
  'content',
  'body',
  'text',
  'system_prompt',
  'systemPrompt',
  'system',
] as const
const AUTOMATCH_ALIASES = [
  'autoMatch',
  'auto_match',
  'autoSelect',
  'auto_select',
  'automatch',
] as const

function pickString(raw: Record<string, unknown>, aliases: readonly string[]): string {
  for (const key of aliases) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v === 'string') return v
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    }
  }
  return ''
}

function pickBoolean(raw: Record<string, unknown>, aliases: readonly string[]): boolean {
  for (const key of aliases) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
        if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
      }
    }
  }
  // Default true — aligns with SkillsTab.emptyDraft() so imported skills are
  // discoverable by the auto-matcher unless the user opted out.
  return true
}

function newSkillId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `imp-${ts}-${rand}`
}

/**
 * Parses a number that may arrive as a string (the YAML frontmatter subset
 * stores every scalar as a string, so `createdAt: 1720000000000` reaches us
 * as `"1720000000000"`).
 */
function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Filesystem-safe slug for a skill name — the folder name used on disk and the
 * basis for a derived id when a file omits one. Keeps ASCII letters/digits and
 * `._-`, replacing everything else with `_` so names like "Web Scraper" map to
 * a stable folder without colliding with the data JSON files. Mirrors the
 * storage layer's file-segment sanitization.
 */
export function skillSlug(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'skill'
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_') || 'skill'
}

/** A stable id for a skill that does not carry its own (e.g. hand-authored). */
function derivedSkillId(name: string): string {
  return `skill-${skillSlug(name)}`
}

/**
 * Maps a loosely-shaped incoming object (single skill) to a Skill, or returns
 * `null` if the input is clearly not a skill object (e.g. not an object, or
 * none of the required aliases produce even an empty name).
 */
export function mapAliasedToSkill(raw: unknown): Skill | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const name = pickString(obj, NAME_ALIASES)
  const description = pickString(obj, DESC_ALIASES)
  const instructions = pickString(obj, INSTR_ALIASES)
  // At minimum one of the three semantic fields needs to actually be present;
  // otherwise we can't tell this apart from an arbitrary object.
  if (
    name.length === 0 &&
    description.length === 0 &&
    instructions.length === 0
  ) {
    return null
  }
  const createdAt = coerceNumber((obj as { createdAt?: unknown }).createdAt) ?? Date.now()
  const updatedAt = coerceNumber((obj as { updatedAt?: unknown }).updatedAt) ?? createdAt
  const base: Skill = {
    id:
      typeof (obj as { id?: unknown }).id === 'string' && (obj as { id: string }).id.length > 0
        ? (obj as { id: string }).id
        : newSkillId(),
    name,
    description,
    instructions,
    autoMatch: pickBoolean(obj, AUTOMATCH_ALIASES),
    createdAt,
    updatedAt,
  }
  return base
}

// --- JSON parsing ---------------------------------------------------------

/**
 * Parses a raw text file body into a flat list of "unknown" entries, each of
 * which will later go through `mapAliasedToSkill`. Handles both a single
 * object and an array. Rejects JSON parse errors silently: callers receive an
 * empty list plus an `ok=false` flag so they can render a banner.
 */
export function parseJsonSkillsText(text: string): { ok: boolean; raws: unknown[] } {
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return { ok: true, raws: parsed }
    return { ok: true, raws: [parsed] }
  } catch {
    return { ok: false, raws: [] }
  }
}

// --- Minimal YAML subset --------------------------------------------------

type YamlScalarBlock = { chomp: 'literal' | 'folded'; body: string }
type YamlValue = string | YamlScalarBlock
type YamlObject = Record<string, YamlValue>
type YamlDoc = YamlObject | YamlObject[]

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = v.slice(1, -1)
      return first === '"'
        ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : inner
    }
  }
  return v
}

/**
 * Parses one YAML document (string -> raw objects). Supports our tiny subset.
 * Returns null if the document doesn't parse cleanly.
 */
function parseYamlDoc(doc: string): YamlDoc | null {
  const rawLines = doc.split(/\r?\n/)
  // Remove trailing whitespace lines + initial comment/empty lines.
  const lines: string[] = []
  for (const ln of rawLines) {
    const line = ln.replace(/[ \t]+$/, '')
    if (lines.length === 0 && line.length === 0) continue
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop()
  if (lines.length === 0) return null

  // Detect top-level list: first non-empty non-comment line starts with "- ".
  const firstContent = lines.find((l) => l.length > 0 && !l.trimStart().startsWith('#'))
  const isList = !!firstContent && firstContent.trimStart().startsWith('- ')

  const readBlockBody = (startIndex: number, indent: number): { body: string; next: number } => {
    const needIndent = indent + 2
    const linesBody: string[] = []
    let i = startIndex
    while (i < lines.length) {
      const line = lines[i]!
      if (line.length === 0) {
        linesBody.push('')
        i += 1
        continue
      }
      // Compute leading spaces count (exact — tabs are treated as non-space so
      // we reject mixed indent rather than mis-parsing).
      let leading = 0
      while (leading < line.length && line[leading] === ' ') leading += 1
      if (leading < needIndent) break
      linesBody.push(line.slice(needIndent))
      i += 1
    }
    // Trim trailing blank lines; collapse nothing.
    while (linesBody.length > 0 && linesBody[linesBody.length - 1] === '') linesBody.pop()
    return { body: linesBody.join('\n'), next: i }
  }

  const readKeyValue = (
    startIndex: number,
    indent: number,
  ): { key: string; value: YamlValue; next: number } | null => {
    const line = lines[startIndex]!
    const prefix = ' '.repeat(indent)
    if (!line.startsWith(prefix)) return null
    const rest = line.slice(indent)
    // "- key: value" is handled by the caller as a list item.
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) return null
    const key = rest.slice(0, colonIdx).trim()
    if (!key) return null
    const after = rest.slice(colonIdx + 1)
    // Block scalar
    const m = after.match(/^\s*([|>])\s*$/)
    if (m) {
      const chomp: 'literal' | 'folded' = m[1] === '|' ? 'literal' : 'folded'
      const { body, next } = readBlockBody(startIndex + 1, indent)
      return { key, value: { chomp, body }, next }
    }
    const value = unquote(after.replace(/^\s+/, ''))
    return { key, value, next: startIndex + 1 }
  }

  const readObject = (startIndex: number, indent: number): { obj: YamlObject; next: number } => {
    const obj: YamlObject = {}
    let i = startIndex
    while (i < lines.length) {
      const line = lines[i]!
      if (line.length === 0) { i += 1; continue }
      if (!line.startsWith(' '.repeat(indent))) break
      const item = readKeyValue(i, indent)
      if (!item) break
      const { key, value, next } = item
      obj[key] = typeof value === 'string'
        ? value
        : value.chomp === 'literal'
          ? value.body
          : value.body.split(/\n{2,}/).map((p) => p.split('\n').join(' ')).join('\n\n')
      i = next
    }
    return { obj, next: i }
  }

  if (isList) {
    const items: YamlObject[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (line.length === 0) { i += 1; continue }
      if (!line.startsWith('- ') && !line.startsWith('-\t')) {
        // A line that isn't a list item but might be a continuation key:
        // treat next object attributes as appended to previous item if the
        // previous item exists and this line is indented 2+ spaces under "- ".
        if (items.length > 0 && line.startsWith('  ') && !line.trimStart().startsWith('#')) {
          const { obj, next } = readObject(i, 2)
          items[items.length - 1] = { ...items[items.length - 1]!, ...obj }
          i = next
          continue
        }
        break
      }
      const firstPart = line.slice(2)
      // "- " alone (next lines are indented key:value pairs).
      if (firstPart.trim().length === 0) {
        const { obj, next } = readObject(i + 1, 2)
        items.push(obj)
        i = next
        continue
      }
      // "- key: value" possibly followed by continuation lines at indent 2+.
      // Write the first line as an object line with indent 2 prefix (fake).
      const tmpLine = `  ${firstPart}`
      lines[i] = tmpLine
      const { obj, next } = readObject(i, 2)
      // Restore line for safety; the parse has already consumed it.
      lines[i] = line
      items.push(obj)
      i = next
    }
    return items.length > 0 ? items : null
  }

  const { obj } = readObject(0, 0)
  return Object.keys(obj).length > 0 ? obj : null
}

export function parseYamlSkillsText(text: string): { ok: boolean; raws: unknown[] } {
  // Split on `---` document separators (line-only).
  const docs = text
    .split(/^\s*---\s*$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
  if (docs.length === 0) return { ok: false, raws: [] }
  const raws: unknown[] = []
  let anyOk = false
  for (const doc of docs) {
    const parsed = parseYamlDoc(doc)
    if (!parsed) continue
    anyOk = true
    if (Array.isArray(parsed)) raws.push(...(parsed as unknown[]))
    else raws.push(parsed)
  }
  return { ok: anyOk, raws }
}

/**
 * Parses a Markdown skill file built around YAML frontmatter (the common
 * SKILL.md layout). The frontmatter block is parsed with the same YAML subset
 * used elsewhere, and leftover aliases (name/description) map onto the Skill
 * via `mapAliasedToSkill`. If the frontmatter carries no explicit instruction
 * field, the Markdown body below the delimiter is used as the instructions.
 */
export function parseMarkdownSkillsFileText(
  text: string,
): { ok: boolean; raws: unknown[]; from: 'md' } {
  const cleaned = text.replace(/^\uFEFF?/, '')
  const m = /^(?:---|\.\.\.)\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(cleaned)
  if (!m) {
    return { ok: false, raws: [], from: 'md' }
  }
  const frontmatter = m[1]!
  const body = cleaned.slice(m[0].length).trim()
  const parsed = parseYamlDoc(frontmatter)
  if (!parsed || Array.isArray(parsed)) {
    return { ok: false, raws: [], from: 'md' }
  }
  const obj = { ...(parsed as unknown as Record<string, unknown>) }
  const hasInstructions = INSTR_ALIASES.some(
    (key) => key in obj && String(obj[key]).trim().length > 0,
  )
  if (!hasInstructions && body.length > 0) {
    obj.instructions = body
  }
  return { ok: true, raws: [obj], from: 'md' }
}

/**
 * Dispatches a File to JSON, YAML or Markdown parsing based on extension or
 * (fallback) content sniffing. Returns empty + ok=false when the file cannot
 * be read.
 */
export function parseSkillsFileText(filename: string, text: string): { ok: boolean; raws: unknown[]; from: 'json' | 'yaml' | 'md' | 'unknown' } {
  const lower = filename.toLowerCase()
  const sniffFirst = (text: string): 'json' | 'yaml' | 'unknown' => {
    const trimmed = text.replace(/^\s*/, '')
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
    if (/^---\s*$|^\s*\w[\w-]*\s*:/m.test(trimmed)) return 'yaml'
    return 'unknown'
  }
  if (lower.endsWith('.json')) {
    const r = parseJsonSkillsText(text)
    return { ok: r.ok, raws: r.raws, from: 'json' }
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    const r = parseYamlSkillsText(text)
    return { ok: r.ok, raws: r.raws, from: 'yaml' }
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    const r = parseMarkdownSkillsFileText(text)
    return { ok: r.ok, raws: r.raws, from: 'md' }
  }
  const kind = sniffFirst(text)
  if (kind === 'json') {
    const r = parseJsonSkillsText(text)
    return { ok: r.ok, raws: r.raws, from: 'json' }
  }
  if (kind === 'yaml') {
    const r = parseYamlSkillsText(text)
    return { ok: r.ok, raws: r.raws, from: 'yaml' }
  }
  // A `---`-preamble unknown file is most likely a Markdown skill with
  // frontmatter; give it the same treatment rather than dropping it.
  const md = parseMarkdownSkillsFileText(text)
  if (md.ok) return md
  return { ok: false, raws: [], from: 'unknown' }
}

/**
 * Reads files using `FileReader` and dispatches to the text parser.
 *
 * Returns a merged list of parse results keyed per input file so callers can
 * produce per-file banners when importing several files at once.
 */
export async function parseSkillsFiles(
  files: File | File[] | FileList | null,
): Promise<{ file: File; ok: boolean; raws: unknown[]; from: 'json' | 'yaml' | 'md' | 'unknown' }[]> {
  if (!files) return []
  const list = 'length' in (files as FileList | File[]) ? Array.from(files as FileList | File[]) : [files as File]
  if (list.length === 0) return []
  return Promise.all(
    list.map(
      (file) =>
        new Promise<{ file: File; ok: boolean; raws: unknown[]; from: 'json' | 'yaml' | 'md' | 'unknown' }>((resolve) => {
          const reader = new FileReader()
          reader.onerror = () => resolve({ file, ok: false, raws: [], from: 'unknown' })
          reader.onload = () => {
            const text = typeof reader.result === 'string' ? reader.result : ''
            const r = parseSkillsFileText(file.name, text)
            resolve({ file, ok: r.ok, raws: r.raws, from: r.from })
          }
          try {
            reader.readAsText(file, 'utf-8')
          } catch {
            resolve({ file, ok: false, raws: [], from: 'unknown' })
          }
        }),
    ),
  )
}

// --- Batch validation -----------------------------------------------------

/** A per-item import result. */
export interface ImportBatchProblem {
  /** 0-based index within the `raws` array passed to `importSkillsBatch`. */
  index: number
  /** The original raw entry, kept for UI banners that show "skipped X". */
  raw: unknown
  /** Non-empty list of validation problems OR `parseFailed` when mapping itself failed. */
  problems: Array<SkillProblem | { field: 'parse'; code: 'parseFailed' }>
}

export interface ImportBatchResult {
  /** Entries that passed mapping + validation; callers can now save them. */
  saved: Skill[]
  /** Entries that failed mapping or validation. */
  problems: ImportBatchProblem[]
}

/**
 * Maps raw entries (as produced by the parser), normalises each, and runs
 * `validateSkill` with an *accumulating* existing list so that a single
 * import cannot produce duplicate names against itself.
 */
export function importSkillsBatch(raws: unknown[], existing: readonly Skill[]): ImportBatchResult {
  const saved: Skill[] = []
  const problems: ImportBatchProblem[] = []
  // Build a scratch list that grows as we accept entries, so name uniqueness
  // covers both the storage state and the batch being imported.
  const accumulated: Skill[] = existing.slice()

  raws.forEach((raw, index) => {
    const mapped = mapAliasedToSkill(raw)
    if (!mapped) {
      problems.push({
        index,
        raw,
        problems: [{ field: 'parse', code: 'parseFailed' }],
      })
      return
    }
    const normalized = normalizeSkill(mapped)
    // Cap lengths explicitly: `normalizeSkill` trims, but if the user had a
    // 2-char name after trim we still want to show "nameRequired" rather than
    // save an unusable short one.
    if (normalized.name.length === 0) {
      problems.push({
        index,
        raw,
        problems: [{ field: 'name', code: 'nameRequired' }],
      })
      return
    }
    if (normalized.instructions.length === 0) {
      problems.push({
        index,
        raw,
        problems: [{ field: 'instructions', code: 'instructionsRequired' }],
      })
      return
    }
    const issues = validateSkill(normalized, accumulated)
    if (issues.length > 0) {
      problems.push({ index, raw, problems: issues })
      return
    }
    saved.push(normalized)
    accumulated.push(normalized)
  })

  return { saved, problems }
}

// --- Export ---------------------------------------------------------------

/**
 * Serialises all skills as an indented JSON array. Round-trip companion to
 * the JSON parser: `JSON.parse(exportSkillsJson(skills))` should yield an
 * array that `importSkillsBatch` can re-normalise back into equivalent skills.
 */
export function exportSkillsJson(skills: readonly Skill[]): string {
  const stripped = skills.map((skill) => ({
    // Don't emit internal ids or timestamps on export. Import regenerates
    // them, which keeps round-trip behaviour stable (no "same id" collisions).
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    autoMatch: skill.autoMatch,
  }))
  return JSON.stringify(stripped, null, 2)
}

// --- SKILL.md (folder-per-skill) serialization -------------------------------

/**
 * Escapes a value for use as a YAML scalar in the frontmatter.
 *
 * Values that are safe plain scalars are emitted verbatim; anything that could
 * confuse the parser (or a general skill reader) is double-quoted with the
 * escapes our own subset understands (`\n`, `\"`, `\\`).
 */
function yamlScalar(value: string): string {
  const text = String(value)
  const safePlain =
    text !== '' &&
    !/[\r\n]/.test(text) &&
    !/^[\s"'#?\-,[\]{}&*!|>%@`]/.test(text) &&
    !/:\s/.test(text) &&
    !/[ \t#-]$/.test(text)
  if (safePlain) return text
  return `"${text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')}"`
}

/**
 * Serialises a skill to the general-skill `SKILL.md` layout: YAML frontmatter
 * (name/description/autoMatch plus the identity fields needed to round-trip the
 * internal `Skill`) followed by the instruction text as the Markdown body. The
 * frontmatter stays compatible with a generic skill loader, which reads
 * name/description and ignores the extra keys.
 */
export function skillToMarkdown(skill: Skill): string {
  const header = [
    '---',
    `name: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
    `autoMatch: ${skill.autoMatch}`,
    `id: ${yamlScalar(skill.id)}`,
    `createdAt: ${skill.createdAt}`,
    `updatedAt: ${skill.updatedAt}`,
    '---',
  ].join('\n')
  const body = skill.instructions.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return `${header}\n\n${body}\n`
}

/**
 * Parses a `SKILL.md` back into a `Skill`. Identity/timestamps are read from
 * the frontmatter when present (so a file written by us round-trips exactly);
 * a hand-authored file without them gets a stable slug-derived id and its
 * creation time. Returns `null` when the text is not a valid skill file.
 */
export function skillFromMarkdown(text: string): Skill | null {
  const parsed = parseMarkdownSkillsFileText(text)
  if (!parsed.ok || parsed.raws.length === 0) return null
  const raw = parsed.raws[0]
  const mapped = mapAliasedToSkill(raw)
  if (!mapped) return null
  const obj = raw as Record<string, unknown>
  const id =
    typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : derivedSkillId(mapped.name)
  const createdAt = coerceNumber(obj.createdAt) ?? mapped.createdAt
  const updatedAt = coerceNumber(obj.updatedAt) ?? createdAt
  return { ...mapped, id, createdAt, updatedAt }
}

// Silenced unused reference guards so TypeScript doesn't complain about the
// deliberately exported constants in tree-shaken builds.
void MAX_NAME_LENGTH
void MAX_INSTRUCTIONS_LENGTH

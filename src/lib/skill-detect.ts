/**
 * Detects structured skill blocks inside assistant Markdown replies.
 *
 * Three forms are recognised, all within fenced code blocks (``` … ```):
 *   1. A JSON object (or JSON array of objects) with name / description /
 *      instructions aliases — parsed and delegated to `mapAliasedToSkill`.
 *   2. A YAML block using the same aliases — parsed by our minimal YAML
 *      parser in `skills-import`.
 *   3. An explicit `<skill name="…" description="…">instructions</skill>`
 *      block anywhere in the reply (also works outside a code fence, so the
 *      assistant can output it without remembering a code-fence language).
 *
 * The returned candidates are `Skill`-shaped drafts; callers still run them
 * through `validateSkill` before saving. The original source string is kept
 * so the UI can show exactly what the assistant produced.
 *
 * @module lib/skill-detect
 */
import { mapAliasedToSkill, parseJsonSkillsText, parseYamlSkillsText } from './skills-import'
import type { Skill } from './types'

export interface DetectedSkill {
  /** The substring of `assistantText` this candidate was extracted from. */
  source: string
  /** A draft Skill — NOT yet normalised/validated. */
  draft: Skill
}

const CODE_FENCE_RE = /```([\w+-]*)\n([\s\S]*?)```/g

/**
 * Pulls all fenced-code-block bodies out of a Markdown string and returns
 * `{ lang, body }` pairs. Empty or whitespace-only bodies are skipped.
 */
function extractFencedBlocks(mdText: string): Array<{ lang: string; body: string }> {
  const out: Array<{ lang: string; body: string }> = []
  const re = new RegExp(CODE_FENCE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(mdText)) !== null) {
    const lang = (m[1] || '').toLowerCase().trim()
    const body = (m[2] || '').replace(/\n$/, '')
    if (body.trim().length === 0) continue
    out.push({ lang, body })
  }
  return out
}

/** Parses `<skill …>…</skill>` blocks with HTML-escaped inner bodies. */
function extractCustomSkillBlocks(text: string): DetectedSkill[] {
  const out: DetectedSkill[] = []
  const tagRe = /<skill\b([^>]*)>([\s\S]*?)<\/skill>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(text)) !== null) {
    const source = m[0]
    const attrsRaw = m[1] ?? ''
    const body = m[2] ?? ''
    const attrs: Record<string, string> = {}
    const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(attrsRaw)) !== null) {
      const key = (a[1] ?? '').toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      attrs[key] = decodeAttr(value)
    }
    const instructions = decodeHtmlEntities(body.replace(/^\n/, '').replace(/\n$/, ''))
    const raw = {
      name: attrs.name ?? attrs.title ?? '',
      description: attrs.description ?? attrs.desc ?? attrs.summary ?? '',
      instructions,
      autoMatch: (attrs.automatch ?? attrs['auto-match'] ?? 'true').toString() !== 'false',
    }
    const draft = mapAliasedToSkill(raw)
    if (draft) out.push({ source, draft })
  }
  return out
}

function decodeAttr(raw: string): string {
  return decodeHtmlEntities(raw)
}

function decodeHtmlEntities(input: string): string {
  // Small allowlist — mirrors only the entities an LLM is likely to emit when
  // wrapping text in XML-style tags. Anything else stays literal.
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#xa;/gi, '\n')
    .replace(/&#10;/gi, '\n')
    .replace(/&amp;/g, '&')
}

function skillFromParsedRaws(raws: unknown[], source: string): DetectedSkill[] {
  const out: DetectedSkill[] = []
  for (const raw of raws) {
    const mapped = mapAliasedToSkill(raw)
    if (mapped) out.push({ source, draft: mapped })
  }
  return out
}

export function detectSkillCandidatesFromMarkdown(assistantText: string): DetectedSkill[] {
  if (!assistantText) return []
  const results: DetectedSkill[] = []
  const seenSources = new Set<string>()

  const pushUnique = (items: DetectedSkill[]): void => {
    for (const it of items) {
      const key = `${it.source}::${it.draft.name}::${it.draft.instructions.slice(0, 40)}`
      if (seenSources.has(key)) continue
      seenSources.add(key)
      results.push(it)
    }
  }

  // Fenced code blocks: try language-aware parser first, then fall back to
  // both JSON and YAML parses for language-less fences (triple-backtick with
  // no label), which LLMs emit routinely.
  for (const { lang, body } of extractFencedBlocks(assistantText)) {
    const source = body
    if (lang === 'json' || lang === 'json5' || lang === 'jsonc') {
      const { ok, raws } = parseJsonSkillsText(body)
      if (ok) pushUnique(skillFromParsedRaws(raws, source))
      continue
    }
    if (lang === 'yaml' || lang === 'yml') {
      const { ok, raws } = parseYamlSkillsText(body)
      if (ok) pushUnique(skillFromParsedRaws(raws, source))
      continue
    }
    if (lang === 'skill') {
      // Custom language; treat body as the `<skill>`-free payload. First try
      // JSON, then YAML.
      const j = parseJsonSkillsText(body)
      if (j.ok && j.raws.length > 0) {
        pushUnique(skillFromParsedRaws(j.raws, source))
        continue
      }
      const y = parseYamlSkillsText(body)
      if (y.ok && y.raws.length > 0) {
        pushUnique(skillFromParsedRaws(y.raws, source))
      }
      continue
    }
    // Unknown / no language: try JSON, then YAML; skip if both fail.
    const j = parseJsonSkillsText(body)
    if (j.ok && j.raws.length > 0) {
      pushUnique(skillFromParsedRaws(j.raws, source))
      continue
    }
    const y = parseYamlSkillsText(body)
    if (y.ok && y.raws.length > 0) {
      pushUnique(skillFromParsedRaws(y.raws, source))
    }
  }

  // Custom `<skill>` blocks anywhere in the reply (not only in code fences).
  pushUnique(extractCustomSkillBlocks(assistantText))

  return results
}

/**
 * Job-post blacklists stored once in Settings and injected into every workflow
 * run as the `jobBlacklist` variable.
 *
 * The extension cannot know which DOM card on an arbitrary job site is a
 * posting, where its company name lives, or whether the recruiter is a
 * headhunter — that part stays in the user's workflow (typically a JavaScript
 * block that already parses the listing API). These lists only supply the
 * CURRENT exclusion rules, so a saved job-search workflow does not freeze the
 * names it was recorded against.
 *
 * Matching convention (what the UI tells workflow authors): entries are
 * compared case-insensitively as substrings against the company name, the job
 * title, or the headhunter name; `excludeHeadhunters` drops every posting the
 * site itself flags as posted by a headhunter.
 *
 * @module lib/job-blacklist
 */

export interface JobBlacklist {
  /** Company names or keywords. */
  companies: string[]
  /** Job-title or headhunter-firm keywords for headhunter postings. */
  headhunterPositions: string[]
  /** Drop every posting the site flags as posted by a headhunter. */
  excludeHeadhunters: boolean
}

export const EMPTY_JOB_BLACKLIST: JobBlacklist = {
  companies: [],
  headhunterPositions: [],
  excludeHeadhunters: false,
}

/**
 * Canonical form of a blacklist: trimmed, blanks dropped, and case-insensitive
 * duplicates removed (the first spelling wins). Deduped case-insensitively
 * because matching is case-insensitive, so "Acme" and "acme" are one entry.
 */
export function normalizeBlacklistEntries(entries: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of entries) {
    if (typeof raw !== 'string') continue
    const entry = raw.trim()
    if (!entry) continue
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/** One entry per line, as typed into the Settings textareas. */
export function parseJobBlacklistLines(text: string): string[] {
  return normalizeBlacklistEntries(text.split(/\r?\n/))
}

/** Validates a stored value: hand-edited JSON must not reach the UI or a run. */
export function normalizeJobBlacklist(raw: unknown): JobBlacklist {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_JOB_BLACKLIST, companies: [], headhunterPositions: [] }
  }
  const value = raw as Partial<JobBlacklist>
  return {
    companies: Array.isArray(value.companies) ? normalizeBlacklistEntries(value.companies) : [],
    headhunterPositions: Array.isArray(value.headhunterPositions)
      ? normalizeBlacklistEntries(value.headhunterPositions)
      : [],
    excludeHeadhunters: value.excludeHeadhunters === true,
  }
}

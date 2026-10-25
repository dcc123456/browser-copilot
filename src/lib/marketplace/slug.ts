/**
 * Repository slug rules.
 *
 * A slug is both the directory name (`workflows/<slug>/`) and the identity a
 * local workflow stores to detect "already added". Names are user text, often
 * Chinese, so the slug carries an ASCII stem when one exists and ALWAYS a
 * short content hash — two workflows named "发布笔记" must not collide.
 *
 * @module lib/marketplace/slug
 */

const MAX_STEM_CHARS = 40
const MAX_SLUG_CHARS = 64
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Lowercase ASCII stem of a display name; empty when the name has none. */
export function slugify(name: string): string {
  const stem = name
    .normalize('NFKD')
    // Strip combining marks so "Café" and "Cafe" share a slug stem.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_STEM_CHARS)
    .replace(/-+$/g, '')
  return stem
}

/**
 * Builds the permanent slug for a publish. The hash suffix is mandatory: it is
 * what keeps two same-named workflows from fighting over one directory.
 */
export function buildSlug(name: string, hash: string): string {
  const stem = slugify(name) || 'wf'
  const suffix = hash.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || '000000'
  return `${stem}-${suffix}`
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_CHARS && SLUG_RE.test(slug)
}

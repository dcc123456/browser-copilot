/**
 * Size bounds for values mirrored into the browser storage fallback.
 *
 * Every collection here lives under ONE key and is rewritten whole on each
 * write, and a write that cannot reach the data directory is parked as a single
 * value in the outbox fallback — which itself refuses a value over its entry
 * budget. So one megabyte payload (a screenshot's data URL in a run's debug
 * snapshot) does not cost the reader that payload, it costs the whole key its
 * durability. Trimming at the persist boundary keeps every value a reader can
 * use and drops the bulk the producing step regenerates on the next run.
 *
 * @module lib/persist-budget
 */

/** Longest string kept verbatim; longer values keep a prefix and a marker. */
export const MAX_PERSISTED_STRING = 8 * 1024

/** Characters of an oversize value retained so the reader can identify it. */
const PREFIX_CHARS = 512

/**
 * Smallest data URL treated as bulk. Below this it is a real icon or a small
 * inline asset — part of the content — and a persisted value has to keep it.
 */
const MIN_BULK_DATA_URL_CHARS = 8 * 1024

/**
 * `data:<anything>` up to a delimiter (whitespace, a quote, a closing paren or
 * a backslash — the characters that end a literal in JSON and in JS source),
 * at least {@link MIN_BULK_DATA_URL_CHARS} long.
 */
const BULK_DATA_URL = /data:[^\s"'`\\]{8192,}/g

/** Deepest object level traversed; the stored shapes are shallower than this. */
const MAX_DEPTH = 6

/** Walks the stored shapes, rewriting every string through `onString`. */
function mapPersistedStrings(
  value: unknown,
  onString: (text: string) => string,
  depth = 0,
): unknown {
  if (typeof value === 'string') return onString(value)
  if (Array.isArray(value)) return value.map((item) => mapPersistedStrings(item, onString, depth + 1))
  if (depth < MAX_DEPTH && value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      out[key] = mapPersistedStrings(item, onString, depth + 1)
    return out
  }
  return value
}

/**
 * Replace oversize strings with a short, self-describing marker, recursively.
 *
 * The truncation is deliberate rather than a drop: a variable NAME is what the
 * draft timeline and the debug inspector show, and an honest
 * "(N chars, not persisted)" beats a value that silently vanished.
 */
export function capPersistedStrings(value: unknown): unknown {
  return mapPersistedStrings(value, (text) =>
    text.length <= MAX_PERSISTED_STRING
      ? text
      : `${text.slice(0, PREFIX_CHARS)}… (${text.length} chars, not persisted)`,
  )
}

/**
 * A data URL is the one payload class that must never reach a persisted key,
 * anywhere — including inlined inside a longer string (a code node whose script
 * literal carries the PNG it just drew). A bare data URL is easy to spot; the
 * inlined case is why this matches a token rather than a whole value.
 *
 * The class is deliberately narrow: an ordinary 20 KB script, prompt or JSON
 * param is kept VERBATIM, because truncating real graph content would corrupt
 * the workflow the user is saving. Only the bulk payload a step regenerates on
 * replay goes.
 */
export function shedBulkDataUrls(value: unknown): unknown {
  return mapPersistedStrings(value, (text) =>
    text.length < MIN_BULK_DATA_URL_CHARS
      ? text
      : text.replace(BULK_DATA_URL, (match) => `[data URL dropped: ${match.length} chars]`),
  )
}

/** JSON size of a value; unmeasurable (a value JSON cannot hold) counts as 0. */
export function jsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

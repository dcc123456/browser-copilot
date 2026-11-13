/**
 * The elements the user confirmed with the on-page picker, per tab.
 *
 * `read_selected_element` reads these back; the picker itself cannot be asked
 * afterwards because its UI and its listeners are gone once the pick ends.
 * Session storage (not local): a pick describes THIS browsing session's page,
 * and the records must survive a service-worker eviction between the pick and
 * the agent's read — module memory would not.
 *
 * @module background/element-selection-store
 */

import type { PickedElement } from '../lib/messages'

const SESSION_KEY = 'pickedElements'
/** Distinct tabs kept; each record is capped separately. */
const MAX_TABS = 20
const MAX_ELEMENTS_PER_TAB = 10
const MAX_SELECTOR_CHARS = 500
const MAX_TAG_CHARS = 60
const MAX_ID_CHARS = 200
const MAX_CLASSES = 12
const MAX_CLASS_CHARS = 80
const MAX_TEXT_CHARS = 2000
const MAX_HTML_CHARS = 20_000
const MAX_URL_CHARS = 2000
const MAX_TITLE_CHARS = 300

type StoredSelection = PickedElement | PickedElement[]
type StoredSelections = Record<string, StoredSelection>

function storageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.session
}

async function readAll(): Promise<StoredSelections> {
  if (!storageAvailable()) return {}
  const stored = await chrome.storage.session.get(SESSION_KEY).catch(() => undefined)
  const value = stored?.[SESSION_KEY]
  return value && typeof value === 'object' ? (value as StoredSelections) : {}
}

function asElements(record: StoredSelection | undefined): PickedElement[] {
  return Array.isArray(record) ? record : record ? [record] : []
}

/**
 * Coerces a content-script payload into a bounded record; `undefined` when the
 * fields a selector needs are missing. The picker already truncates, but the
 * worker is the trust boundary for message shape and size.
 */
export function sanitizePickedElement(raw: unknown, now = Date.now()): PickedElement | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const selector = typeof value.selector === 'string' ? value.selector.trim() : ''
  const tag = typeof value.tag === 'string' ? value.tag.trim().toLowerCase() : ''
  const url = typeof value.url === 'string' ? value.url : ''
  if (!selector || !tag || !url) return undefined

  const classes = Array.isArray(value.classes)
    ? value.classes
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .slice(0, MAX_CLASSES)
        .map((name) => name.slice(0, MAX_CLASS_CHARS))
    : []
  const text = typeof value.text === 'string' ? value.text : ''
  const html = typeof value.html === 'string' ? value.html : ''
  const pickedAt =
    typeof value.pickedAt === 'number' && Number.isFinite(value.pickedAt) ? value.pickedAt : now

  return {
    selector: selector.slice(0, MAX_SELECTOR_CHARS),
    tag: tag.slice(0, MAX_TAG_CHARS),
    ...(typeof value.id === 'string' && value.id ? { id: value.id.slice(0, MAX_ID_CHARS) } : {}),
    ...(classes.length > 0 ? { classes } : {}),
    text: text.slice(0, MAX_TEXT_CHARS),
    html: html.slice(0, MAX_HTML_CHARS),
    ...(html.length > MAX_HTML_CHARS || value.htmlTruncated === true
      ? { htmlTruncated: true }
      : {}),
    url: url.slice(0, MAX_URL_CHARS),
    title: typeof value.title === 'string' ? value.title.slice(0, MAX_TITLE_CHARS) : '',
    pickedAt,
  }
}

// Picks on two tabs can land together; a read-modify-write on the shared map
// would otherwise lose one of them.
let writeQueue: Promise<void> = Promise.resolve()

/** Replaces the whole ordered selection for this tab; an empty batch clears it. */
export function rememberPickedElements(tabId: number, raws: unknown): Promise<void> {
  if (!Number.isInteger(tabId) || !storageAvailable() || !Array.isArray(raws)) {
    return Promise.resolve()
  }
  const picked = raws
    .slice(0, MAX_ELEMENTS_PER_TAB)
    .map((raw) => sanitizePickedElement(raw))
    .filter((element): element is PickedElement => element !== undefined)
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      const all = await readAll()
      if (picked.length > 0) all[String(tabId)] = picked
      else delete all[String(tabId)]
      const keys = Object.keys(all)
      if (keys.length > MAX_TABS) {
        keys
          .sort((a, b) => {
            const aElements = asElements(all[a])
            const bElements = asElements(all[b])
            const aPickedAt = aElements[aElements.length - 1]?.pickedAt ?? 0
            const bPickedAt = bElements[bElements.length - 1]?.pickedAt ?? 0
            return aPickedAt - bPickedAt
          })
          .slice(0, keys.length - MAX_TABS)
          .forEach((key) => delete all[key])
      }
      await chrome.storage.session.set({ [SESSION_KEY]: all }).catch(() => {})
    })
  return writeQueue
}

/** Compatibility entry for copy mode, which still reports exactly one element. */
export function rememberPickedElement(tabId: number, raw: unknown): Promise<void> {
  if (!sanitizePickedElement(raw)) return Promise.resolve()
  return rememberPickedElements(tabId, [raw])
}

/** The ordered elements picked on this tab, if any. */
export async function getPickedElements(tabId: number): Promise<PickedElement[]> {
  if (!Number.isInteger(tabId)) return []
  const all = await readAll()
  return asElements(all[String(tabId)])
}

/** Test helper: drops the pending write chain. */
export function _resetPickedElementWritesForTests(): void {
  writeQueue = Promise.resolve()
}

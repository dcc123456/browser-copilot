/**
 * The one round trip to the page element picker.
 *
 * A node's selector field and the AI operator chat dock both need it, so
 * claiming a private `pickerId`, the safety timeout, the result listening and
 * the focus handback live here instead of a second copy in each (AGENTS.md
 * §5.2). The picker broadcasts `picker:result` / `picker:cancel` to every
 * extension page (see `background/picker-bridge`), which is why the id has to
 * be ours alone: another editor window may be picking at the same time.
 *
 * Nothing throws — a pick that did not produce an element is a value, because
 * the caller has to distinguish the user pressing Escape from a page the picker
 * could not start on.
 *
 * @module workflow-editor/blocks/shared/element-pick
 */

import { hostWindowId } from '../../host-window'
import type { PickedElement } from '../../../lib/workflow/operator-advise'

/** Picking takes as long as the user needs; the timer only catches a lost reply. */
const PICK_TIMEOUT_MS = 120_000
/** A verify answers from one injected count, so it must not hang for minutes. */
const VERIFY_TIMEOUT_MS = 15_000

export type { PickedElement }

/** Why no element came back. `cancelled` is the user's own choice, not a fault. */
export type ElementPickFailure = 'cancelled' | 'timeout' | 'start-failed'

export type ElementPickResult =
  ({ ok: true } & PickedElement) | { ok: false; failure: ElementPickFailure; error?: string }

export type SelectorVerifyResult =
  { ok: true; count: number } | { ok: false; failure: ElementPickFailure; error?: string }

interface PickerReply {
  type: 'picker:result' | 'picker:cancel'
  pickerId: string
  selector?: string
  findBy?: string
  count?: number
  verified?: boolean
}

type PickerOutcome =
  { ok: true; reply: PickerReply } | { ok: false; failure: ElementPickFailure; error?: string }

let counter = 0
function newPickerId(): string {
  counter += 1
  return `picker-${Date.now()}-${counter}`
}

/**
 * Bring the standalone editor window back to the foreground. Picking switches
 * focus to the tab being automated; once the user finishes (or cancels) we
 * return them to the editor, mirroring Automa's makeDashboardFocus().
 */
function focusEditorWindow(): void {
  try {
    void chrome.windows
      .getCurrent()
      .then((win) => {
        if (win?.id !== undefined) return chrome.windows.update(win.id, { focused: true })
      })
      .catch(() => {})
  } catch {
    /* older Chrome without windows.getCurrent in this context; best-effort */
  }
}

/** Inject the picker, wait for OUR `pickerId`, hand focus back either way. */
async function runPicker(
  buildRequest: (pickerId: string) => Record<string, unknown>,
  timeoutMs: number,
): Promise<PickerOutcome> {
  const pickerId = newPickerId()
  return new Promise<PickerOutcome>((resolve) => {
    // Settled once by whichever comes first: a reply, the safety timeout, or a
    // rejected start.
    let settled = false
    const finish = (outcome: PickerOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      focusEditorWindow()
      resolve(outcome)
    }
    const listener = (message: unknown) => {
      const reply = message as PickerReply | undefined
      if (!reply || reply.pickerId !== pickerId) return
      finish({ ok: true, reply })
    }
    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' as const }), timeoutMs)
    chrome.runtime.onMessage.addListener(listener)
    const windowId = hostWindowId()
    void chrome.runtime
      .sendMessage({
        ...(buildRequest(pickerId) as object),
        ...(windowId !== undefined ? { windowId } : {}),
      })
      .then((response) => {
        const resp = response as { ok?: boolean; error?: string } | undefined
        // No response (the worker restarted) or an explicit failure: stop spinning.
        if (!resp || resp.ok === false)
          finish({ ok: false, failure: 'start-failed', error: resp?.error })
      })
      .catch((error: unknown) =>
        finish({
          ok: false,
          failure: 'start-failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
  })
}

/** The dialect the picker reported, defaulting the way its card does. */
const findByOf = (reply: PickerReply): PickedElement['findBy'] =>
  reply.findBy === 'xpath' ? 'xpath' : reply.findBy === 'text' ? 'text' : 'cssSelector'

/**
 * The line to show for a pick that produced nothing, or `null` when the user
 * simply pressed Escape — both callers report failures the same way, so the
 * branching lives once. English source: the caller translates it.
 */
export function describePickFailure(failure: ElementPickFailure, error?: string): string | null {
  if (failure === 'cancelled') return null
  if (failure === 'timeout') return 'The element picker did not respond.'
  return error ?? 'Could not start the element picker.'
}

/**
 * Pick an element on the page and get back the locator the picker built for it.
 * `locale` is what the picker's own card copy is rendered in.
 */
export async function requestElementPick(
  opts: {
    findBy?: 'cssSelector' | 'xpath' | 'text'
    multiple?: boolean
    locale?: 'en' | 'zh'
  } = {},
): Promise<ElementPickResult> {
  const outcome = await runPicker(
    (pickerId) => ({
      type: 'picker:start',
      pickerId,
      findBy: opts.findBy ?? 'cssSelector',
      multiple: opts.multiple ?? false,
      locale: opts.locale,
    }),
    PICK_TIMEOUT_MS,
  )
  if (!outcome.ok) return outcome
  const { reply } = outcome
  if (reply.type === 'picker:cancel') return { ok: false, failure: 'cancelled' }
  // A result without a selector is the same as no pick; reporting it as
  // `cancelled` keeps the caller's silence-on-Escape rule intact.
  if (!reply.selector) return { ok: false, failure: 'cancelled' }
  return { ok: true, selector: reply.selector, findBy: findByOf(reply) }
}

/** Count how many elements a selector matches on the page right now. */
export async function verifyElementSelector(opts: {
  selector: string
  findBy?: 'cssSelector' | 'xpath' | 'text'
  locale?: 'en' | 'zh'
}): Promise<SelectorVerifyResult> {
  const outcome = await runPicker(
    (pickerId) => ({
      type: 'picker:verify',
      pickerId,
      selector: opts.selector,
      findBy: opts.findBy ?? 'cssSelector',
      locale: opts.locale,
    }),
    VERIFY_TIMEOUT_MS,
  )
  if (!outcome.ok) return outcome
  const { reply } = outcome
  if (reply.type === 'picker:cancel') return { ok: false, failure: 'cancelled' }
  return { ok: true, count: reply.count ?? 0 }
}

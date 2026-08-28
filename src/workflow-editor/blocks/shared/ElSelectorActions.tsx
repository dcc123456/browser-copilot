/**
 * Element selector actions — React port of Automa's SharedElSelectorActions.
 *
 * The pick button injects the element picker into the user's active browser
 * tab; when the user picks an element, the resulting selector is broadcast by
 * the background and returned here via a `picker:result` message. The verify
 * button injects the picker in verify mode and reports how many elements the
 * current selector matches.
 *
 * @module workflow-editor/blocks/shared/ElSelectorActions
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../../ui/toast'
import { useEditorLocale } from '../../locale-context'

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

interface PickerResult {
  type: 'picker:result'
  pickerId: string
  selector?: string
  count?: number
  verified?: boolean
  findBy?: string
}
interface PickerCancel {
  type: 'picker:cancel'
  pickerId: string
}

export default function ElSelectorActions({
  selector,
  findBy = 'cssSelector',
  multiple = false,
  onSelector,
  onMessage,
}: {
  selector: string
  findBy?: 'cssSelector' | 'xpath'
  multiple?: boolean
  onSelector: (selector: string) => void
  /** Optional toast-style callback for verify results. */
  onMessage?: (text: string, kind: 'ok' | 'error') => void
}) {
  const [busy, setBusy] = useState<null | 'pick' | 'verify'>(null)
  const pendingPicker = useRef<{ id: string; mode: 'select' | 'verify' } | null>(null)
  // Safety timeout: if the picker never reports back (page closed, SW restarted,
  // response lost), release the spinner instead of spinning forever.
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { bt } = useEditorLocale()

  const clearBusy = useCallback(() => {
    if (safetyTimer.current) {
      clearTimeout(safetyTimer.current)
      safetyTimer.current = null
    }
    pendingPicker.current = null
    setBusy(null)
  }, [])

  const listen = useCallback(
    (message: unknown) => {
      const msg = message as PickerResult | PickerCancel
      const pending = pendingPicker.current
      if (!pending) return
      if (msg.type === 'picker:cancel' && msg.pickerId === pending.id) {
        clearBusy()
        focusEditorWindow()
        return
      }
      if (msg.type !== 'picker:result' || msg.pickerId !== pending.id) return
      clearBusy()
      // Return focus to the editor popup now that picking is done.
      focusEditorWindow()
      if (pending.mode === 'select' && msg.selector) {
        onSelector(msg.selector)
      } else if (pending.mode === 'verify') {
        const n = msg.count ?? 0
        if (n > 0) onMessage?.(`Verified: ${n} element(s) match`, 'ok')
        else {
          onMessage?.('Element not found', 'error')
          toast('Element not found', 'error')
        }
      }
    },
    [clearBusy, onMessage, onSelector],
  )

  useEffect(() => {
    chrome.runtime.onMessage.addListener(listen)
    return () => {
      chrome.runtime.onMessage.removeListener(listen)
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
    }
  }, [listen])

  const start = useCallback(
    async (mode: 'select' | 'verify') => {
      const pickerId = newPickerId()
      pendingPicker.current = { id: pickerId, mode }
      setBusy(mode === 'select' ? 'pick' : 'verify')
      // Picking usually takes as long as the user needs; keep a long safety net
      // for select, but verify should answer quickly.
      const safetyMs = mode === 'verify' ? 15000 : 120000
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
      safetyTimer.current = setTimeout(() => {
        if (pendingPicker.current?.id === pickerId) {
          clearBusy()
          toast('The element picker did not respond.', 'error')
        }
      }, safetyMs)
      try {
        const resp = (await chrome.runtime.sendMessage({
          type: mode === 'select' ? 'picker:start' : 'picker:verify',
          pickerId,
          findBy,
          multiple,
          ...(mode === 'verify' ? { selector } : {}),
        })) as { ok?: boolean; error?: string } | undefined
        // No response (SW restarted) or an explicit failure: stop spinning.
        if (!resp || resp.ok === false) {
          clearBusy()
          toast(resp?.error ?? 'Could not start the element picker.', 'error')
        }
      } catch (error) {
        clearBusy()
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    },
    [findBy, multiple, selector, clearBusy],
  )

  return (
    <span className="wf-el-actions">
      <button
        type="button"
        className="wf-icon-btn"
        title={bt('Pick element on page')}
        disabled={busy !== null}
        onClick={() => void start('select')}
      >
        <i className={busy === 'pick' ? 'ri-loader-4-line wf-spin' : 'ri-focus-3-line'} />
      </button>
      <button
        type="button"
        className="wf-icon-btn"
        title={bt('Verify selector')}
        disabled={busy !== null || !selector}
        onClick={() => void start('verify')}
      >
        <i className={busy === 'verify' ? 'ri-loader-4-line wf-spin' : 'ri-check-double-line'} />
      </button>
    </span>
  )
}

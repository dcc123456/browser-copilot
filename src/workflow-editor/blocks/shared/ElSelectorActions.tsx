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

let counter = 0
function newPickerId(): string {
  counter += 1
  return `picker-${Date.now()}-${counter}`
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

  const listen = useCallback(
    (message: unknown) => {
      const msg = message as PickerResult | PickerCancel
      const pending = pendingPicker.current
      if (!pending) return
      if (msg.type === 'picker:cancel' && msg.pickerId === pending.id) {
        pendingPicker.current = null
        setBusy(null)
        return
      }
      if (msg.type !== 'picker:result' || msg.pickerId !== pending.id) return
      pendingPicker.current = null
      setBusy(null)
      if (pending.mode === 'select' && msg.selector) {
        onSelector(msg.selector)
      } else if (pending.mode === 'verify') {
        const n = msg.count ?? 0
        if (n > 0) onMessage?.(`Verified: ${n} element(s) match`, 'ok')
        else {
          onMessage?.('Element not found', 'error')
          window.alert('Element not found')
        }
      }
    },
    [onMessage, onSelector],
  )

  useEffect(() => {
    chrome.runtime.onMessage.addListener(listen)
    return () => chrome.runtime.onMessage.removeListener(listen)
  }, [listen])

  const start = useCallback(
    async (mode: 'select' | 'verify') => {
      const pickerId = newPickerId()
      pendingPicker.current = { id: pickerId, mode }
      setBusy(mode === 'select' ? 'pick' : 'verify')
      try {
        const resp = (await chrome.runtime.sendMessage({
          type: mode === 'select' ? 'picker:start' : 'picker:verify',
          pickerId,
          findBy,
          multiple,
          ...(mode === 'verify' ? { selector } : {}),
        })) as { ok?: boolean; error?: string } | undefined
        if (resp && resp.ok === false) {
          pendingPicker.current = null
          setBusy(null)
          window.alert(resp.error ?? 'Could not start the element picker.')
        }
      } catch (error) {
        pendingPicker.current = null
        setBusy(null)
        window.alert(error instanceof Error ? error.message : String(error))
      }
    },
    [findBy, multiple, selector],
  )

  return (
    <span className="wf-el-actions">
      <button
        type="button"
        className="wf-icon-btn"
        title="Pick element on page"
        disabled={busy !== null}
        onClick={() => void start('select')}
      >
        <i className={busy === 'pick' ? 'ri-loader-4-line wf-spin' : 'ri-focus-3-line'} />
      </button>
      <button
        type="button"
        className="wf-icon-btn"
        title="Verify selector"
        disabled={busy !== null || !selector}
        onClick={() => void start('verify')}
      >
        <i className={busy === 'verify' ? 'ri-loader-4-line wf-spin' : 'ri-check-double-line'} />
      </button>
    </span>
  )
}

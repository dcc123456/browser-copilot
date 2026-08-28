/**
 * Imperative toast notifications with a module-level host.
 *
 * Mount `<ToastHost />` once at the app root, then call `toast()` from any
 * component without prop drilling:
 *
 *   // in App:  <ToastHost />
 *   // anywhere: toast('Element not found', 'error')
 *
 * Toasts stack bottom-center, auto-dismiss, and follow the panel theme.
 * Used to replace blocking `window.alert()` feedback in the editor.
 *
 * @module ui/toast
 */

import { useEffect, useState } from 'react'

export type ToastKind = 'info' | 'ok' | 'error'

interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

type PushFn = (text: string, kind: ToastKind) => void

let pushToast: PushFn | null = null
let nextId = 0

/** Show a transient toast from anywhere in the tree. */
export function toast(text: string, kind: ToastKind = 'info'): void {
  pushToast?.(text, kind)
}

/** Render once at the app root. */
export function ToastHost(): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    const push: PushFn = (text, kind) => {
      const id = ++nextId
      setItems((list) => [...list.slice(-3), { id, text, kind }])
      window.setTimeout(() => {
        setItems((list) => list.filter((x) => x.id !== id))
      }, 3400)
    }
    pushToast = push
    return () => {
      pushToast = null
    }
  }, [])

  return (
    <div className="ui-toast-stack">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={[
            'ui-toast',
            item.kind === 'error'
              ? 'ui-toast-error'
              : item.kind === 'ok'
                ? 'ui-toast-ok'
                : 'ui-toast-info',
          ].join(' ')}
        >
          <span className="ui-toast-icon" aria-hidden>
            {item.kind === 'error' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : item.kind === 'ok' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
          </span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  )
}

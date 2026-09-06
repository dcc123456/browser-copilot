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
import { CircleAlert, CircleCheck, Info } from 'lucide-react'

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
              <CircleAlert size={16} />
            ) : item.kind === 'ok' ? (
              <CircleCheck size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  )
}

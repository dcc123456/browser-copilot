/**
 * Minimal toast notifications for the editor popup (save/run/record feedback).
 *
 * `useToast` returns the toast element to render plus a `show(text, kind)`
 * callback. Toasts auto-dismiss and are positioned at the bottom-center, away
 * from the toolbars.
 *
 * @module workflow-editor/toast
 */

import { useCallback, useRef, useState, type ReactElement } from 'react'



interface ToastItem {
  id: number
  text: string
  kind: 'info' | 'ok' | 'error'
}

export function useToast(): { toasts: ToastItem[]; show: (text: string, kind?: ToastItem['kind']) => void; node: ReactElement } {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const show = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    idRef.current += 1
    const id = idRef.current
    setToasts((list) => [...list, { id, text, kind }])
    setTimeout(() => {
      setToasts((list) => list.filter((x) => x.id !== id))
    }, 3200)
  }, [])

  const node = (
    <div className="wf-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`wf-toast wf-toast-${toast.kind}`}>
          <i
            className={
              toast.kind === 'error'
                ? 'ri-error-warning-line'
                : toast.kind === 'ok'
                  ? 'ri-checkbox-circle-line'
                  : 'ri-information-line'
            }
          />
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  )

  return { toasts, show, node }
}

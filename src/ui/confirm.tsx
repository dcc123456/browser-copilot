/**
 * Imperative confirm/alert dialog with a module-level host.
 *
 * Mount `<ConfirmHost />` ONCE near the app root, then call `confirmDialog` /
 * `alertDialog` from any component without prop drilling or context:
 *
 *   // in App:  <ConfirmHost />
 *   // anywhere: const ok = await confirmDialog({ title, message, danger: true })
 *
 * @module ui/confirm
 */

import { useEffect, useState } from 'react'
import { useConfirm, type ConfirmOptions } from './ConfirmDialog'

type Pending = (ConfirmOptions & { resolve: (v: boolean) => void }) | null

let pushDialog: ((d: NonNullable<Pending>) => void) | null = null

/** Show a confirm dialog; resolves `true` when confirmed, `false` otherwise. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!pushDialog) {
      resolve(typeof window !== 'undefined' ? window.confirm(opts.message ?? opts.title) : false)
      return
    }
    pushDialog({ ...opts, resolve })
  })
}

/** Show an alert dialog; resolves once acknowledged. */
export function alertDialog(opts: ConfirmOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!pushDialog) {
      if (typeof window !== 'undefined') window.alert(opts.message ?? opts.title)
      resolve()
      return
    }
    pushDialog({ ...opts, alert: true, danger: opts.danger ?? true, resolve: () => resolve() })
  })
}

/** Render once at the app root. */
export function ConfirmHost(): React.ReactElement | null {
  const api = useConfirm()
  const [pending, setPending] = useState<Pending>(null)

  useEffect(() => {
    pushDialog = (d) => setPending(d)
    return () => {
      pushDialog = null
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    api
      .confirm(pending)
      .then((result) => {
        pending.resolve(result)
        setPending(null)
      })
      .catch(() => setPending(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  return api.node
}

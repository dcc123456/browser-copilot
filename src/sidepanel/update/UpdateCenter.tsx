/**
 * The panel-wide update banner.
 *
 * Two states, one bar: a release is available (offer the update, allow
 * dismissal of that version), or files are already written (offer the reload).
 * Nothing blocks the rest of the panel; the dialog is opened on demand.
 *
 * @module sidepanel/update/UpdateCenter
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Download, RotateCw, X } from 'lucide-react'
import { useT } from '../i18n'
import IconButton from './IconButton'
import UpdateDialog from './UpdateDialog'
import { cleanUpUpdateBackups } from './cleanup'
import { useUpdateSnapshot } from './use-update-snapshot'

const BAR =
  'flex flex-none items-center gap-2 border-b border-accent-border bg-accent-soft px-3 py-1.5'

export default function UpdateCenter(): ReactElement {
  const t = useT()
  const snapshot = useUpdateSnapshot({ autoCheck: true })
  const [dialogOpen, setDialogOpen] = useState(false)

  // The panel opening on the new version is the proof the reload worked, so
  // its backups can go. Before that the panel still runs the old build and the
  // cleanup keeps them.
  useEffect(() => {
    void cleanUpUpdateBackups(chrome.runtime.getManifest().version)
  }, [])

  const pending = snapshot.pendingVersion
  const available = snapshot.availableVersion

  return (
    <>
      {pending ? (
        <div className={BAR}>
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink">
            {t.updateBannerPending({ version: pending })}
          </span>
          <IconButton
            icon={RotateCw}
            label={t.updateBannerReload}
            onClick={snapshot.reloadNow}
            size="sm"
            tone="primary"
          />
        </div>
      ) : available ? (
        <div className={BAR}>
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink">
            {t.updateBannerAvailable({ version: available })}
          </span>
          <IconButton
            icon={Download}
            label={t.updateBannerOpen}
            onClick={() => setDialogOpen(true)}
            size="sm"
            tone="primary"
          />
          <IconButton
            icon={X}
            label={t.updateBannerDismiss}
            onClick={() => void snapshot.dismiss(available)}
            size="sm"
            tone="ghost"
          />
        </div>
      ) : null}
      {dialogOpen && <UpdateDialog snapshot={snapshot} onClose={() => setDialogOpen(false)} />}
    </>
  )
}

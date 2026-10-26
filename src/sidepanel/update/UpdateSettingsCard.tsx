/**
 * Settings card: the durable status surface for the self-updater.
 *
 * The banner is transient (one open panel); this card always shows the running
 * version, the last check result, and the manual re-check / apply entry points.
 *
 * @module sidepanel/update/UpdateSettingsCard
 */

import { useState, type ReactElement } from 'react'
import { useI18n, useT } from '../i18n'
import { describeCheckError } from './error-text'
import { openReleasePage } from './open-release'
import UpdateDialog from './UpdateDialog'
import { useUpdateSnapshot } from './use-update-snapshot'

const PRIMARY_BUTTON =
  'h-8 cursor-pointer rounded-lg border border-accent bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-strong disabled:cursor-default disabled:opacity-60'
const SECONDARY_BUTTON =
  'h-8 cursor-pointer rounded-lg border border-border bg-panel-2 px-3 text-[12.5px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-60'

export default function UpdateSettingsCard(): ReactElement {
  const t = useT()
  const { locale } = useI18n()
  const snapshot = useUpdateSnapshot({ autoCheck: true })
  const [dialogOpen, setDialogOpen] = useState(false)

  const state = snapshot.state
  const latest = state?.available ? state.latest : null
  const errorText = state?.error ? describeCheckError(t, state.error) : null
  const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  const checkedAt = state?.checkedAt ? new Date(state.checkedAt).toLocaleString(dateLocale) : null
  const retryAt = state?.retryAt ? new Date(state.retryAt).toLocaleString(dateLocale) : null

  let status: string
  let statusClass: string
  if (snapshot.pendingVersion) {
    status = t.updateSettingsPending({ version: snapshot.pendingVersion })
    statusClass = 'text-warn'
  } else if (latest) {
    status = t.updateSettingsAvailable({ version: latest.version })
    statusClass = 'text-accent'
  } else if (errorText) {
    status = t.updateCheckFailed({ detail: errorText })
    statusClass = 'text-err'
  } else if (checkedAt) {
    status = t.updateUpToDate
    statusClass = 'text-muted'
  } else {
    status = t.updateNeverChecked
    statusClass = 'text-muted'
  }

  return (
    <div className="mb-2.5 rounded-[10px] border border-border bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="font-semibold">{t.updateSettingsTitle}</span>
        <span className="text-[11px] text-faint">
          {t.updateCurrentVersion({ version: snapshot.currentVersion })}
        </span>
      </div>
      <p className="mt-1.5 mb-2.5 text-[11px] leading-relaxed text-muted">{t.updateSettingsHint}</p>
      <p className={`m-0 text-[12px] leading-relaxed ${statusClass}`}>{status}</p>
      {latest && errorText && (
        <p className="mt-1 mb-0 text-[11px] leading-relaxed text-warn">
          {t.updateCheckFailed({ detail: errorText })}
        </p>
      )}
      {state?.error && retryAt && (
        <p className="mt-1 mb-0 text-[11px] leading-relaxed text-warn">
          {t.updateRetryScheduled({ time: retryAt })}
        </p>
      )}
      {latest && !snapshot.canApply && (
        <p className="mt-1 mb-0 text-[11px] leading-relaxed text-muted">{t.updateManualHint}</p>
      )}
      {checkedAt && (
        <p className="mt-1 mb-0 text-[11px] text-faint">
          {t.updateLastChecked({ time: checkedAt })}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <button
          className={SECONDARY_BUTTON}
          disabled={snapshot.checking}
          onClick={() => void snapshot.checkNow(true)}
          type="button"
        >
          {snapshot.checking ? t.updateChecking : t.updateCheckNow}
        </button>
        {snapshot.pendingVersion ? (
          <button className={PRIMARY_BUTTON} onClick={snapshot.reloadNow} type="button">
            {t.updateSettingsReload}
          </button>
        ) : latest ? (
          snapshot.canApply ? (
            <button className={PRIMARY_BUTTON} onClick={() => setDialogOpen(true)} type="button">
              {t.updateSettingsApply}
            </button>
          ) : (
            <button
              className={PRIMARY_BUTTON}
              onClick={() => openReleasePage(latest.htmlUrl)}
              type="button"
            >
              {t.updateOpenRelease}
            </button>
          )
        ) : null}
      </div>
      {dialogOpen && <UpdateDialog snapshot={snapshot} onClose={() => setDialogOpen(false)} />}
    </div>
  )
}

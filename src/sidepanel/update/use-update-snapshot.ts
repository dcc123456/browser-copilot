/**
 * The panel's live view of the updater.
 *
 * The background checker owns the network call and persists the result to
 * `chrome.storage.local`; this hook only reads that state, triggers an explicit
 * re-check, and forwards dismiss/reload actions. Storage events keep every
 * mounted copy (banner and settings card) in sync without either polling.
 *
 * @module sidepanel/update/use-update-snapshot
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sendCommand } from '../../lib/messages'
import {
  canApplyInPlace,
  dismissUpdateVersion,
  getInstallType,
  readDismissedVersion,
  readPendingReloadVersion,
  readStoredUpdateState,
  type InstallType,
} from '../../lib/update/state'
import {
  UPDATE_CHECK_INTERVAL_MINUTES,
  UPDATE_DISMISSED_KEY,
  UPDATE_PENDING_KEY,
  UPDATE_STATE_KEY,
  type UpdateState,
  type UpdateVariant,
} from '../../lib/update/types'
import { variantFromManifest } from '../../lib/update/variant'
import { isNewerVersion } from '../../lib/update/version'

export interface UpdateSnapshot {
  currentVersion: string
  /** `manifest.name`; the install-folder identity check compares against it. */
  manifestName: string
  variant: UpdateVariant
  state: UpdateState | null
  checking: boolean
  /** Files are on disk; waiting for the user to reload the extension. */
  pendingVersion: string | null
  /** Newest undismissed version, already known to be newer than the running one. */
  availableVersion: string | null
  /** `null` while undetermined (no management API, e.g. a plain page). */
  installType: InstallType | null
  canApply: boolean
  checkNow: (force?: boolean) => Promise<void>
  dismiss: (version: string) => Promise<void>
  reloadNow: () => void
}

function readManifest(): chrome.runtime.Manifest | null {
  try {
    return chrome.runtime.getManifest()
  } catch {
    return null
  }
}

export function useUpdateSnapshot(options: { autoCheck?: boolean } = {}): UpdateSnapshot {
  const manifest = useMemo(readManifest, [])
  const currentVersion = manifest?.version ?? '0.0.0'
  const manifestName = manifest?.name ?? ''
  const variant: UpdateVariant = manifest ? variantFromManifest(manifest) : 'ocr'

  const [state, setState] = useState<UpdateState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [checking, setChecking] = useState(false)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [pendingVersion, setPendingVersion] = useState<string | null>(null)
  const [installType, setInstallType] = useState<InstallType | null>(null)

  const refresh = useCallback(async () => {
    const [nextState, dismissed, pending] = await Promise.all([
      readStoredUpdateState(),
      readDismissedVersion(),
      readPendingReloadVersion(currentVersion),
    ])
    setState(nextState)
    setDismissedVersion(dismissed)
    setPendingVersion(pending)
    setLoaded(true)
  }, [currentVersion])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let alive = true
    void getInstallType().then((next) => {
      if (alive) setInstallType(next)
    })
    return () => {
      alive = false
    }
  }, [])

  // `onChanged` is the only live channel: the worker writes these three keys
  // directly, so no store-event notification fires for them.
  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') return
      if (
        UPDATE_STATE_KEY in changes ||
        UPDATE_DISMISSED_KEY in changes ||
        UPDATE_PENDING_KEY in changes
      ) {
        void refresh()
      }
    }
    try {
      chrome.storage.onChanged.addListener(onChanged)
    } catch {
      return
    }
    return () => {
      try {
        chrome.storage.onChanged.removeListener(onChanged)
      } catch {
        // Already torn down.
      }
    }
  }, [refresh])

  const checkNow = useCallback(async (force = true) => {
    setChecking(true)
    try {
      const result = await sendCommand({ type: 'update.check', force })
      if (result.type === 'update.state') setState(result.state)
    } catch {
      // A transport failure is not an update-check result. Keep the previous
      // snapshot (its `checkedAt` still tells the truth) and let the next
      // alarm publish a state.
    } finally {
      setChecking(false)
    }
  }, [])

  const didAutoCheck = useRef(false)
  useEffect(() => {
    if (!options.autoCheck || !loaded || didAutoCheck.current) return
    didAutoCheck.current = true
    const retryAt = state?.error ? state.retryAt : null
    const retryPending = typeof retryAt === 'number' && retryAt > Date.now()
    const retryDue = typeof retryAt === 'number' && retryAt <= Date.now()
    // A failed state keeps the last successful `checkedAt`, so an old timestamp
    // must not override a promised retry. Without one, a stale state is how a
    // missed alarm heals the next time the user opens the panel.
    const stale =
      state !== null && Date.now() - state.checkedAt >= UPDATE_CHECK_INTERVAL_MINUTES * 60_000
    if (!state || retryDue || (stale && !retryPending)) void checkNow(false)
  }, [options.autoCheck, loaded, state, checkNow])

  const dismiss = useCallback(async (version: string) => {
    setDismissedVersion(version)
    await dismissUpdateVersion(version).catch(() => undefined)
  }, [])

  const reloadNow = useCallback(() => {
    try {
      chrome.runtime.reload()
    } catch {
      // Nothing else can load the new files; the settings card stays visible.
    }
  }, [])

  const latest = state?.latest ?? null
  const availableVersion =
    state?.available &&
    latest &&
    latest.version !== dismissedVersion &&
    latest.version !== currentVersion &&
    isNewerVersion(latest.version, currentVersion)
      ? latest.version
      : null

  return {
    currentVersion,
    manifestName,
    variant,
    state,
    checking,
    pendingVersion,
    availableVersion,
    installType,
    canApply: installType !== null && variant !== 'firefox' && canApplyInPlace(installType),
    checkNow,
    dismiss,
    reloadNow,
  }
}

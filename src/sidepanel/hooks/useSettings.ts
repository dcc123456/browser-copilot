/**
 * Shared read/write cycle for the settings object.
 *
 * Two surfaces edit settings — the Settings tab and the Model settings tab —
 * and both stay mounted. Keeping two copies would let a write made in one
 * leave the other showing stale values, so both use this hook: one
 * `settings.get` on mount, a reload on storage-change notifications, and a
 * mutate that stores whatever settings the worker returns.
 *
 * @module sidepanel/hooks/useSettings
 */
import { useCallback, useEffect, useState } from 'react'
import { sendCommand, type Command } from '../../lib/messages'
import { normalizeSettingsPayload } from '../../lib/providers'
import { onStoreChanged } from '../../lib/store-events'
import type { Settings } from '../../lib/types'

export interface SettingsStore {
  /** Normalized settings, or null until the first read lands. */
  settings: Settings | null
  /** Last load/mutate failure, rendered by the calling tab. */
  error: string | null
  clearError: () => void
  applySettings: (next: Settings) => void
  /**
   * Sends one command and stores the settings it returns. Resolves to those
   * settings, or null when the command failed (the failure lands in `error`).
   */
  mutate: (command: Command) => Promise<Settings | null>
}

export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applySettings = useCallback((next: Settings): void => {
    // The panel and worker are separate bundles Chrome may load at different
    // versions, so a field can legitimately be missing; see
    // `normalizeSettingsPayload`.
    setSettings(normalizeSettingsPayload(next))
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'settings.get' })
      if (result.type === 'settings') applySettings(result.settings)
    } catch (loadError) {
      setError((loadError as Error).message)
    }
  }, [applySettings])

  useEffect(() => {
    void load()
  }, [load])

  // Another surface (this panel's other tab, another window's panel, or the
  // worker) wrote settings behind our back; re-read rather than trusting a
  // stale copy.
  useEffect(() => onStoreChanged('settings', () => void load()), [load])

  const mutate = useCallback(
    async (command: Command): Promise<Settings | null> => {
      try {
        const result = await sendCommand(command)
        if (result.type !== 'settings') return null
        applySettings(result.settings)
        setError(null)
        return result.settings
      } catch (mutateError) {
        setError((mutateError as Error).message)
        return null
      }
    },
    [applySettings],
  )

  const clearError = useCallback(() => setError(null), [])

  return { settings, error, clearError, applySettings, mutate }
}

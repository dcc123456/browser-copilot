/**
 * Reads the environment facts attached to a feedback issue.
 *
 * Called at submit time, never at render time, so the report matches the build
 * the user was running when they wrote it.
 *
 * @module lib/feedback/diagnostics
 */

import type { Locale } from '../i18n'
import type { FeedbackDiagnostics } from './issue'

export function collectFeedbackDiagnostics(locale: Locale): FeedbackDiagnostics {
  return {
    version: chrome.runtime.getManifest().version,
    // Vite always stamps a real build; empty only in bare test runners.
    build: __BUILD_STAMP__ || 'unknown',
    userAgent: navigator.userAgent,
    locale,
  }
}

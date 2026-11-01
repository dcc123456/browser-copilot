/**
 * The worker's own localized strings.
 *
 * The worker has no UI, but it owns the messages it hands to the panel — and
 * some of them have to be in the panel's language, not the vendor's English.
 *
 * @module background/worker-messages
 */
import { effectiveLocale, messagesFor, type Messages } from '../lib/i18n'
import { getSettings } from '../lib/storage'

export async function workerMessages(): Promise<Messages> {
  const settings = await getSettings()
  return messagesFor(effectiveLocale(settings.locale, navigator.language))
}

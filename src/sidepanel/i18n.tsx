/**
 * Locale plumbing for the panel.
 *
 * The dictionary is loaded once at the root and shared through context, so a
 * language change re-renders every tab at once. Components receive the resolved
 * `Messages` object rather than a lookup function: that way a missing key is a
 * compile error instead of a blank label at runtime.
 *
 * @module sidepanel/i18n
 */
import { createContext, useContext } from 'react'
import { effectiveLocale, messagesFor, type Locale, type Messages } from '../lib/i18n'

/**
 * Falls back to the browser's language rather than English.
 *
 * The context default only applies before settings load; using the browser hint
 * avoids a visible flash of English for a Chinese user on every panel open.
 */
const FALLBACK_LOCALE: Locale = effectiveLocale('auto', navigator.language)

export interface I18nValue {
  locale: Locale
  t: Messages
}

const I18nContext = createContext<I18nValue>({
  locale: FALLBACK_LOCALE,
  t: messagesFor(FALLBACK_LOCALE),
})

export const I18nProvider = I18nContext.Provider

/** Returns the active dictionary. */
export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

/** Shorthand for the common case of only needing the messages. */
export function useT(): Messages {
  return useContext(I18nContext).t
}

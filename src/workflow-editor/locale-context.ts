/**
 * React context carrying the editor UI locale and a block-name localizer, so
 * deeply-nested node and palette components can render translated block names
 * without prop drilling.
 *
 * @module workflow-editor/locale-context
 */

import { createContext, useContext } from 'react'
import type { TranslateFn } from './i18n'
import { blockDisplayName, categoryDisplayName } from './block-i18n'

export interface EditorLocale {
  /** 'en' or 'zh'. */
  locale: 'en' | 'zh'
  /** UI string translator. */
  t: TranslateFn
  /** Localized block display name (falls back to English). */
  blockName: (blockId: string | undefined, englishName: string) => string
  /** Localized palette category name (falls back to English). */
  categoryName: (categoryId: string | undefined, englishName: string) => string
}

const EN: EditorLocale = {
  locale: 'en',
  t: (k) => k,
  blockName: (_id, english) => english,
  categoryName: (_id, english) => english,
}

export const EditorLocaleContext = createContext<EditorLocale>(EN)

export function useEditorLocale(): EditorLocale {
  return useContext(EditorLocaleContext)
}

/** Build the context value for a resolved editor locale + translate fn. */
export function makeEditorLocale(locale: 'en' | 'zh', t: TranslateFn): EditorLocale {
  return {
    locale,
    t,
    blockName: (id, english) => blockDisplayName(id, english, locale),
    categoryName: (id, english) => categoryDisplayName(id, english, locale),
  }
}

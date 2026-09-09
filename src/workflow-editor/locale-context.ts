/**
 * React context carrying the editor UI locale and a block-name localizer, so
 * deeply-nested node and palette components can render translated block names
 * without prop drilling.
 *
 * @module workflow-editor/locale-context
 */

import { createContext, useContext } from 'react'
import { makeBlockTranslate, type TranslateFn } from './i18n'
import { blockDescription, blockDisplayName, categoryDisplayName } from './block-i18n'

export interface EditorLocale {
  /** 'en' or 'zh'. */
  locale: 'en' | 'zh'
  /** UI chrome string translator. */
  t: TranslateFn
  /**
   * Block edit-form translator: pass the English source string, get the
   * localized rendering (falls back to the English source).
   */
  bt: (english: string) => string
  /** Localized block display name (falls back to English). */
  blockName: (blockId: string | undefined, englishName: string) => string
  /** Localized palette category name (falls back to English). */
  categoryName: (categoryId: string | undefined, englishName: string) => string
  /** Localized block catalog description (falls back to English). */
  blockDesc: (blockId: string | undefined, englishDescription: string) => string
}

const EN: EditorLocale = {
  locale: 'en',
  t: (k) => k,
  bt: (english) => english,
  blockName: (_id, english) => english,
  categoryName: (_id, english) => english,
  blockDesc: (_id, english) => english,
}

export const EditorLocaleContext = createContext<EditorLocale>(EN)

export function useEditorLocale(): EditorLocale {
  return useContext(EditorLocaleContext)
}

/** Build the context value for a resolved editor locale + translate fn. */
export function makeEditorLocale(locale: 'en' | 'zh', t: TranslateFn): EditorLocale {
  const bt = makeBlockTranslate(locale)
  return {
    locale,
    t,
    bt,
    blockName: (id, english) => blockDisplayName(id, english, locale),
    categoryName: (id, english) => categoryDisplayName(id, english, locale),
    blockDesc: (id, english) => blockDescription(id, english, locale),
  }
}

/**
 * Category labels and normalisation for the marketplace.
 *
 * A published category is either a built-in slug — translated by the panel — or
 * a free-form label a publisher typed. The label travels in `meta.json` as
 * content, so it is shown verbatim and never translated. Readers that predate a
 * custom category fall back to `other` instead of dropping the card.
 *
 * @module lib/marketplace/categories
 */

import type { Messages } from '../i18n'
import {
  MARKETPLACE_CATEGORIES,
  MAX_CATEGORY_CHARS,
  type MarketplaceCard,
  type MarketplaceCategory,
} from './types'

/** Where each built-in slug's translated label lives in the dictionary. */
const CATEGORY_MESSAGE_KEYS: Record<MarketplaceCategory, keyof Messages> = {
  ecommerce: 'marketplaceCategoryEcommerce',
  orders: 'marketplaceCategoryOrders',
  marketing: 'marketplaceCategoryMarketing',
  content: 'marketplaceCategoryContent',
  media: 'marketplaceCategoryMedia',
  data: 'marketplaceCategoryData',
  reporting: 'marketplaceCategoryReporting',
  office: 'marketplaceCategoryOffice',
  communication: 'marketplaceCategoryCommunication',
  social: 'marketplaceCategorySocial',
  support: 'marketplaceCategorySupport',
  finance: 'marketplaceCategoryFinance',
  research: 'marketplaceCategoryResearch',
  devops: 'marketplaceCategoryDevops',
  other: 'marketplaceCategoryOther',
}

export function isBuiltinCategory(value: string): value is MarketplaceCategory {
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Trims, collapses inner whitespace, drops control characters and caps the
 * length. An all-whitespace label normalises to `''`, which callers reject.
 */
export function normalizeCategory(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(text).slice(0, MAX_CATEGORY_CHARS).join('').trim()
}

/** Comparison key, so "DevOps" and "devops" share one filter entry. */
export function categoryKey(value: string): string {
  return normalizeCategory(value).toLowerCase()
}

export function categoryLabel(t: Messages, value: string): string {
  return isBuiltinCategory(value) ? (t[CATEGORY_MESSAGE_KEYS[value]] as string) : value
}

/**
 * Filter entries: every built-in slug (so the dropdown is stable before the
 * catalog loads) plus the custom labels currently published, de-duplicated by
 * case-insensitive key and sorted.
 */
export function categoryOptions(cards: readonly MarketplaceCard[]): string[] {
  const seen = new Set(MARKETPLACE_CATEGORIES.map((slug) => slug.toLowerCase()))
  const custom: string[] = []
  for (const card of cards) {
    const value = card.meta.category
    const key = categoryKey(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    custom.push(value)
  }
  return [...MARKETPLACE_CATEGORIES, ...custom.sort((a, b) => a.localeCompare(b))]
}

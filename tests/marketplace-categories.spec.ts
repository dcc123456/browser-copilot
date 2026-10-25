import { describe, expect, it } from 'vitest'
import {
  categoryKey,
  categoryLabel,
  categoryOptions,
  isBuiltinCategory,
  normalizeCategory,
} from '../src/lib/marketplace/categories'
import { buildMeta } from '../src/lib/marketplace/meta'
import { messagesFor } from '../src/lib/i18n'
import {
  MARKETPLACE_CATEGORIES,
  MAX_CATEGORY_CHARS,
  type MarketplaceCard,
} from '../src/lib/marketplace/types'

const E_COMMERCE_LABEL = 'E-commerce'

function card(category: string): MarketplaceCard {
  return {
    meta: buildMeta({
      slug: 'workflow-abcdef',
      title: 'Workflow',
      description: '',
      category,
      author: 'octocat',
      version: 1,
      hash: 'a'.repeat(64),
    }),
    prNumber: null,
    likes: 0,
    comments: 0,
  }
}

describe('normalizeCategory', () => {
  it('trims, collapses whitespace and drops control characters', () => {
    expect(normalizeCategory('  Industry \n research\t')).toBe('Industry research')
    expect(normalizeCategory('\u0000Ops\u001f')).toBe('Ops')
  })

  it('caps the label length without splitting a surrogate pair', () => {
    expect(normalizeCategory('x'.repeat(MAX_CATEGORY_CHARS + 5))).toBe(
      'x'.repeat(MAX_CATEGORY_CHARS),
    )
    expect(Array.from(normalizeCategory('😀'.repeat(MAX_CATEGORY_CHARS + 1)))).toHaveLength(
      MAX_CATEGORY_CHARS,
    )
  })

  it('normalises an all-whitespace label to empty', () => {
    expect(normalizeCategory('   ')).toBe('')
  })
})

describe('built-in categories', () => {
  it('recognises every slug and rejects a custom label', () => {
    for (const slug of MARKETPLACE_CATEGORIES) expect(isBuiltinCategory(slug)).toBe(true)
    expect(isBuiltinCategory('Industry research')).toBe(false)
    expect(isBuiltinCategory(E_COMMERCE_LABEL)).toBe(false)
  })

  it('compares labels case-insensitively', () => {
    expect(categoryKey(' DevOps ')).toBe('devops')
  })

  it('translates built-ins and shows a custom label verbatim', () => {
    const en = messagesFor('en')
    const zh = messagesFor('zh-CN')
    expect(categoryLabel(en, 'orders')).toBe('Orders & fulfillment')
    expect(categoryLabel(zh, 'orders')).toBe('订单履约')
    expect(categoryLabel(en, '行业调研')).toBe('行业调研')
    expect(categoryLabel(zh, 'Industry research')).toBe('Industry research')
  })
})

describe('categoryOptions', () => {
  it('lists every built-in first, then published custom labels sorted', () => {
    const options = categoryOptions([card('Beta ops'), card('Alpha ops'), card('devops')])
    expect(options.slice(0, MARKETPLACE_CATEGORIES.length)).toEqual([...MARKETPLACE_CATEGORIES])
    expect(options.slice(MARKETPLACE_CATEGORIES.length)).toEqual(['Alpha ops', 'Beta ops'])
  })

  it('keeps a non-ASCII custom label once, without translating it', () => {
    const options = categoryOptions([card('行业调研'), card('行业调研')])
    expect(options.filter((item) => item === '行业调研')).toHaveLength(1)
  })

  it('keeps one entry for labels that differ only by case', () => {
    const options = categoryOptions([card('Research ops'), card('research OPS')])
    expect(options.slice(MARKETPLACE_CATEGORIES.length)).toEqual(['Research ops'])
  })
})

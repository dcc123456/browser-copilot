/**
 * A stored compaction summary must be identifiable from the data alone.
 *
 * It is stored as `role: 'user'` because the wire format has no other slot, but
 * the user never typed it. Filtering only in the panel would leave exports,
 * history compilation and the Runner treating it as something the user said, so
 * the marker lives in the stored content (AC-15④).
 */
import { describe, expect, it } from 'vitest'
import {
  COMPACTION_SUMMARY_SENTINEL,
  compactHistory,
  isCompactionSummaryText,
} from '../src/lib/context-compact'
import type { WireMessage } from '../src/lib/llm'

function seeded(): WireMessage[] {
  return [
    { role: 'user', content: 'question one' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'question two' },
    { role: 'assistant', content: 'answer two' },
    { role: 'user', content: 'question three' },
  ]
}

describe('compaction summary marker', () => {
  it('stores the sentinel in the transcript, not only at render time', async () => {
    const history = seeded()
    await compactHistory(history, {
      marker: '[Context compacted]',
      keepRecentTurns: 1,
      summarize: async () => 'summary text',
    })
    const summary = history.find(
      (message) => message.role === 'user' && isCompactionSummaryText(String(message.content)),
    )
    expect(summary).toBeDefined()
    expect(String(summary?.content)).toContain(COMPACTION_SUMMARY_SENTINEL)
    expect(String(summary?.content)).toContain('summary text')
  })

  it('distinguishes a summary from a real user turn', () => {
    expect(
      isCompactionSummaryText(`${COMPACTION_SUMMARY_SENTINEL}\n[Context compacted]\nsum`),
    ).toBe(true)
    expect(isCompactionSummaryText('please submit the form')).toBe(false)
    expect(isCompactionSummaryText('')).toBe(false)
  })
})

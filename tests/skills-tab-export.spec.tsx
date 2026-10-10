// @vitest-environment jsdom
/**
 * Skills tab export acceptance:
 *  - each skill card downloads just that skill, as the same JSON shape the
 *    Import button reads back, under a filename derived from the skill name;
 *  - the panel no longer pins a skill into Chat (that is the Chat tab's
 *    selector) — it only offers to stop using the one already active.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const downloadBlob = vi.hoisted(() => vi.fn(async (..._args: [string, string, string]) => true))
vi.mock('../src/lib/export-answer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/export-answer')>()
  return { ...actual, downloadBlob }
})

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import SkillsTab from '../src/sidepanel/SkillsTab'
import type { Skill } from '../src/lib/types'

const makeSkill = (id: string, name: string): Skill => ({
  id,
  name,
  description: `${name} purpose`,
  instructions: `Always use ${name}.`,
  autoMatch: true,
  createdAt: 1,
  updatedAt: 2,
})

const renderTab = async (skills: Skill[], activeSkillId: string | null = null) => {
  const root = createRoot(document.body)
  await act(async () => {
    root.render(
      createElement(SkillsTab, {
        skills,
        activeSkillId,
        onChanged: () => {},
        onStopUsing: () => {},
      }),
    )
  })
  return root
}

const buttonLabels = (): string[] =>
  Array.from(document.querySelectorAll('button')).map((button) => button.textContent ?? '')

describe('SkillsTab single-skill export', () => {
  beforeEach(() => {
    downloadBlob.mockClear()
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    document.body.replaceChildren()
  })

  it('downloads only the clicked skill under a name-derived file', async () => {
    const root = await renderTab([makeSkill('a', 'Web Scraper'), makeSkill('b', 'Summarize')])
    // The first export button belongs to the header (export all); the cards follow.
    const exportButtons = document.querySelectorAll<HTMLButtonElement>('button.skills-export-btn')

    await act(async () => {
      exportButtons[1]!.click()
    })

    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [content, mime, filename] = downloadBlob.mock.calls[0]!
    expect(mime).toBe('application/json')
    expect(filename).toBe('Web_Scraper.json')
    expect(JSON.parse(content)).toEqual([
      {
        name: 'Web Scraper',
        description: 'Web Scraper purpose',
        instructions: 'Always use Web Scraper.',
        autoMatch: true,
      },
    ])
    await act(async () => root.unmount())
  })

  it('keeps the stop-using action only for the skill active in Chat', async () => {
    const root = await renderTab([makeSkill('a', 'Web Scraper'), makeSkill('b', 'Summarize')], 'b')

    expect(buttonLabels().filter((label) => label === 'Stop using')).toHaveLength(1)
    expect(buttonLabels().some((label) => label === 'Use in chat')).toBe(false)
    await act(async () => root.unmount())
  })
})

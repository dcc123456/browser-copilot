// @vitest-environment jsdom
/**
 * The AI-agent block form's "Skills & tools" fold-out: tools start ON (deny
 * list) while skills start OFF for new nodes (allowlist) and ON for nodes saved
 * before the switch existed; toggles write the expected node data, a reopen
 * renders stored switches, forbidden tools are absent, and a failed skill fetch
 * keeps the rest of the form usable behind a retry.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditAiAgent from '../src/workflow-editor/blocks/batchD/EditAiAgent'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
let patches: Record<string, unknown>[] = []

const captchaSkill = {
  id: 'skill-captcha',
  name: 'captcha-helper',
  description: 'Solve captchas.',
  instructions: 'i',
  autoMatch: true,
  createdAt: 0,
  updatedAt: 0,
}
const writerSkill = {
  id: 'skill-writer',
  name: 'xiaohongshu-writer',
  description: 'Write posts.',
  instructions: 'i',
  autoMatch: true,
  createdAt: 0,
  updatedAt: 0,
}

function respondWithSkills(skills: unknown[]): void {
  mocks.sendCommand.mockResolvedValue({ type: 'skills.list', skills })
}

async function mount(data: Record<string, unknown> = {}): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key
  await act(async () => {
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale('en', t) },
        createElement(EditAiAgent, {
          data: { blockId: 'ai-agent', ...data },
          onChange: (patch: Record<string, unknown>) => patches.push(patch),
          blockId: 'ai-agent',
        } as never),
      ),
    )
  })
  openSection(container, 'Skills & tools')
  return container
}

function openSection(container: HTMLElement, title: string): void {
  const header = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(title),
  )
  if (!header) throw new Error(`no "${title}" section`)
  act(() => header.click())
}

/** Tool rows carry the tool's wire name in a monospace span. */
function toolCheckbox(container: HTMLElement, name: string): HTMLInputElement {
  for (const label of container.querySelectorAll('label')) {
    if (label.querySelector('span.font-mono')?.textContent !== name) continue
    const input = label.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (input) return input
  }
  throw new Error(`no tool switch for ${name}`)
}

function skillCheckboxes(container: HTMLElement): HTMLInputElement[] {
  const inputs: HTMLInputElement[] = []
  for (const label of container.querySelectorAll('label')) {
    if (label.querySelector('span.font-mono')) continue
    const name = label.querySelector('span.text-xs')?.textContent
    if (!name) continue
    const input = label.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (input) inputs.push(input)
  }
  return inputs
}

function skillCheckbox(container: HTMLElement, name: string): HTMLInputElement {
  for (const label of container.querySelectorAll('label')) {
    if (label.querySelector('span.text-xs')?.textContent !== name) continue
    const input = label.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (input) return input
  }
  throw new Error(`no skill switch for ${name}`)
}

beforeEach(() => {
  patches = []
  mocks.sendCommand.mockReset()
  respondWithSkills([])
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('the AI-agent capability fold-out', () => {
  it('starts a new node with every skill off and every tool on', async () => {
    respondWithSkills([captchaSkill, writerSkill])
    const container = await mount({ enabledSkills: [] })

    expect(container.textContent).toContain('New nodes start with every skill off')
    expect(toolCheckbox(container, 'click').checked).toBe(true)
    expect(toolCheckbox(container, 'snapshot_page').checked).toBe(true)
    expect(skillCheckboxes(container).every((input) => !input.checked)).toBe(true)
  })

  it('keeps every skill on for a node saved before the allowlist existed', async () => {
    respondWithSkills([captchaSkill, writerSkill])
    // No `enabledSkills` key = legacy node, which used every skill.
    const container = await mount()

    expect(skillCheckboxes(container).every((input) => input.checked)).toBe(true)
    expect(toolCheckbox(container, 'click').checked).toBe(true)
  })

  it('does not offer switches that could never change a workflow turn', async () => {
    const container = await mount()
    for (const name of [
      'generate_workflow',
      'verify_workflow',
      'repair_workflow',
      'ask_user',
      // Runtime-forbidden: state changes no workflow run can approve.
      'tab_close',
      'pin_tab',
      'unpin_tab',
      'save_local',
      'create_skill',
      'list_scheduled_tasks',
      'create_scheduled_task',
      'present_plan',
      'delegate_to_agent',
    ]) {
      expect(() => toolCheckbox(container, name)).toThrow()
    }
    expect(container.textContent).not.toContain('compose_workflow')
  })

  it('hides the manual-only plan skill', async () => {
    respondWithSkills([
      captchaSkill,
      {
        id: 'builtin-plan',
        name: 'plan',
        description: 'Plan first.',
        instructions: 'i',
        autoMatch: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const container = await mount()
    expect(skillCheckboxes(container)).toHaveLength(1)
  })

  it('writes a tool deny entry when a switch is turned off', async () => {
    const container = await mount()
    act(() => toolCheckbox(container, 'click').click())
    expect(patches.at(-1)).toEqual({ disabledTools: ['click'] })
  })

  it('renders stored tool deny names unchecked after reopening', async () => {
    const container = await mount({ disabledTools: ['click'] })
    expect(toolCheckbox(container, 'click').checked).toBe(false)
    expect(toolCheckbox(container, 'snapshot_page').checked).toBe(true)
  })

  it('writes an allowlist entry when a new node enables a skill', async () => {
    respondWithSkills([captchaSkill, writerSkill])
    const container = await mount({ enabledSkills: [] })
    act(() => skillCheckbox(container, captchaSkill.name).click())
    expect(patches.at(-1)).toEqual({ enabledSkills: [captchaSkill.name] })
  })

  it('materialises the full allowlist when a legacy node switches a skill off', async () => {
    respondWithSkills([captchaSkill, writerSkill])
    const container = await mount()
    act(() => skillCheckbox(container, writerSkill.name).click())
    // Writing a one-name list here would read as "only captcha", which is the
    // intended result — but it must come from the legacy all-on state, not
    // from an accidental deny.
    expect(patches.at(-1)).toEqual({ enabledSkills: [captchaSkill.name] })
  })

  it('renders stored allowlist entries checked after reopening', async () => {
    respondWithSkills([captchaSkill, writerSkill])
    const reopened = await mount({ enabledSkills: [writerSkill.name] })
    expect(skillCheckbox(reopened, writerSkill.name).checked).toBe(true)
    expect(skillCheckbox(reopened, captchaSkill.name).checked).toBe(false)
  })

  it('keeps the form usable when the skill list fails, and retries', async () => {
    mocks.sendCommand.mockRejectedValueOnce(new Error('worker asleep'))
    const container = await mount()
    expect(container.textContent).toContain('Could not load saved skills.')
    // The tool switches are static data and stay available.
    expect(toolCheckbox(container, 'click').checked).toBe(true)

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.title === 'Reload skills',
    )
    if (!retry) throw new Error('no retry button')
    respondWithSkills([captchaSkill])
    await act(async () => retry.click())

    expect(container.textContent).not.toContain('Could not load saved skills.')
    expect(skillCheckbox(container, captchaSkill.name).checked).toBe(true)
  })
})

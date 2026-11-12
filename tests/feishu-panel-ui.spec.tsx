// @vitest-environment jsdom
/**
 * The Feishu integration panel (`sidepanel/TasksTab` → `FeishuSection`).
 *
 * The panel used to be a flat list of legacy-class fields whose only feedback
 * was a banner at the very top of the tab, two save buttons that disagreed about
 * when a save was possible, and no indication that a click had started anything.
 * These tests pin what replaced that:
 *
 *  - the two targets are separate, titled groups, and the folded summary says
 *    whether anything is configured at all;
 *  - exactly one save control, enabled when any part of the config holds a value;
 *  - a pending action re-labels its own button instead of silently greying out;
 *  - the outcome lands inside the panel (role=status / role=alert), not above
 *    the task list;
 *  - the bot fields and its warning only exist while the bot is enabled, and the
 *    webhook secret stays masked unless revealed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  })
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import { EMPTY_FEISHU_CONFIG, type FeishuConfig } from '../src/lib/scheduler-types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import TasksTab from '../src/sidepanel/TasksTab'

const t = messagesFor('en')

let feishu: FeishuConfig = { ...EMPTY_FEISHU_CONFIG }
const seen: Command[] = []

function deferred(): { promise: Promise<unknown>; settle: (value: unknown) => void } {
  let settle = (_value: unknown): void => {}
  const promise = new Promise<unknown>((resolved) => {
    settle = (value) => resolved(value)
  })
  return { promise, settle }
}

/** The command that is currently held open by a test, if any. */
let pending: { promise: Promise<unknown>; settle: (value: unknown) => void } | null = null

beforeEach(() => {
  feishu = { ...EMPTY_FEISHU_CONFIG }
  seen.length = 0
  pending = null
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'tasks.list':
        return { type: 'tasks.list', tasks: [] }
      case 'workflows.list':
        return { type: 'workflows.list', workflows: [] }
      case 'tasks.running':
        return { type: 'tasks.running', runs: [], finished: [] }
      case 'feishu.get':
        return { type: 'feishu.get', config: { ...feishu } }
      case 'feishu.save':
        feishu = { ...command.config }
        if (pending) return pending.promise
        return { type: 'feishu.save' }
      case 'feishu.test':
        return pending ? pending.promise : { type: 'feishu.test', ok: true }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
  })
})

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderPanel(config: FeishuConfig = feishu): Promise<HTMLElement> {
  feishu = config
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      createElement(I18nProvider, { value: { locale: 'en' as const, t } }, createElement(TasksTab)),
    )
  })
  await flush()
  return container
}

const byText = (
  container: HTMLElement,
  selector: string,
  text: string,
): HTMLButtonElement | undefined =>
  [...container.querySelectorAll(selector)].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined

/** The card the folded `<details>` wraps. */
const panel = (container: HTMLElement): HTMLElement =>
  container.querySelector('details.collapsible > div') as HTMLElement

const inputOf = (container: HTMLElement, label: string): HTMLInputElement => {
  const field = [...container.querySelectorAll('label')].find((element) =>
    element.textContent?.includes(label),
  )
  const input = field?.querySelector('input')
  if (!input) throw new Error(`no input for "${label}"`)
  return input as HTMLInputElement
}

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('feishu panel structure', () => {
  it('splits the two targets into titled groups with one heading each', async () => {
    const container = await renderPanel()
    const card = panel(container)
    expect(card.textContent).toContain(t.tasksFeishuWebhookGroup)
    expect(card.textContent).toContain(t.tasksFeishuBotGroup)
    // The old panel repeated its own title as an <h3> inside the card.
    expect(card.querySelectorAll('h3')).toHaveLength(0)
    // The bot credentials only exist once the switch is on.
    expect(card.textContent).not.toContain(t.tasksFeishuAppId)
    expect(card.textContent).not.toContain(t.tasksFeishuWarnTitle)
  })

  it('shows the configured state on the folded summary and the card', async () => {
    const empty = await renderPanel()
    expect(empty.querySelector('summary')!.textContent).toContain(t.tasksFeishuNotConfigured)

    const filled = await renderPanel({
      ...EMPTY_FEISHU_CONFIG,
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
    })
    expect(filled.querySelector('summary')!.textContent).toContain(t.tasksFeishuConfigured)
    expect(panel(filled).textContent).toContain(t.tasksFeishuConfigured)
  })

  it('keeps the bot fields and its warning hidden until the switch is on', async () => {
    const container = await renderPanel({ ...EMPTY_FEISHU_CONFIG, appId: 'cli_1' })
    const card = panel(container)
    expect(card.textContent).not.toContain(t.tasksFeishuAppId)

    click(card.querySelector('[role="switch"]')!)
    await flush()

    expect(card.textContent).toContain(t.tasksFeishuAppId)
    expect(card.textContent).toContain(t.tasksFeishuAppSecret)
    expect(card.textContent).toContain(t.tasksFeishuWarnTitle)
    expect(card.textContent).toContain(t.tasksFeishuBotWarn)
  })
})

describe('feishu panel saving', () => {
  it('offers exactly one save button, enabled only once something is filled in', async () => {
    const empty = await renderPanel()
    expect(
      [...empty.querySelectorAll('button')].filter((b) => b.textContent === t.save),
    ).toHaveLength(1)
    expect(byText(empty, 'button', t.save)!.disabled).toBe(true)

    const container = await renderPanel()
    type(inputOf(container, t.tasksFeishuWebhook), 'https://open.feishu.cn/hook/abc')
    expect(byText(container, 'button', t.save)!.disabled).toBe(false)
  })

  it('re-labels the save button while the round trip runs', async () => {
    const container = await renderPanel({
      ...EMPTY_FEISHU_CONFIG,
      webhookUrl: 'https://open.feishu.cn/hook/abc',
    })
    pending = deferred()
    const save = byText(container, 'button', t.save)!

    click(save)
    expect(save.textContent).toBe(t.tasksFeishuSaving)

    act(() => pending!.settle({ type: 'feishu.save' }))
    await flush()

    expect(save.textContent).toBe(t.save)
    expect(save.disabled).toBe(false)
  })

  it('reports the outcome inside the panel, not in the page banner', async () => {
    const container = await renderPanel({
      ...EMPTY_FEISHU_CONFIG,
      webhookUrl: 'https://open.feishu.cn/hook/abc',
    })
    click(byText(container, 'button', t.save)!)
    await flush()

    const status = panel(container).querySelector('[role="status"]')
    expect(status?.textContent).toBe(t.tasksFeishuSaved)
    // The banner sits above the task list, out of sight behind a folded panel.
    expect(container.querySelector('.banner')).toBeNull()
  })

  it('shows a rejected save as an in-panel alert', async () => {
    const container = await renderPanel({
      ...EMPTY_FEISHU_CONFIG,
      webhookUrl: 'https://open.feishu.cn/hook/abc',
    })
    pending = deferred()
    click(byText(container, 'button', t.save)!)
    act(() => pending!.settle(Promise.reject(new Error('disk is full'))))
    await flush()

    const alert = panel(container).querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('disk is full')
    expect(byText(container, 'button', t.save)!.disabled).toBe(false)
  })
})

describe('feishu panel test message', () => {
  it('re-labels the test button and reports the worker answer in place', async () => {
    const container = await renderPanel({
      ...EMPTY_FEISHU_CONFIG,
      webhookUrl: 'https://open.feishu.cn/hook/abc',
    })
    pending = deferred()
    const test = byText(container, 'button', t.tasksFeishuTest)!

    click(test)
    expect(test.textContent).toBe(t.tasksFeishuTesting)
    // A second click while in flight must not start another send.
    click(test)
    expect(seen.filter((command) => command.type === 'feishu.test')).toHaveLength(0)

    act(() => pending!.settle({ type: 'feishu.test', ok: true }))
    await flush()

    expect(test.textContent).toBe(t.tasksFeishuTest)
    expect(panel(container).querySelector('[role="status"]')?.textContent).toBe(t.tasksFeishuTestOk)
  })

  it('stays disabled without a webhook URL', async () => {
    const container = await renderPanel()
    expect(byText(container, 'button', t.tasksFeishuTest)!.disabled).toBe(true)
  })
})

describe('feishu panel secrets', () => {
  it('masks the webhook secret until revealed', async () => {
    const container = await renderPanel({ ...EMPTY_FEISHU_CONFIG, webhookSecret: 's3cret' })
    const secret = inputOf(container, t.tasksFeishuWebhookSecret)
    expect(secret.type).toBe('password')

    click(inputOf(container, t.tasksFeishuReveal))
    await flush()

    expect(inputOf(container, t.tasksFeishuWebhookSecret).type).toBe('text')
  })
})

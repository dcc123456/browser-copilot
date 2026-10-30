// @vitest-environment jsdom
/**
 * Top-of-panel notices: the close button must be present on every notice, must
 * call the caller's dismissal, and must not also trigger the notice's own click
 * action (a failed-run banner deep-links into History).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import Banner from '../src/sidepanel/components/Banner'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(I18nProvider, {
        value: { locale: 'en', t: messagesFor('en') },
        children: element,
      } as never),
    )
  })
  return container
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('Banner dismissal', () => {
  it('closes without firing the notice action', async () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    const container = await render(
      createElement(Banner, {
        kind: 'error',
        onDismiss,
        onClick,
        link: true,
        children: 'run failed',
      }),
    )

    const close = container.querySelector(`[aria-label="${messagesFor('en').bannerDismiss}"]`)!
    expect(close).not.toBeNull()
    act(() => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
    // The class the older tests read the message from survives.
    expect(container.querySelector('.banner-text')?.textContent).toBe('run failed')
    expect(container.querySelector('.banner')?.classList.contains('banner-link')).toBe(true)
  })

  it('has no close button when the caller cannot dismiss it', async () => {
    const container = await render(createElement(Banner, { kind: 'ok', children: 'saved' }))
    expect(container.querySelector('button')).toBeNull()
  })
})

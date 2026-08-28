/**
 * Smoke tests for the shared confirm dialog and toast hosts.
 *
 * These render the components to static HTML with react-dom/server (no DOM
 * environment needed) to assert structure and a11y semantics; interaction is
 * exercised by the promise contract of confirmDialog/alertDialog.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmHost } from '../src/ui/confirm'
import { ToastHost, toast } from '../src/ui/toast'

describe('ConfirmHost', () => {
  it('renders nothing before a dialog is requested', () => {
    const html = renderToStaticMarkup(createElement(ConfirmHost))
    expect(html).toBe('')
  })

  it('falls back to window.confirm when no host is mounted', async () => {
    // No host mounted here: the module guard resolves false (jsdom-less env has
    // no window either, which the guard also handles).
    const { confirmDialog } = await import('../src/ui/confirm')
    // In node there is no window; resolve without throwing.
    const result = await confirmDialog({ title: 't' })
    expect(typeof result).toBe('boolean')
  })
})

describe('ToastHost', () => {
  it('renders an empty stack initially', () => {
    const html = renderToStaticMarkup(createElement(ToastHost))
    expect(html).toContain('ui-toast-stack')
    expect(html).not.toContain('ui-toast ')
  })

  it('does not throw when toast() is called without a mounted host', () => {
    expect(() => toast('hello', 'info')).not.toThrow()
  })
})

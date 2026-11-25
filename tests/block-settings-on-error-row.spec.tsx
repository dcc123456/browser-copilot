/**
 * On the block settings dialog's "On error" tab, enabling the retry switch must
 * show the retry Times and Interval on ONE line. The stacked layout the port
 * started with read as two unrelated settings; the shared parent + flex-row
 * classes are what keeps them together.
 *
 * See specs/2026-11-25-on-error-retry-inline-row-design.md.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OnErrorFields } from '../src/workflow-editor/blocks/shared/BlockSettingsFields'
import {
  EditorLocaleContext,
  makeEditorLocale,
  type EditorLocale,
} from '../src/workflow-editor/locale-context'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'

function localeFor(locale: 'en' | 'zh'): EditorLocale {
  return makeEditorLocale(
    locale,
    (key) => (EDITOR_STRINGS[locale] as Record<string, string>)[key] ?? key,
  )
}

function onErrorTab(locale: 'en' | 'zh', onError: Record<string, unknown>): HTMLElement {
  const html = renderToStaticMarkup(
    createElement(
      EditorLocaleContext.Provider,
      { value: localeFor(locale) },
      createElement(OnErrorFields, {
        data: { onError },
        onChange: () => {},
        blockId: 'event-click',
      }),
    ),
  )
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

const retryOn = { enable: true, retry: true }

describe('the on-error retry fields', () => {
  it('puts Times and Interval in one flex row', () => {
    const host = onErrorTab('en', retryOn)
    const fields = host.querySelectorAll<HTMLElement>('.wf-inline-field')
    expect(fields).toHaveLength(2)
    expect(fields[0]!.textContent).toContain('Times')
    expect(fields[1]!.textContent).toContain('Interval')
    // Same parent → one row; not the old column stack.
    expect(fields[0]!.parentElement).toBe(fields[1]!.parentElement)
    expect(fields[0]!.parentElement?.className).toContain('flex')
    expect(fields[0]!.parentElement?.className).not.toContain('flex-col')
  })

  it('keeps the zh labels on that same row', () => {
    const host = onErrorTab('zh', retryOn)
    const fields = host.querySelectorAll<HTMLElement>('.wf-inline-field')
    expect(fields).toHaveLength(2)
    expect(fields[0]!.textContent).toContain('次数')
    expect(fields[1]!.textContent).toContain('间隔')
    expect(fields[0]!.parentElement).toBe(fields[1]!.parentElement)
  })

  it('shows neither field while retry is off', () => {
    const host = onErrorTab('en', { enable: true, retry: false })
    expect(host.querySelectorAll('.wf-inline-field')).toHaveLength(0)
  })
})

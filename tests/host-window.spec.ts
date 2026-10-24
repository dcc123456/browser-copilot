// @vitest-environment jsdom
/**
 * The editor URL carries the workflow id so the panel's Edit action can find
 * an already-open editor instead of stacking a second window. A new workflow
 * gets its id at load but is opened without the param; the rewrite has to put
 * it there before the first save.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { rememberEditedWorkflow } from '../src/workflow-editor/host-window'

const setUrl = (path: string): void => {
  window.history.replaceState(null, '', path)
}

const params = (): URLSearchParams => new URLSearchParams(window.location.search)

describe('rememberEditedWorkflow', () => {
  afterEach(() => {
    setUrl('/src/workflow-editor/index.html')
  })

  it('adds the workflow id without dropping the host window', () => {
    setUrl('/src/workflow-editor/index.html?hostWindow=42')

    rememberEditedWorkflow('wf-1')

    expect(window.location.pathname).toBe('/src/workflow-editor/index.html')
    expect(params().get('edit')).toBe('wf-1')
    expect(params().get('hostWindow')).toBe('42')
  })

  it('keeps an editor opened from the list untouched', () => {
    setUrl('/src/workflow-editor/index.html?edit=wf-1&hostWindow=42')

    rememberEditedWorkflow('wf-1')

    expect(params().get('edit')).toBe('wf-1')
    expect(params().get('hostWindow')).toBe('42')
  })
})

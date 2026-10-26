// @vitest-environment jsdom
/**
 * `copyText` copies through the click-gesture `execCommand` route; extension
 * pages cannot rely on `navigator.clipboard.writeText` without clipboardWrite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/lib/clipboard'

const originalExecCommand = document.execCommand

afterEach(() => {
  Object.defineProperty(document, 'execCommand', {
    value: originalExecCommand,
    configurable: true,
    writable: true,
  })
  document.body.innerHTML = ''
})

function stubExecCommand(impl: () => boolean): void {
  Object.defineProperty(document, 'execCommand', { value: vi.fn(impl), configurable: true })
}

describe('copyText', () => {
  it('selects the text and copies it through execCommand', async () => {
    const seen: string[] = []
    stubExecCommand(() => {
      seen.push(document.querySelector('textarea')?.value ?? '')
      return true
    })
    await copyText('wf-copy-me')
    expect(seen).toEqual(['wf-copy-me'])
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('rejects and cleans up when the browser refuses the copy', async () => {
    stubExecCommand(() => false)
    await expect(copyText('nope')).rejects.toThrow('refused')
    expect(document.querySelector('textarea')).toBeNull()
  })
})

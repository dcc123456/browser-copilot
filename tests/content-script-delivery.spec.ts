/**
 * The worker's content-script delivery gate.
 *
 * Every content script of the extension hears every tab message, so a resolved
 * `tabs.sendMessage` says nothing about WHICH script is there. These rows pin
 * the rule that only the addressed script's own `{ ok: true }` receipt counts
 * as delivered; silence or a rejection means the named file is injected.
 *
 * @module tests/content-script-delivery
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverToContentScript } from '../src/background/content-script-delivery'

interface Stub {
  sendMessage: ReturnType<typeof vi.fn>
  executeScript: ReturnType<typeof vi.fn>
}

let stub: Stub

beforeEach(() => {
  stub = {
    sendMessage: vi.fn(),
    executeScript: vi.fn(async () => []),
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { sendMessage: stub.sendMessage },
    scripting: { executeScript: stub.executeScript },
  }
})

afterEach(() => {
  delete (globalThis as Partial<{ chrome: unknown }>).chrome
})

describe('content script delivery', () => {
  it('treats the addressed script receipt as delivered', async () => {
    stub.sendMessage.mockResolvedValue({ ok: true })

    await expect(deliverToContentScript(7, { type: 'floating.show' }, 'floating.js')).resolves.toBe(
      true,
    )
    expect(stub.executeScript).not.toHaveBeenCalled()
  })

  it('injects when another listener resolves the send without a receipt', async () => {
    // The picker launcher answers nothing for floating messages; the send still
    // resolves because its listener exists.
    stub.sendMessage.mockResolvedValue(undefined)

    await expect(deliverToContentScript(7, { type: 'floating.show' }, 'floating.js')).resolves.toBe(
      false,
    )
    expect(stub.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['floating.js'],
    })
  })

  it('injects when the tab has no listener at all', async () => {
    stub.sendMessage.mockRejectedValue(new Error('Could not establish connection.'))

    await expect(
      deliverToContentScript(7, { type: 'elementPicker.set' }, 'launcher.js'),
    ).resolves.toBe(false)
    expect(stub.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['launcher.js'],
    })
  })

  it('never injects when the caller names no script', async () => {
    stub.sendMessage.mockRejectedValue(new Error('Could not establish connection.'))

    await expect(deliverToContentScript(7, { type: 'floating.hide' })).resolves.toBe(false)
    expect(stub.executeScript).not.toHaveBeenCalled()
  })

  it('swallows injection failures on pages that cannot host content scripts', async () => {
    stub.sendMessage.mockRejectedValue(new Error('no receiver'))
    stub.executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'))

    await expect(deliverToContentScript(7, { type: 'floating.show' }, 'floating.js')).resolves.toBe(
      false,
    )
  })
})

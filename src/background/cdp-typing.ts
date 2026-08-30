/**
 * Trusted keyboard input via CDP for contenteditable rich editors.
 *
 * When the in-page kernel's simulated typing fails to update a stateful
 * editor (DraftJS — Zhihu articles — and friends keep content in React state
 * and some builds ignore untrusted synthetic events), the driver escalates
 * here. The Chrome DevTools Protocol is the sanctioned channel for REAL
 * input: `Input.insertText` commits text the way an IME does, and
 * `Input.dispatchKeyEvent` produces keydown/keypress/textInput events that
 * are indistinguishable from a human keyboard — `isTrusted: true` all the
 * way, so DraftJS's EditorState, the word count and the publish button all
 * update.
 *
 * The sequence mirrors what a person does: click/focus the editor, place the
 * caret, select-all + Backspace to clear, then type paragraph by paragraph
 * with Enter between them. Every step is verified by reading the editor back;
 * a failed round is retried character by character before giving up.
 *
 * Pure helpers (`splitParagraphs`, `charKeyEvent`, `enterKeyEvent`) are
 * exported for unit tests; only `fillViaCdp` touches the protocol.
 *
 * @module background/cdp-typing
 */

import type { CdpSession } from './cdp-shadow'

export interface CdpFillOptions {
  /** document.querySelector path of the contenteditable, from the kernel. */
  selector: string
  text: string
  /** False to append at the caret instead of replacing the content. */
  clear?: boolean
}

export interface CdpFillOutcome {
  ok: boolean
  note?: string
  error?: string
}

/** CDP Input.dispatchKeyEvent modifier bitmask for Ctrl. */
const MOD_CTRL = 2

/** Split on every newline variant; each part becomes one editor block. */
export function splitParagraphs(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** Whether a character is printable ASCII (has a real virtual key code). */
function isPrintableAscii(ch: string): boolean {
  return ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126
}

/**
 * A Playwright-style key event for one character: keyDown carries `text`
 * (which makes Chromium perform the actual insertion), keyUp releases it.
 * Non-ASCII characters have no virtual key code and are inserted via
 * `Input.insertText` instead (see typeParagraphs).
 */
export function charKeyEvent(ch: string, down: boolean): Record<string, unknown> {
  const ascii = isPrintableAscii(ch)
  const vkey = ascii ? ch.toUpperCase().charCodeAt(0) : 0
  const code = ascii
    ? /^[a-zA-Z]$/.test(ch)
      ? `Key${ch.toUpperCase()}`
      : /^[0-9]$/.test(ch)
        ? `Digit${ch}`
        : ch
    : ''
  const params: Record<string, unknown> = {
    type: down ? 'keyDown' : 'keyUp',
    key: ch,
    code,
    windowsVirtualKeyCode: vkey,
    nativeVirtualKeyCode: vkey,
  }
  if (down) params.text = ch
  return params
}

/** Trusted Enter: keyDown with `text: '\r'` makes Chromium split the block. */
export function enterKeyEvent(down: boolean): Record<string, unknown> {
  const base = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  }
  return down ? { type: 'keyDown', ...base, text: '\r' } : { type: 'keyUp', ...base }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whitespace-free comparison form: paragraph restructuring must not matter. */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

async function evaluateJson<T = unknown>(session: CdpSession, expression: string): Promise<T> {
  const response = (await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })) as {
    result?: { value?: unknown }
    exceptionDetails?: { exception?: { description?: string } }
  }
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? '页面执行出错')
  }
  return (response.result?.value ?? null) as T
}

async function sendKey(session: CdpSession, params: Record<string, unknown>): Promise<void> {
  await session.send('Input.dispatchKeyEvent', params)
}

/**
 * Focus the editor and place the caret at its end, in the page itself.
 * Returns false when the selector no longer matches (content changed, frame
 * navigated).
 */
async function focusAndCaret(session: CdpSession, selector: string): Promise<boolean> {
  const expression = `(function (sel) {
  var el = document.querySelector(sel)
  if (!el) return { ok: false }
  if (typeof el.focus === 'function') el.focus()
  var s = window.getSelection()
  if (s) {
    var r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    s.removeAllRanges()
    s.addRange(r)
  }
  return { ok: true }
})(${JSON.stringify(selector)})`
  const result = await evaluateJson<{ ok?: boolean }>(session, expression)
  return result?.ok === true
}

/** Trusted select-all + Backspace: the editor clears its own state. */
async function clearViaKeys(session: CdpSession): Promise<void> {
  await sendKey(session, {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: MOD_CTRL,
  })
  await sendKey(session, {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: MOD_CTRL,
  })
  await sleep(30)
  await sendKey(session, {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  })
  await sendKey(session, {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  })
}

/**
 * Type paragraph by paragraph: `Input.insertText` per paragraph (one IME-style
 * commit), trusted Enter between paragraphs so block-splitting editors see a
 * real Enter keypress rather than a bare "\n" character.
 */
async function typeParagraphs(
  session: CdpSession,
  paragraphs: string[],
  perChar: boolean,
): Promise<void> {
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (i > 0) {
      await sendKey(session, enterKeyEvent(true))
      await sendKey(session, enterKeyEvent(false))
      await sleep(10)
    }
    const paragraph = paragraphs[i] ?? ''
    if (!paragraph) continue
    if (perChar) {
      for (const ch of Array.from(paragraph)) {
        if (isPrintableAscii(ch)) {
          await sendKey(session, charKeyEvent(ch, true))
          await sendKey(session, charKeyEvent(ch, false))
        } else {
          await session.send('Input.insertText', { text: ch })
        }
      }
    } else {
      await session.send('Input.insertText', { text: paragraph })
    }
  }
}

function compare(actual: string, expected: string, clear: boolean): boolean {
  const a = stripWhitespace(actual)
  const e = stripWhitespace(expected)
  if (e === '') return a === ''
  return clear ? a === e : a.endsWith(e)
}

/**
 * Fill the contenteditable at `selector` through trusted CDP input, verifying
 * the editor's text after every strategy:
 *
 *   1. paragraph-level `Input.insertText` (fast, IME-like)
 *   2. character-by-character trusted keys (Playwright-style typing)
 *
 * The selector comes from the kernel, which computed it while the element was
 * in hand; it is resolved again here inside the page's top frame.
 */
export async function fillViaCdp(
  session: CdpSession,
  options: CdpFillOptions,
): Promise<CdpFillOutcome> {
  const { selector, text, clear = true } = options

  const focused = await focusAndCaret(session, selector)
  if (!focused) {
    return { ok: false, error: `CDP 未找到编辑器元素（${selector}）` }
  }

  const readExpression = `(function (sel) {
  var el = document.querySelector(sel)
  if (!el) return ''
  return (el.innerText !== undefined && el.innerText !== null && el.innerText !== '')
    ? el.innerText
    : (el.textContent || '')
})(${JSON.stringify(selector)})`

  const read = async (): Promise<string> => {
    const value = await evaluateJson<unknown>(session, readExpression)
    return typeof value === 'string' ? value : ''
  }

  if (clear) {
    await clearViaKeys(session)
  } else {
    // Append mode: still re-focus (the kernel already placed the caret, but a
    // debugger attach must not lose it) — focusAndCaret already ran above.
  }

  if (stripWhitespace(text) !== '') {
    const paragraphs = splitParagraphs(text)
    await typeParagraphs(session, paragraphs, false)
    await sleep(150)
    if (compare(await read(), text, clear)) {
      return {
        ok: true,
        note: `已通过受信任键盘输入写入 ${Array.from(text).length} 字（chrome.debugger）`,
      }
    }

    // Retry character by character — some editors mishandle a single large
    // IME commit but accept real keystrokes.
    await clearViaKeys(session)
    await typeParagraphs(session, paragraphs, true)
    await sleep(300)
    if (compare(await read(), text, clear)) {
      return {
        ok: true,
        note: `已通过逐键受信任输入写入 ${Array.from(text).length} 字（chrome.debugger）`,
      }
    }
    return { ok: false, error: '编辑器仍未接受受信任输入（内容未更新）。' }
  }

  // Clear-only fill: verify the editor is empty now.
  await sleep(150)
  if (compare(await read(), '', true)) {
    return { ok: true, note: '已清空编辑器（chrome.debugger）' }
  }
  return { ok: false, error: '编辑器清空未生效。' }
}

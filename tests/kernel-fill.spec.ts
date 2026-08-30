/**
 * Simulated-typing fill for contenteditable rich editors (kernel).
 *
 * DraftJS editors (Zhihu articles) keep content in React state: a plain
 * `textContent` write paints the DOM but the editor's internal state — word
 * count, publish button — stays "empty". The kernel must replay the event
 * sequence a real keypress produces: `beforeinput` (modern editors),
 * `textInput` (React/DraftJS's Chrome path), keydown Enter for block splits
 * and Backspace for clearing, with legacy keyCode/which set.
 *
 * jsdom has no TextEvent, so these tests also exercise the Event fallback
 * that carries `data`; real Chrome constructs a genuine TextEvent.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, OpResult, Target } from '../src/lib/ops'

let dom: JSDOM
let editor: HTMLElement

const target: Target = {
  primary: { how: 'css', value: '#editor' },
  fallbacks: [],
}

function cssTarget(id: string): Target {
  return { primary: { how: 'css', value: `#${id}` }, fallbacks: [] }
}

function makePage(): void {
  dom = new JSDOM(
    `<!DOCTYPE html><body><div id="editor" contenteditable="true"></div>
     <div id="plain" contenteditable="true"></div></body>`,
    { url: 'https://zhihu.test/write', pretendToBeVisual: true },
  )
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.HTMLAnchorElement = dom.window.HTMLAnchorElement
  g.HTMLSelectElement = dom.window.HTMLSelectElement
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  g.HTMLFormElement = dom.window.HTMLElement
  g.ShadowRoot = dom.window.ShadowRoot
  g.DocumentFragment = dom.window.DocumentFragment
  g.MouseEvent = dom.window.MouseEvent
  g.PointerEvent = dom.window.PointerEvent
  g.Event = dom.window.Event
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.InputEvent = dom.window.InputEvent
  g.CustomEvent = dom.window.CustomEvent
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  editor = dom.window.document.getElementById('editor') as HTMLElement
}

interface EventRecord {
  type: string
  data?: string
  keyCode?: number
  which?: number
  key?: string
}

/**
 * A DraftJS-like editor: state lives here (not in the DOM); it listens on the
 * Chrome/DraftJS path (`textInput` + keydown), never on `input`.
 */
class FakeDraftEditor {
  state = ''
  private selectAllArmed = false
  readonly events: EventRecord[] = []

  constructor(private el: HTMLElement) {
    el.addEventListener('textInput', (ev) => {
      const data = (ev as unknown as { data?: string }).data ?? ''
      this.events.push({ type: 'textInput', data })
      ev.preventDefault()
      this.state += data
      this.sync()
    })
    el.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent
      this.events.push({ type: 'keydown', key: e.key, keyCode: e.keyCode, which: e.which })
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        this.selectAllArmed = true
        e.preventDefault()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this.state += '\n'
        this.sync()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        if (this.selectAllArmed || this.domSelectionCoversAll()) this.state = ''
        else this.state = this.state.slice(0, -1)
        this.selectAllArmed = false
        this.sync()
      }
    })
  }

  private domSelectionCoversAll(): boolean {
    const sel = dom.window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    return !range.collapsed && this.el.contains(range.commonAncestorContainer)
  }

  private sync(): void {
    this.el.textContent = this.state.replace(/\n/g, '')
  }
}

/** A Lexical/Slate-like editor: state via `beforeinput` only. */
class FakeBeforeInputEditor {
  state = ''
  constructor(el: HTMLElement) {
    el.addEventListener('beforeinput', (ev) => {
      const data = (ev as unknown as { data?: string }).data ?? ''
      ev.preventDefault()
      this.state += data
      el.textContent = this.state.replace(/\n/g, '')
    })
  }
}

function fill(value: string, opts: { clear?: boolean; id?: string } = {}): Op {
  const op: Op = { action: 'fill', target: cssTarget(opts.id ?? 'editor'), value }
  if (opts.clear !== undefined) op.clear = opts.clear
  return op
}

beforeEach(() => {
  makePage()
})

describe('kernel fill into stateful contenteditable editors', () => {
  it('types through the textInput path so a DraftJS-style editor registers the text', async () => {
    const fake = new FakeDraftEditor(editor)
    const result = (await runOp(fill('你好，世界'))) as unknown as OpResult
    expect(result.ok).toBe(true)
    expect(fake.state).toBe('你好，世界')
    expect((result.data as { registered?: boolean }).registered).toBe(true)
  })

  it('splits paragraphs through keydown Enter, like a real typist', async () => {
    const fake = new FakeDraftEditor(editor)
    const result = (await runOp(fill('第一段\n第二段'))) as unknown as OpResult
    expect(result.ok).toBe(true)
    expect(fake.state).toBe('第一段\n第二段')
    const enter = fake.events.find((e) => e.type === 'keydown' && e.key === 'Enter')
    expect(enter?.keyCode).toBe(13)
    expect(enter?.which).toBe(13)
  })

  it('serves beforeinput-only editors (Lexical/Slate style)', async () => {
    const fake = new FakeBeforeInputEditor(editor)
    const result = (await runOp(fill('modern editor text'))) as unknown as OpResult
    expect(result.ok).toBe(true)
    expect(fake.state).toBe('modern editor text')
  })

  it('clears previous content like select-all + Backspace', async () => {
    const fake = new FakeDraftEditor(editor)
    fake.state = '旧的草稿内容'
    fake['sync']()
    const result = (await runOp(fill('新的内容'))) as unknown as OpResult
    expect(result.ok).toBe(true)
    expect(fake.state).toBe('新的内容')
  })

  it('append mode (clear:false) keeps existing content', async () => {
    const fake = new FakeDraftEditor(editor)
    fake.state = '开头'
    fake['sync']()
    const result = (await runOp(fill('＋结尾', { clear: false }))) as unknown as OpResult
    expect(result.ok).toBe(true)
    expect(fake.state).toBe('开头＋结尾')
  })

  it('reports registered:false (and a css path) when the editor ignores everything', async () => {
    const result = (await runOp(fill('ignored text'))) as unknown as OpResult
    expect(result.ok).toBe(false)
    const data = result.data as { registered?: boolean; cssPath?: string }
    expect(data.registered).toBe(false)
    expect(typeof data.cssPath).toBe('string')
    expect(data.cssPath?.length).toBeGreaterThan(0)
  })

  it('clear-only fill (empty value) empties the editor', async () => {
    const fake = new FakeDraftEditor(editor)
    fake.state = '待清空'
    fake['sync']()
    const result = (await runOp(fill(''))) as unknown as OpResult
    expect(result.ok).toBe(true)
    expect(fake.state).toBe('')
  })

  it('press_key Enter carries keyCode/which 13 (DraftJS matches on e.which)', () => {
    const seen: EventRecord[] = []
    editor.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent
      seen.push({ type: 'keydown', key: e.key, keyCode: e.keyCode, which: e.which })
    })
    const result = runOp({ action: 'press_key', target, value: 'Enter' } as unknown as Op)
    expect(result.ok).toBe(true)
    const down = seen.find((e) => e.type === 'keydown')
    expect(down?.key).toBe('Enter')
    expect(down?.keyCode).toBe(13)
    expect(down?.which).toBe(13)
  })
})

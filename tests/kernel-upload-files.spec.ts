/**
 * In-page kernel file injection tests (U012-U021) and drop zone tests
 * (U027-U030).
 *
 * Runs `runOp` from the in-page kernel against a jsdom document. jsdom lacks
 * a working `DataTransfer` and an assignable file-input `.files`, so minimal
 * polyfills are installed before the suite.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOp } from '../src/inpage/kernel'
import type { Op, Target } from '../src/lib/ops'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_URL = `data:image/png;base64,${PNG_B64}`
const TXT_URL = 'data:text/plain;base64,aGVsbG8='

function cssTarget(selector: string): Target {
  return { primary: { how: 'css', value: selector }, fallbacks: [] }
}

function uploadOp(selector: string, extra: Partial<Op> = {}): Op {
  const { files: extraFiles, ...rest } = extra
  return {
    action: 'upload_files',
    target: cssTarget(selector),
    files: [
      { name: 'pic.png', mimeType: 'image/png', dataUrl: PNG_URL },
      ...(extraFiles ?? []),
    ],
    ...rest,
  }
}

// --- Polyfills ---------------------------------------------------------------

/** Minimal DataTransfer holding a FileList-like array. */
class FakeDataTransfer {
  fileList: File[] = []

  get items(): DataTransferItemList {
    const add = (file: File): void => {
      this.fileList.push(file)
    }
    return { add } as unknown as DataTransferItemList
  }

  get files(): FileList {
    return this.fileList as unknown as FileList
  }
}

/** jsdom has no DragEvent; a CustomEvent carrying dataTransfer suffices. */
class FakeDragEvent extends Event {
  dataTransfer: unknown

  constructor(type: string, init: { dataTransfer?: unknown; bubbles?: boolean; cancelable?: boolean }) {
    super(type, init)
    this.dataTransfer = init.dataTransfer
  }
}

beforeEach(() => {
  vi.stubGlobal('DataTransfer', FakeDataTransfer)
  vi.stubGlobal('DragEvent', FakeDragEvent)
  // jsdom's files setter requires a native FileList (which user code cannot
  // construct); make inputs accept the File array from the fake DataTransfer.
  const proto = window.HTMLInputElement.prototype
  if (!(proto as { __fakeFiles?: boolean }).__fakeFiles) {
    Object.defineProperty(proto, '__fakeFiles', { value: true })
    Object.defineProperty(proto, 'files', {
      configurable: true,
      get(this: HTMLInputElement) {
        return (this as { __files?: File[] }).__files ?? []
      },
      set(this: HTMLInputElement, value: unknown) {
        ;(this as { __files?: File[] }).__files = Array.isArray(value) ? value : []
      },
    })
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('upload_files: input injection', () => {
  it('U012: injects a single file', () => {
    document.body.innerHTML = '<input id="f" type="file" />'
    const result = runOp(uploadOp('#f'))
    expect(result.ok).toBe(true)
    expect(result.found).toBe(true)
    const data = result.data as { count: number; files: { name: string }[] }
    expect(data.count).toBe(1)
    expect(data.files[0]!.name).toBe('pic.png')
  })

  it('U013: injects multiple files into a multiple input', () => {
    document.body.innerHTML = '<input id="f" type="file" multiple />'
    const op = uploadOp('#f', {
      files: [{ name: 'note.txt', mimeType: 'text/plain', dataUrl: TXT_URL }],
    })
    const result = runOp(op)
    expect(result.ok).toBe(true)
    expect((result.data as { count: number }).count).toBe(2)
  })

  it('U014: rejects multiple files when multiple=false', () => {
    document.body.innerHTML = '<input id="f" type="file" />'
    const op = uploadOp('#f', {
      files: [{ name: 'note.txt', mimeType: 'text/plain', dataUrl: TXT_URL }],
    })
    const result = runOp(op)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/multiple/i)
  })

  it('U015/U016/U017: filename, mime and size are reported', () => {
    document.body.innerHTML = '<input id="f" type="file" />'
    const result = runOp(uploadOp('#f'))
    const f = (result.data as { files: { name: string; type: string; size: number }[] })
      .files[0]!
    expect(f.name).toBe('pic.png')
    expect(f.type).toBe('image/png')
    expect(f.size).toBeGreaterThan(0)
  })

  it('U018/U019: input and change events fire', () => {
    document.body.innerHTML = '<input id="f" type="file" />'
    const input = document.querySelector('#f') as HTMLInputElement
    const onInput = vi.fn()
    const onChange = vi.fn()
    input.addEventListener('input', onInput)
    input.addEventListener('change', onChange)
    runOp(uploadOp('#f'))
    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('U020: missing target reports not found', () => {
    document.body.innerHTML = '<input id="f" type="file" />'
    const result = runOp(uploadOp('#nope'))
    expect(result.ok).toBe(false)
    expect(result.found).toBe(false)
  })

  it('U021: non-file input is refused', () => {
    document.body.innerHTML = '<input id="f" type="text" />'
    // Target resolves to an input but not type=file → drop path auto-fallback;
    // with fileTarget 'input' it must explicitly fail.
    const result = runOp(uploadOp('#f', { fileTarget: 'input' }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/file/i)
  })

  it('fails on undecodable payload', () => {
    document.body.innerHTML = '<input id="f" type="file" />'
    const op = uploadOp('#f')
    op.files = [{ name: 'bad', mimeType: 'image/png', dataUrl: 'data:image/png;base64,@@@' }]
    const result = runOp(op)
    expect(result.ok).toBe(false)
  })
})

describe('drop_files / drop zone', () => {
  it('U027/U028/U029: dragenter, dragover and drop fire with files', () => {
    document.body.innerHTML = '<div id="zone">drop here</div>'
    const zone = document.querySelector('#zone') as HTMLElement
    const kinds: string[] = []
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.addEventListener(type, () => kinds.push(type))
    }
    const result = runOp(uploadOp('#zone', { action: 'drop_files' }))
    expect(result.ok).toBe(true)
    expect(kinds).toEqual(['dragenter', 'dragover', 'drop'])
  })

  it('upload_files auto-drops on a non-input target', () => {
    document.body.innerHTML = '<div id="zone" />'
    const drop = vi.fn()
    document.querySelector('#zone')?.addEventListener('drop', drop)
    const result = runOp(uploadOp('#zone'))
    expect(result.ok).toBe(true)
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('U030: prefers a file input inside the drop zone', () => {
    document.body.innerHTML =
      '<div id="zone"><input type="file" class="hidden" /></div>'
    const result = runOp(uploadOp('#zone'))
    expect(result.ok).toBe(true)
    expect(result.note).toMatch(/associated input/i)
  })

  it('XHS: finds the file input that is a SIBLING of the visible trigger (rc-upload)', () => {
    document.body.innerHTML = `
      <span class="rc-upload">
        <div id="trigger" class="ant-upload-drag"><div class="hint">Upload</div></div>
        <input type="file" accept="image/*" class="rc-upload-input" />
      </span>`
    let reactSaw: FileList | null = null
    const fileInput = document.querySelector<HTMLInputElement>('input[type=file]')!
    fileInput.addEventListener('change', () => {
      reactSaw = fileInput.files
    })
    const result = runOp(uploadOp('#trigger'))
    expect(result.ok).toBe(true)
    expect(result.note).toMatch(/associated input/i)
    // The real onChange the React uploader binds to the input actually fires.
    const seen = reactSaw as FileList | null
    expect(seen).not.toBeNull()
    expect(seen?.[0]?.name).toBe('pic.png')
  })

  it('XHS: falls back document-wide when the input is rendered elsewhere (portal)', () => {
    document.body.innerHTML = `
      <div id="trigger" class="upload-area">Upload</div>
      <div id="portal"><input type="file" accept="image/*" /></div>`
    const result = runOp(uploadOp('#trigger'))
    expect(result.ok).toBe(true)
    expect(result.note).toMatch(/associated input/i)
  })
})

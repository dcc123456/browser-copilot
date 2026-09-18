/**
 * 失败必须「响」——读取读不到、导出没内容、保存没值，都不能静默成功。
 *
 * 报的那个症状是「生成的工作流基本不可用，爬一个微博热搜连数据都下载不了，
 * 获取不到页面数据」，而当时**看不到任何错误**：整轮运行报成功、产物是空的。
 * 根因有两条，都在这里钉住：
 *
 *  1. 大量执行器把失败写成 `ctx.emit('error', …)` 然后 `return null`。
 *     `emit` 只是往运行日志写一行；引擎判定的失败路径只有「执行器抛异常」
 *     一条（`engine.ts` 的 `catch (e) → !succeeded`）。所以：
 *       - 重放时用户看到「运行成功」，产物却是空的；
 *       - 生成时更糟——算子桥接按 `status` 判断，`emit` 过的节点仍是
 *         `'executed'`，**坏节点照样被记进草稿**，模型以为这一步成功了。
 *  2. 读取读到空（选择器不匹配 / 页面还没渲染 / 读错标签页）时写入
 *     `''` / `[]` 并报 `result ''`，导出成空文件。
 *
 * 所以本文件断言的是**抛错**（`rejects`），不是 `emit('error')`。
 * 用 `emit` 断言会放过回归：把 `throw` 改回 `emit` 仍然通过，而 bug 回来了。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writtenFiles } = vi.hoisted(() => ({ writtenFiles: new Map<string, string>() }))

vi.mock('../src/lib/download-dir', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/download-dir')>()
  return {
    ...actual,
    getDownloadDir: vi.fn(async () => ({
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (text: string) => void writtenFiles.set(name, text),
          close: async () => {},
        }),
      }),
    })),
  }
})

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import { executeOperatorNode } from '../src/background/workflow-engine/operator-exec'

// --- chrome stub ------------------------------------------------------------

const TARGET_TAB = 7

interface ChromeStub {
  targets: { tabId: number }[]
}

let stub: ChromeStub

/**
 * `query` deliberately reports a DIFFERENT active tab (99) than the run's
 * target (7), so a read that ignores `ctx.tabId` cannot pass by accident.
 */
function installChrome(readResults: unknown[]): ChromeStub {
  stub = { targets: [] }
  let call = 0
  const chromeMock = {
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://example.com/' })),
      query: vi.fn(async () => [{ id: 99, url: 'https://example.com/', active: true }]),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 5 })),
    },
    scripting: {
      executeScript: vi.fn(async (details: { target: { tabId: number } }) => {
        stub.targets.push(details.target)
        const result = readResults[call] ?? []
        call += 1
        return [{ result }]
      }),
    },
  }
  ;(globalThis as { chrome: unknown }).chrome = chromeMock
  return stub
}

function makeCtx(variables: Record<string, unknown> = {}): WorkflowExecCtx {
  return {
    variables,
    refData: undefined,
    signal: new AbortController().signal,
    tabId: TARGET_TAB,
    emit: () => {},
  }
}

/**
 * Run a step that MUST fail and hand back its error.
 *
 * `rejects.toThrow` cannot be used where the message itself is the assertion
 * subject, and `.catch(e => e as Error)` leaves `string | null` in the union —
 * so this also pins that the step failed at all (a step that resolves throws
 * here instead of silently passing a later `toContain`).
 */
async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected this step to fail, but it resolved successfully')
}

beforeEach(() => {
  vi.clearAllMocks()
  writtenFiles.clear()
})

// --- reads ------------------------------------------------------------------

describe('a read that produced nothing fails the step', () => {
  it('get-text: an unmatched selector names the selector', async () => {
    installChrome([[]])
    const ctx = makeCtx()

    await expect(
      EXECUTORS['get-text']!({ selector: '#pl_toplist td.td-02 a' }, ctx),
    ).rejects.toThrow(/#pl_toplist/)

    // Nothing reached the variable bag, so no downstream step can export a
    // blank cell and call it a result.
    expect(ctx.variables['lastText']).toBeUndefined()
  })

  it('get-text: an empty match list is a failure even with multiple:true', async () => {
    installChrome([[]])
    const ctx = makeCtx()

    await expect(
      EXECUTORS['get-text']!(
        { selector: '.row', multiple: true, saveData: true, dataColumn: '标题' },
        ctx,
      ),
    ).rejects.toThrow(/没有读到任何内容/)

    expect(ctx.variables['dataTable']).toBeUndefined()
  })

  it('get-text: whitespace-only matches do not count as content', async () => {
    installChrome([['   ', '\n']])
    const ctx = makeCtx()

    await expect(EXECUTORS['get-text']!({ selector: '.row' }, ctx)).rejects.toThrow(
      /没有读到任何内容/,
    )
  })

  it('get-text: a node with only a rich target says the reader needs a selector', async () => {
    installChrome([['x']])
    const ctx = makeCtx()

    // `targetFrom` can act on role/text specs, but this reader runs
    // `querySelectorAll` — silently reading nothing was the bug.
    await expect(
      EXECUTORS['get-text']!({ target: { primary: { how: 'role', value: 'link' } } }, ctx),
    ).rejects.toThrow(/CSS 选择器/)
  })

  it('get-text: no selector at all is refused before touching the page', async () => {
    const s = installChrome([['x']])
    const ctx = makeCtx()

    await expect(EXECUTORS['get-text']!({}, ctx)).rejects.toThrow(/缺少 selector/)
    expect(s.targets).toHaveLength(0)
  })

  it('get-text: a good read still succeeds and fills the table', async () => {
    installChrome([['热搜一', '热搜二']])
    const ctx = makeCtx()

    await EXECUTORS['get-text']!(
      { selector: '.row', multiple: true, saveData: true, dataColumn: '标题' },
      ctx,
    )

    expect(ctx.variables['dataTable']).toEqual([{ 标题: '热搜一' }, { 标题: '热搜二' }])
  })

  it('the failure explains what to check, not just that it failed', async () => {
    installChrome([[]])
    const ctx = makeCtx()

    const error = await failureOf(EXECUTORS['get-text']!({ selector: '.row' }, ctx))

    // A bare "no match" leaves the user where they started; the message has to
    // name the causes and the declarative alternative.
    expect(error.message).toContain('选择器')
    expect(error.message).toContain('element-exists')
  })

  it('read-page: an empty page-text read fails instead of publishing ""', async () => {
    // `readActivePage` scrapes `raw` and collapses it; whitespace-only means the
    // page had no readable text.
    installChrome([{ url: 'https://example.com/', title: 't', selection: '', raw: '   \n ' }])
    const ctx = makeCtx()

    await expect(EXECUTORS['read-page']!({}, ctx)).rejects.toThrow(/没有读到任何内容/)
    expect(ctx.variables['lastReadPage']).toBeUndefined()
  })
})

// --- export -----------------------------------------------------------------

describe('an export with nothing to export fails the step', () => {
  it('export-data: an empty data table is refused instead of writing a blank file', async () => {
    installChrome([])
    const ctx = makeCtx()

    await expect(EXECUTORS['export-data']!({ name: 'x.csv', type: 'csv' }, ctx)).rejects.toThrow(
      /saveData/,
    )
    expect(writtenFiles.size).toBe(0)
  })

  it('export-data: the message names the whole collection recipe', async () => {
    installChrome([])
    const ctx = makeCtx()

    const error = await failureOf(EXECUTORS['export-data']!({ name: 'x.csv', type: 'csv' }, ctx))

    expect(error.message).toContain('dataColumn')
    expect(error.message).toContain('save-local')
  })

  it('export-data: a non-empty table still writes', async () => {
    installChrome([])
    const ctx = makeCtx({ dataTable: [{ 标题: 'a' }] })

    await EXECUTORS['export-data']!({ name: 'x.csv', type: 'csv' }, ctx)

    expect(ctx.variables['lastExportPath']).toBe('x.csv')
    expect(ctx.variables['lastExport']).toBe('标题\na')
    expect(writtenFiles.get('x.csv')).toBe('标题\na')
  })
})

// --- the source-level guard -------------------------------------------------

/**
 * The bug pattern, as a rule: a statement-position `ctx.emit('error', …)`
 * immediately followed by `return null` is a node that reported a problem and
 * then pretended it succeeded.
 *
 * Enumerating the blocks one by one is how this class survived: each was fixed
 * in isolation and the next one was found by a user report. This scans the
 * source instead, so a NEW executor written in the old style fails here rather
 * than in production.
 */
describe('no executor swallows a failure into a log line', () => {
  /** Forms that legitimately log an error and carry on. Keep this tiny. */
  const ALLOWED = [
    // Incremental scrolling stops at the first failed step on purpose: a partial
    // scroll still moved the page and the next node re-locates its own element.
    '增量滚动提前中止',
  ]

  it('has no error log that falls straight through to a bare return null', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/background/workflow-engine/executors.ts', import.meta.url)),
      'utf8',
    )
    const lines = source.split('\n')
    const offenders: string[] = []

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      const single = /^(\s*)ctx\.emit\('error'(.*)\)\s*$/.exec(line)
      const open = /^(\s*)ctx\.emit\(\s*$/.exec(line)
      if (!single && !open) continue

      let indent: string
      let body: string
      let after: number
      if (single) {
        indent = single[1]!
        body = single[2]!
        after = i + 1
      } else {
        indent = open![1]!
        // Skip to the line that closes the call.
        let j = i + 1
        const collected: string[] = []
        while (j < lines.length && lines[j] !== indent + ')') {
          collected.push(lines[j]!.trim())
          j += 1
        }
        body = collected.join(' ')
        // The multi-line form still has to START with 'error' — a `ctx.emit(`
        // opening a `'result'` call is not this pattern.
        if (!body.startsWith("'error'")) continue
        after = j + 1
      }

      // `if (cond) ctx.emit(...)` is a degrade; only statement position counts.
      if (!/^\s*ctx\.emit\(/.test(line)) continue
      if (lines[after] !== indent + 'return null') continue
      if (ALLOWED.some((allowed) => body.includes(allowed))) continue
      offenders.push(`${i + 1}: ${line.trim()}`)
    }

    expect(offenders).toEqual([])
  })
})

// --- the bridge -------------------------------------------------------------

describe('the operator bridge records nothing when a step fails', () => {
  it('a failing executor comes back as ok:false, so the draft stays clean', async () => {
    installChrome([[]])

    const outcome = await executeOperatorNode(
      'get-text',
      { selector: '.row' },
      {
        variables: {},
        signal: new AbortController().signal,
        tabId: TARGET_TAB,
        setTab: () => {},
      },
    )

    // This is the whole point: `emit('error')` used to leave this as
    // `status:'executed'`, so the model recorded a node that reads nothing and
    // believed it had worked.
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('没有读到任何内容')
  })

  it('a failing read-page comes back as ok:false too', async () => {
    installChrome([[]])

    const outcome = await executeOperatorNode(
      'read-page',
      { selector: '.row' },
      {
        variables: {},
        signal: new AbortController().signal,
        tabId: TARGET_TAB,
        setTab: () => {},
      },
    )

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('没有读到任何内容')
  })

  it('export-data stays record-only during generation, so nothing is written early', async () => {
    // Deliberate and separate from the above: writing files while GENERATING a
    // workflow would litter the user's disk with every trial run, so the bridge
    // records the node and lets the replay do the export. Its empty-table
    // refusal therefore lives in the executor, exercised at replay.
    installChrome([])

    const outcome = await executeOperatorNode(
      'export-data',
      { name: 'x.csv', type: 'csv' },
      {
        variables: {},
        signal: new AbortController().signal,
        tabId: TARGET_TAB,
        setTab: () => {},
      },
    )

    expect(outcome.status).toBe('record-only')
    expect(writtenFiles.size).toBe(0)
  })
})

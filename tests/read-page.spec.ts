/**
 * `read-page` and the data-table collection contract.
 *
 * Two things are pinned here, and they are the same story from two ends:
 *
 *  1. `read-page` — the recordable form of the chat agent's `read_current_page`
 *     tool. Before it existed, a task that needed the page's text inside the
 *     workflow had no step to record: `get-text` reads one element, and the
 *     model had no way to say "this whole page". The tool recorded nothing, so
 *     the read never made it into the graph.
 *
 *  2. `saveData` / `dataColumn` / `multiple`. These three were declared in the
 *     catalog, given editor UI, and documented in the operator guide's
 *     collection recipe — and read by no executor at all. `dataTable` (the only
 *     thing `export-data` writes) could only be filled by `insert-data` with a
 *     literal JSON payload, which is exactly the dead data the dynamic-data
 *     gate refuses. Net effect: every "collect then export" workflow produced
 *     an empty file, successfully.
 *
 * The row-addressing rules get their own tests because they are the part a
 * future change is most likely to break silently: getting them wrong still
 * writes a file, just the wrong one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import { BLOCK_BY_ID, PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'
import { dataSchemaFromEntry, operatorToolFromEntry } from '../src/lib/workflow/operator-tools'
import { operatorExecClass } from '../src/lib/workflow/operator-class'
import { dataParamSpecs } from '../src/lib/workflow/data-params'

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, execOnActiveTab: vi.fn() }
})

/** Result shape `scrapeInPage` returns for the whole-page text read. */
const pageScrape = {
  url: 'https://example.com/',
  title: 'Example',
  selection: 'picked text',
  raw: '  Hello   world  ',
}

function makeChromeMock() {
  const tab = { id: 1, windowId: 1, url: 'https://example.com/', active: true }
  // One stub for every injected reader: the executor under test decides which
  // shape it expects, so each test overrides this when it matters. The explicit
  // signature keeps `mock.calls[0]` typed as a one-element tuple — the default
  // `vi.fn(async () => …)` records calls as `[]` and every argument access then
  // fails to compile.
  const executeScript = vi.fn<
    (details: { target: { tabId: number }; args?: unknown[] }) => Promise<unknown[]>
  >(async () => [{ result: ['hello text'] as unknown }])
  return {
    chrome: {
      tabs: {
        query: vi.fn(async () => [tab]),
        get: vi.fn(async () => tab),
        update: vi.fn(async () => tab),
        create: vi.fn(async () => tab),
        reload: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      scripting: { executeScript },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    executeScript,
    tab,
  }
}

function makeCtx(variables: Record<string, unknown> = {}) {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables,
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

let chromeRefs: ReturnType<typeof makeChromeMock>

beforeEach(() => {
  chromeRefs = makeChromeMock()
  vi.stubGlobal('chrome', chromeRefs.chrome)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const kindsOf = (emit: ReturnType<typeof makeCtx>['emit'], kind: string) =>
  emit.mock.calls.filter(([k]) => k === kind).map(([, text]) => text)

const table = (ctx: WorkflowExecCtx) => ctx.variables['dataTable'] as Record<string, unknown>[]

// --- the block itself --------------------------------------------------------

describe('read-page block definition', () => {
  const entry = BLOCK_BY_ID.get('read-page')

  it('is a real palette block', () => {
    expect(entry).toBeDefined()
    expect(PALETTE_BLOCKS.some((b) => b.id === 'read-page')).toBe(true)
    expect(entry!.category).toBe('browser')
  })

  // The `editComponent` → form pairing is asserted for the whole palette in
  // edit-forms-registry.spec.ts. It is not repeated here: resolving the name
  // means importing every React form, which is too slow to do inside a test
  // body under full-suite load.

  it('executes rather than merely recording', () => {
    // It reads the live page, so a generation-time call proves something and
    // the node is not just a placeholder.
    expect(operatorExecClass('read-page')).toBe('execute')
  })

  it('declares no data parameters', () => {
    // Every parameter is structural — what to read, how much to keep, where to
    // put it. Nothing here carries a value from outside the workflow, so the
    // dynamic-data gate must never rewrite one into `{{...}}`.
    expect(dataParamSpecs('read-page')).toEqual([])
  })
})

describe('read-page tool schema', () => {
  const schema = dataSchemaFromEntry(BLOCK_BY_ID.get('read-page')!) as {
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
  }

  it('offers the three read modes as an enum', () => {
    expect(schema.properties['source']!.enum).toEqual(['text', 'selection', 'html'])
  })

  it('exposes the collection params with explanations', () => {
    // Exposed here but stripped from the ~14 other blocks that declare them,
    // because only this executor and get-text's actually honour them.
    expect(schema.properties['saveData']!.description).toContain('data table')
    expect(schema.properties['dataColumn']!.description).toContain('loop index')
  })

  it('does not graft element-locator params onto a scoping selector', () => {
    // `refDataKeys` drives `takesElementTarget`; listing `selector` there gave
    // this block `ref` / `target` / `label` it cannot use, and overwrote the
    // `selector` description with the "target an element" one.
    expect(schema.properties['selector']!.description).toContain('scope the read')
    expect(schema.properties['ref']).toBeUndefined()
    expect(schema.properties['target']).toBeUndefined()
  })

  it('reaches the model as a tool', () => {
    const tool = operatorToolFromEntry(BLOCK_BY_ID.get('read-page')!)
    expect(tool.function.name).toBe('wf_op_read-page')
  })
})

// --- the executor -----------------------------------------------------------

describe('read-page executor', () => {
  it('reads the whole page’s text by default and writes lastReadPage', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: pageScrape }])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({}, ctx)

    // Whitespace is collapsed by readActivePage, not by the injected scraper.
    expect(ctx.variables['lastReadPage']).toBe('Hello world')
  })

  it('writes the declared variable name and keeps lastReadPage in step', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: pageScrape }])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({ variableName: 'article' }, ctx)

    expect(ctx.variables['article']).toBe('Hello world')
    expect(ctx.variables['lastReadPage']).toBe('Hello world')
  })

  it('reads the user’s selection', async () => {
    chromeRefs.executeScript.mockResolvedValue([
      { result: { url: pageScrape.url, title: pageScrape.title, selection: 'picked text' } },
    ])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({ source: 'selection' }, ctx)

    expect(ctx.variables['lastReadPage']).toBe('picked text')
  })

  it('reads HTML without collapsing its whitespace', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: '<html>\n  <body>x</body>\n</html>' }])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({ source: 'html' }, ctx)

    expect(ctx.variables['lastReadPage']).toBe('<html>\n  <body>x</body>\n</html>')
  })

  it('caps the returned characters', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: 'x'.repeat(500) }])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({ source: 'html', maxChars: 100 }, ctx)

    expect(String(ctx.variables['lastReadPage']).length).toBeLessThanOrEqual(101)
  })

  it('scopes a text read to one element instead of the whole page', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: ['scoped'] }])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({ selector: '.article' }, ctx)

    const [details] = chromeRefs.executeScript.mock.calls[0]!
    expect(details.args).toEqual(['.article', false, false, false])
    expect(ctx.variables['lastReadPage']).toBe('scoped')
  })

  it('fails an unreadable page instead of recording a read that would return nothing', async () => {
    chromeRefs.chrome.tabs.query.mockResolvedValue([
      { id: 1, windowId: 1, url: 'chrome://extensions/', active: true },
    ])
    const { ctx } = makeCtx()

    // Thrown, not logged: `emit('error')` alone let the run report success and
    // let the operator bridge record a node that reads nothing at replay.
    await expect(EXECUTORS['read-page']!({}, ctx)).rejects.toThrow(/off limits/)

    expect(ctx.variables['lastReadPage']).toBeUndefined()
    expect(chromeRefs.executeScript).not.toHaveBeenCalled()
  })

  it('fails when the selector matches nothing, naming the selector', async () => {
    // The reported symptom: a generated scraper whose selector no longer
    // matches writes an empty export and reports 成功.
    chromeRefs.executeScript.mockResolvedValue([{ result: [] }])
    const { ctx } = makeCtx()

    await expect(EXECUTORS['read-page']!({ selector: '.article' }, ctx)).rejects.toThrow(
      /\.article/,
    )

    expect(ctx.variables['lastReadPage']).toBeUndefined()
  })

  it('keeps an empty selection non-fatal but reports it', async () => {
    // The one read that may legitimately come back empty: no declarative block
    // can test "did the user select anything".
    chromeRefs.executeScript.mockResolvedValue([
      { result: { url: pageScrape.url, title: pageScrape.title, selection: '' } },
    ])
    const { ctx, emit } = makeCtx()

    await EXECUTORS['read-page']!({ source: 'selection' }, ctx)

    expect(kindsOf(emit, 'error').join(' ')).toContain('没有选中任何文本')
    expect(ctx.variables['lastReadPage']).toBe('')
  })
})

// --- collection -------------------------------------------------------------

describe('saveData / dataColumn / multiple', () => {
  it('collects every match into the data table, one row each', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: ['a', 'b', 'c'] }])
    const { ctx } = makeCtx()

    await EXECUTORS['get-text']!(
      { cssSelector: '.row', multiple: true, saveData: true, dataColumn: '内容' },
      ctx,
    )

    expect(table(ctx)).toEqual([{ 内容: 'a' }, { 内容: 'b' }, { 内容: 'c' }])
  })

  it('puts the whole list in the variable when multiple is on', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: ['a', 'b'] }])
    const { ctx } = makeCtx()

    await EXECUTORS['get-text']!({ cssSelector: '.row', multiple: true }, ctx)

    expect(ctx.variables['lastText']).toEqual(['a', 'b'])
  })

  it('adds a SECOND COLUMN to the existing rows rather than new rows', async () => {
    // This is the recipe the operator guide hands the model: read the list
    // once for one column, then read again with a different `dataColumn`.
    // Appending instead of merging would silently produce a six-row table.
    chromeRefs.executeScript.mockResolvedValue([{ result: ['a', 'b'] }])
    const { ctx } = makeCtx()

    await EXECUTORS['get-text']!(
      { cssSelector: '.name', multiple: true, saveData: true, dataColumn: '名称' },
      ctx,
    )
    await EXECUTORS['get-text']!(
      { cssSelector: '.heat', multiple: true, saveData: true, dataColumn: '热度' },
      ctx,
    )

    expect(table(ctx)).toEqual([
      { 名称: 'a', 热度: 'a' },
      { 名称: 'b', 热度: 'b' },
    ])
  })

  it('addresses the row by loopIndex when running inside a loop', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: ['row-value'] }])
    const { ctx } = makeCtx({ loopIndex: 2 })

    await EXECUTORS['get-text']!({ cssSelector: '.cell', saveData: true, dataColumn: '值' }, ctx)

    // Row 2, and rows 0/1 exist as empty objects so the export keeps column
    // order rather than shifting every value up.
    expect(table(ctx)).toHaveLength(3)
    expect(table(ctx)[2]).toEqual({ 值: 'row-value' })
  })

  it('leaves the table untouched when saveData is off', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: ['a'] }])
    const { ctx } = makeCtx()

    await EXECUTORS['get-text']!({ cssSelector: '.row', dataColumn: '内容' }, ctx)

    expect(ctx.variables['dataTable']).toBeUndefined()
  })

  it('says so when saveData is on but no column was named', async () => {
    // The alternative — collecting nothing, silently — is how the export ends
    // up empty with no explanation anywhere.
    chromeRefs.executeScript.mockResolvedValue([{ result: ['a'] }])
    const { ctx, emit } = makeCtx()

    await EXECUTORS['get-text']!({ cssSelector: '.row', saveData: true }, ctx)

    expect(kindsOf(emit, 'info').join(' ')).toContain('dataColumn')
    expect(ctx.variables['dataTable']).toBeUndefined()
  })

  it('lets read-page feed the same table', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: pageScrape }])
    const { ctx } = makeCtx()

    await EXECUTORS['read-page']!({ saveData: true, dataColumn: '正文' }, ctx)

    expect(table(ctx)).toEqual([{ 正文: 'Hello world' }])
  })

  it('caps the row index so a corrupt loopIndex cannot allocate forever', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: ['x'] }])
    const { ctx } = makeCtx({ loopIndex: 1e9 })

    await EXECUTORS['get-text']!({ cssSelector: '.row', saveData: true, dataColumn: 'c' }, ctx)

    expect(table(ctx)).toEqual([])
  })
})

// --- reachability -----------------------------------------------------------

describe('the collection params are reachable from the tool surface', () => {
  it('are stripped from blocks whose executor ignores them', () => {
    // About sixteen catalog entries declare the trio because they share
    // Automa's "InsertWorkflowData" slot. Advertising them on a block that
    // does nothing with them produces a workflow that claims to collect and
    // then exports an empty file — the exact bug this feature fixes.
    const schema = dataSchemaFromEntry(BLOCK_BY_ID.get('event-click')!) as {
      properties: Record<string, unknown>
    }
    expect(schema.properties['saveData']).toBeUndefined()
    expect(schema.properties['multiple']).toBeUndefined()
  })

  it('survive on both collecting blocks', () => {
    for (const id of ['get-text', 'read-page']) {
      const schema = dataSchemaFromEntry(BLOCK_BY_ID.get(id)!) as {
        properties: Record<string, unknown>
      }
      expect(schema.properties['saveData'], id).toBeDefined()
      expect(schema.properties['dataColumn'], id).toBeDefined()
    }
  })
})

/**
 * The variable-arithmetic blocks and `switch-tab` read the keys the catalog and
 * the edit forms actually write.
 *
 * These four all shipped with the executor reading a different key name than
 * the form wrote, so the whole block was silently inert:
 *
 *   - `increase-variable` wrote `increaseBy`, read `value`;
 *   - `slice-variable` wrote `startIndex` / `endIndex`, read `start` / `end`;
 *   - `regex-variable` wrote `expression` / `flag[]`, read `pattern` / `flags`;
 *   - `switch-tab` wrote `tabIndex`, read `index`.
 *
 * `increase-variable` additionally had an operator-precedence bug that threw the
 * current value away even when the right key was supplied. Both failure modes
 * are pinned here, because either one alone leaves the block useless.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

function makeCtx(vars: Record<string, unknown> = {}) {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: vars,
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome
})

describe('increase-variable', () => {
  it('adds increaseBy to the value the variable already holds', async () => {
    const { ctx } = makeCtx({ counter: 5 })
    await EXECUTORS['increase-variable']!({ variableName: 'counter', increaseBy: 1 }, ctx)
    expect(ctx.variables['counter']).toBe(6)
  })

  it('does not collapse the current value to 1 (the precedence bug)', async () => {
    // `Number((vars[name] ?? incType === 'multiply') ? 1 : 0)` parsed as
    // `vars[name] ?? (incType === 'multiply')`, so 5 became 1 and 5 + 10 = 11.
    const { ctx } = makeCtx({ counter: 5 })
    await EXECUTORS['increase-variable']!({ variableName: 'counter', increaseBy: 10 }, ctx)
    expect(ctx.variables['counter']).toBe(15)
  })

  it('still honours the legacy `value` key', async () => {
    const { ctx } = makeCtx({ counter: 5 })
    await EXECUTORS['increase-variable']!({ variableName: 'counter', value: '10' }, ctx)
    expect(ctx.variables['counter']).toBe(15)
  })

  it('starts an unset variable at zero', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['increase-variable']!({ variableName: 'fresh', increaseBy: 3 }, ctx)
    expect(ctx.variables['fresh']).toBe(3)
  })

  it('interpolates the step so it can come from an upstream variable', async () => {
    const { ctx } = makeCtx({ counter: 1, step: 4 })
    await EXECUTORS['increase-variable']!({ variableName: 'counter', increaseBy: '{{step}}' }, ctx)
    expect(ctx.variables['counter']).toBe(5)
  })

  it('errors instead of silently doing nothing without variableName', async () => {
    const { ctx } = makeCtx({ counter: 5 })
    // Thrown, not logged — see the executors module header.
    await expect(EXECUTORS['increase-variable']!({ increaseBy: 1 }, ctx)).rejects.toThrow(
      /variableName/,
    )
    expect(ctx.variables['counter']).toBe(5)
  })
})

describe('slice-variable', () => {
  it('reads startIndex / endIndex with both toggles on', async () => {
    const { ctx } = makeCtx({ s: 'abcdefgh' })
    await EXECUTORS['slice-variable']!(
      {
        variableName: 's',
        startIdxEnabled: true,
        startIndex: 2,
        endIdxEnabled: true,
        endIndex: 5,
      },
      ctx,
    )
    expect(ctx.variables['s']).toBe('cde')
  })

  it('runs to the end when endIdxEnabled is off', async () => {
    const { ctx } = makeCtx({ s: 'abcdefgh' })
    await EXECUTORS['slice-variable']!(
      {
        variableName: 's',
        startIdxEnabled: true,
        startIndex: 3,
        endIdxEnabled: false,
        endIndex: 5,
      },
      ctx,
    )
    expect(ctx.variables['s']).toBe('defgh')
  })

  it('slices arrays too', async () => {
    const { ctx } = makeCtx({ list: [1, 2, 3, 4] })
    await EXECUTORS['slice-variable']!(
      {
        variableName: 'list',
        startIdxEnabled: true,
        startIndex: 1,
        endIdxEnabled: true,
        endIndex: 3,
      },
      ctx,
    )
    expect(ctx.variables['list']).toEqual([2, 3])
  })

  it('still honours the legacy start / end keys', async () => {
    const { ctx } = makeCtx({ s: 'abcdefgh' })
    await EXECUTORS['slice-variable']!({ variableName: 's', start: 1, end: 4 }, ctx)
    expect(ctx.variables['s']).toBe('bcd')
  })

  it('errors on a missing variable instead of writing undefined', async () => {
    const { ctx } = makeCtx()
    await expect(
      EXECUTORS['slice-variable']!({ variableName: 'nope', startIndex: 1 }, ctx),
    ).rejects.toThrow(/nope/)
    expect(ctx.variables['nope']).toBeUndefined()
  })
})

describe('regex-variable', () => {
  it('matches every hit when the g flag is checked', async () => {
    const { ctx } = makeCtx({ s: 'a1b2c3' })
    await EXECUTORS['regex-variable']!(
      { variableName: 's', method: 'match', expression: '\\d', flag: ['g'] },
      ctx,
    )
    expect(ctx.variables['s']).toBe('["1","2","3"]')
  })

  it('returns a single hit without the g flag', async () => {
    const { ctx } = makeCtx({ s: 'a1b2c3' })
    await EXECUTORS['regex-variable']!(
      { variableName: 's', method: 'match', expression: '\\d', flag: [] },
      ctx,
    )
    expect(ctx.variables['s']).toBe('["1"]')
  })

  it('replaces using replaceVal', async () => {
    const { ctx } = makeCtx({ s: 'a1b2c3' })
    await EXECUTORS['regex-variable']!(
      {
        variableName: 's',
        method: 'replace',
        expression: '\\d',
        flag: ['g'],
        replaceVal: '#',
      },
      ctx,
    )
    expect(ctx.variables['s']).toBe('a#b#c#')
  })

  it('accepts a string flag list as well as the checkbox array', async () => {
    const { ctx } = makeCtx({ s: 'A1b2' })
    await EXECUTORS['regex-variable']!(
      { variableName: 's', method: 'match', expression: '[a-z]', flag: 'g' },
      ctx,
    )
    expect(ctx.variables['s']).toBe('["b"]')
  })

  it('errors on an empty expression rather than matching everything', async () => {
    const { ctx } = makeCtx({ s: 'abc' })
    await expect(
      EXECUTORS['regex-variable']!({ variableName: 's', expression: '' }, ctx),
    ).rejects.toThrow(/正则表达式为空/)
    expect(ctx.variables['s']).toBe('abc')
  })

  it('fails on a bad expression instead of leaving the variable stale', async () => {
    const { ctx } = makeCtx({ s: 'abc' })
    await expect(
      EXECUTORS['regex-variable']!({ variableName: 's', expression: '([', flag: [] }, ctx),
    ).rejects.toThrow(/正则表达式无效/)
    // The variable keeps its previous value, so a downstream step would have
    // read stale data had this been swallowed into a log line.
    expect(ctx.variables['s']).toBe('abc')
  })
})

/** `chrome.tabs` double: three tabs in one window, the first one active. */
function installTabs() {
  const tabs = [
    { id: 11, url: 'https://a.test/', title: 'Alpha' },
    { id: 22, url: 'https://b.test/x', title: 'Beta page' },
    { id: 33, url: 'https://c.test/', title: 'Gamma' },
  ]
  const updated: number[] = []
  const created: string[] = []
  ;(globalThis as Record<string, unknown>).chrome = {
    tabs: {
      query: vi.fn(async () => tabs.map((tab) => ({ ...tab, active: tab.id === 11 }))),
      update: vi.fn(async (id: number) => {
        updated.push(id)
      }),
      create: vi.fn(async (opts: { url?: string }) => {
        created.push(opts.url ?? '')
        return { id: 99 }
      }),
    },
    windows: { update: vi.fn(async () => {}) },
  }
  return { updated, created }
}

describe('switch-tab', () => {
  it('switches to the tab at tabIndex — it used to always land on tab 0', async () => {
    const { updated } = installTabs()
    const { ctx } = makeCtx()
    await EXECUTORS['switch-tab']!({ findTabBy: 'tab-index', tabIndex: 2 }, ctx)
    expect(updated).toEqual([33])
  })

  it('finds a tab by match pattern', async () => {
    const { updated } = installTabs()
    const { ctx } = makeCtx()
    await EXECUTORS['switch-tab']!(
      { findTabBy: 'match-patterns', matchPattern: 'https://b.test/*' },
      ctx,
    )
    expect(updated).toEqual([22])
  })

  it('finds a tab by title', async () => {
    const { updated } = installTabs()
    const { ctx } = makeCtx()
    await EXECUTORS['switch-tab']!({ findTabBy: 'tab-title', tabTitle: 'Gamma' }, ctx)
    expect(updated).toEqual([33])
  })

  it('steps to the next and previous tab relative to the active one', async () => {
    const { updated } = installTabs()
    const { ctx } = makeCtx()
    await EXECUTORS['switch-tab']!({ findTabBy: 'next-tab' }, ctx)
    expect(updated).toEqual([22])
    const { ctx: ctx2 } = makeCtx()
    await EXECUTORS['switch-tab']!({ findTabBy: 'prev-tab' }, ctx2)
    expect(updated).toEqual([22, 33])
  })

  it('opens createIfNoMatch url when nothing matches', async () => {
    const { created } = installTabs()
    const { ctx, emit } = makeCtx()
    await EXECUTORS['switch-tab']!(
      {
        findTabBy: 'match-patterns',
        matchPattern: 'https://nope.test/*',
        createIfNoMatch: true,
        url: 'https://nope.test/',
      },
      ctx,
    )
    expect(created).toEqual(['https://nope.test/'])
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('已新建'))
  })

  it('reports an out-of-range index instead of silently switching to tab 0', async () => {
    const { updated } = installTabs()
    const { ctx } = makeCtx()
    await expect(
      EXECUTORS['switch-tab']!({ findTabBy: 'tab-index', tabIndex: 9 }, ctx),
    ).rejects.toThrow(/超出范围/)
    expect(updated).toEqual([])
  })

  it('does not steal focus when activeTab is unchecked', async () => {
    const { updated } = installTabs()
    const { ctx } = makeCtx()
    await EXECUTORS['switch-tab']!({ findTabBy: 'tab-index', tabIndex: 1, activeTab: false }, ctx)
    expect(updated).toEqual([])
  })
})

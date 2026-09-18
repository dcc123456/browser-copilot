/**
 * The "unproduced content" gate.
 *
 * Regression this file exists for: a user asked for "查前20条热搜并下载到本地" and
 * got a three-node workflow — trigger → new-tab → save-local — whose
 * `save-local.value` was the 20-row CSV the model had read off the page with
 * its OWN tools. Nothing in the graph produced that CSV. The dead-data rewriter
 * then declared it a workflow input (frozen snapshot as `defaultValue`), which
 * made a broken graph look legitimate and removed every error signal.
 *
 * The gate refuses that shape before the page is touched, so the model has to
 * record the step that reads the content. These tests pin both halves: the
 * shape is refused, and every legitimate way of supplying the same value is
 * NOT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async () => {},
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
})

import {
  actionNodesOf,
  getDraftSnapshot,
  runOperatorTool,
} from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import {
  MAX_BULK_LITERAL_CHARS,
  looksLikeBulkContent,
  unproducedBulkData,
  unproducedDataRefusal,
} from '../src/lib/workflow/dynamic-data'
import { buildVariableIndex } from '../src/lib/workflow/dynamic-data'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'

const signal = new AbortController().signal

/** The exact shape that produced the bug report: a 20-row scrape, pasted in. */
const HOT_SEARCH_CSV = [
  '排名,热搜话题,热度',
  ...[
    '原来百家讲坛是真的在教东西',
    'UFO高速飞过墨西哥城上空',
    '每个中国人都不能忘记九一八',
    '上1休1上5休3',
    '南医大学生坠亡事件造谣账号被处置',
    'iPhone18换一万斤粮食',
    '月薪4万就是每天都有1333',
    '918',
    '妈妈嘱咐双胞胎一个别惹事一个别怂',
    '兰香如故三小姐不是真心想救老二',
    '我们来了 刘雯',
    '日本加息',
    '小猫寄养五天以为主人不要它了',
    '张本智和说日本夺冠概率比中国高',
    '坠亡幼童父亲称出殡按最高规格',
    '维嘉的脸是开源了吗',
    '918鸣笛',
    '机顶盒即将退场',
    '九一八事变',
    '日本斥资44亿日元篡改历史',
  ].map((topic, i) => `${i + 1},${topic},${1000000 - i * 40000}`),
].join('\n')

/** Stub executors that record what they were handed, so "did it run" is observable. */
function okExecutors(overrides: Record<string, BlockExecutor> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const executors: Record<string, BlockExecutor> = {}
  const record =
    (blockId: string): BlockExecutor =>
    async (data) => {
      calls.push({ blockId, data })
      return null
    }
  for (const id of [
    'save-local',
    'set-variable',
    'get-text',
    'new-tab',
    'export-data',
    'ai-agent',
  ]) {
    executors[id] = record(id)
  }
  return { calls, executors: { ...executors, ...overrides } }
}

function run(
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  executors: Record<string, BlockExecutor>,
) {
  return runOperatorToolWithExecution({ name, args, conversationId, signal, executors })
}

describe('looksLikeBulkContent', () => {
  it('accepts ordinary knobs: keywords, filenames, URLs, messages', () => {
    for (const value of [
      'iPhone 18',
      '微博热搜Top20.csv',
      'https://s.weibo.com/top/summary',
      '报告已生成，请查收',
      '{"channel":"#alerts","text":"deploy done"}',
    ]) {
      expect(looksLikeBulkContent(value), value).toBe(false)
    }
  })

  it('accepts a multi-line config body — a JSON template is a constant, not content', () => {
    const body = ['{', '  "text": "热搜已更新：{{hotList}}",', '  "channel": "#alerts",', '}'].join(
      '\n',
    )
    expect(looksLikeBulkContent(body)).toBe(false)
  })

  it('flags the reported shape: a pasted multi-row scrape', () => {
    expect(looksLikeBulkContent(HOT_SEARCH_CSV)).toBe(true)
  })

  it('flags a long single-line dump even without newlines', () => {
    const oneLine = Array.from({ length: 120 }, (_, i) => `热搜话题${i}`).join(',')
    expect(oneLine.length).toBeGreaterThan(MAX_BULK_LITERAL_CHARS)
    expect(looksLikeBulkContent(oneLine)).toBe(true)
  })

  it('does not flag a long-but-single-line value right at the threshold', () => {
    expect(looksLikeBulkContent('x'.repeat(MAX_BULK_LITERAL_CHARS))).toBe(false)
    expect(looksLikeBulkContent('x'.repeat(MAX_BULK_LITERAL_CHARS + 1))).toBe(true)
  })

  it('needs both enough lines and enough length to call a value tabular', () => {
    // Many lines but tiny — a snippet, not a table.
    expect(looksLikeBulkContent('a\nb\nc\nd\ne\nf\ng\nh\ni')).toBe(false)
    // Long enough but only a couple of lines — a wrapped message.
    expect(looksLikeBulkContent(`${'x'.repeat(150)}\n${'y'.repeat(150)}`)).toBe(false)
  })
})

describe('unproducedBulkData', () => {
  const noVariables = new Map<string, string>()

  it('flags content pasted into a sink with nothing producing it', () => {
    const site = unproducedBulkData(
      'save-local',
      { filename: '微博热搜Top20.csv', value: HOT_SEARCH_CSV },
      noVariables,
    )
    expect(site?.path).toEqual(['value'])
  })

  it('flags it in a data-table sink too — the gate is not per-block', () => {
    const site = unproducedBulkData(
      'insert-data',
      { dataList: [{ name: HOT_SEARCH_CSV }] },
      noVariables,
    )
    expect(site?.path).toEqual(['dataList', 0, 'name'])
  })

  it('cannot be laundered through set-variable', () => {
    // Otherwise the model could park the literal in a variable and then
    // reference it, which is the same snapshot with an extra hop.
    const site = unproducedBulkData(
      'set-variable',
      { variableName: 'hotList', value: HOT_SEARCH_CSV },
      noVariables,
    )
    expect(site?.path).toEqual(['value'])
  })

  it('lets a real upstream producer through', () => {
    const index = buildVariableIndex({ hotList: HOT_SEARCH_CSV })
    expect(unproducedBulkData('save-local', { value: HOT_SEARCH_CSV }, index)).toBeNull()
  })

  it('lets an explicit reference through — the model did record a producer', () => {
    expect(unproducedBulkData('save-local', { value: '{{hotList}}' }, noVariables)).toBeNull()
  })

  it('does NOT let a reference launder a pasted block — the literal part is what counts', () => {
    // The second reported shape, and the reason this gate kept failing open:
    // `hasReference` used to exempt the WHOLE value, so appending one token to a
    // frozen snapshot bought a free pass. The token here (`{{currentTime}}`) is
    // one the model invented — nothing in the graph produces it — and the saved
    // workflow consequently replayed a generation-time table on every run.
    const laundered = `${HOT_SEARCH_CSV}\n\n采集时间：{{currentTime}}`
    const site = unproducedBulkData(
      'set-variable',
      { variableName: 'hotSearchContent', value: laundered },
      noVariables,
    )
    expect(site?.path).toEqual(['value'])
  })

  it('still lets a value that is ONLY references through', () => {
    // No literal left after stripping the tokens, so there is nothing to freeze.
    expect(
      unproducedBulkData('save-local', { value: '{{hotList}}\n{{stamp}}' }, noVariables),
    ).toBeNull()
  })

  it('still lets a config template through — its literal part is structure, not content', () => {
    // The counterpart to the case above: a JSON body whose references carry the
    // data and whose literal is only keys/braces must not be refused, or the
    // fix would trade one false negative for a false positive.
    const body = ['{', '  "text": "热搜已更新：{{hotList}}",', '  "channel": "#alerts",', '}'].join(
      '\n',
    )
    expect(
      unproducedBulkData('webhook', { url: 'https://example.com/hook', body }, noVariables),
    ).toBeNull()
  })

  it('lets a small user knob through even in the same block as a gated param', () => {
    expect(
      unproducedBulkData('save-local', { filename: '微博热搜Top20.csv', value: '' }, noVariables),
    ).toBeNull()
  })

  it('exempts the ai-agent prompt — an instruction is addressed TO the workflow', () => {
    const prompt = [
      'Read the hot search list on this page.',
      'Return the top 20 as CSV rows: rank,topic,heat.',
      'Include the numeric heat value exactly as rendered.',
      'Do not invent entries; if fewer than 20 are present, return what exists.',
      'Keep the topic text verbatim, including punctuation.',
      'Output CSV only, no prose, no code fences.',
    ].join('\n')
    expect(prompt.length).toBeGreaterThan(200)
    expect(unproducedBulkData('ai-agent', { prompt }, noVariables)).toBeNull()
  })

  it('returns null for a block with no data parameters', () => {
    expect(unproducedBulkData('event-click', { selector: '#go' }, noVariables)).toBeNull()
  })
})

describe('unproducedDataRefusal', () => {
  const site = { path: ['value'] as const, value: HOT_SEARCH_CSV }

  it('names the offending parameter and its size', () => {
    const message = unproducedDataRefusal('save-local', { path: [...site.path], value: site.value })
    expect(message).toContain('save-local.value')
    expect(message).toContain(String(HOT_SEARCH_CSV.length))
  })

  it('names the operators that produce data, not just "record a step"', () => {
    const message = unproducedDataRefusal('save-local', { path: [...site.path], value: site.value })
    for (const tool of [
      'wf_op_get-text',
      'wf_op_attribute-value',
      'wf_op_ai-agent',
      'wf_op_export-data',
    ]) {
      expect(message).toContain(tool)
    }
    // The collector recipe is the actionable part.
    expect(message).toContain('saveData:true')
    expect(message).toContain('dataColumn')
  })

  it('tells the model how to retry', () => {
    const message = unproducedDataRefusal('save-local', { path: [...site.path], value: site.value })
    expect(message).toContain('{{')
  })
})

describe('the reported failure, end to end', () => {
  it('refuses save-local carrying a pasted scrape, without recording a node', async () => {
    const { calls, executors } = okExecutors()
    const result = await run(
      'conv-refuse',
      'wf_op_save-local',
      { filename: '微博热搜Top20.csv', value: HOT_SEARCH_CSV },
      executors,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('wf_op_get-text')

    // Nothing ran and nothing was recorded: the draft cannot hold a node that
    // would re-emit the snapshot on every replay.
    expect(calls).toEqual([])
    expect(actionNodesOf(getDraftSnapshot('conv-refuse')!)).toHaveLength(0)
  })

  it('refuses BEFORE the block executes, so the page is never touched', async () => {
    const { calls, executors } = okExecutors()
    const result = await run(
      'conv-nopage',
      'wf_op_set-variable',
      { variableName: 'hotList', value: HOT_SEARCH_CSV },
      executors,
    )

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('accepts the corrected pipeline: a collector node, then a reference', async () => {
    const { executors } = okExecutors()
    // The collector writes the value into a session variable, exactly as the
    // real `get-text` executor does.
    const collector: BlockExecutor = async (_data, ctx) => {
      ctx.variables['hotList'] = HOT_SEARCH_CSV
      return null
    }

    const collected = await run(
      'conv-fixed',
      'wf_op_get-text',
      { selector: '.td-02 a', multiple: true, saveData: true, dataColumn: '热搜' },
      { ...executors, 'get-text': collector },
    )
    expect(collected.ok).toBe(true)

    const saved = await run(
      'conv-fixed',
      'wf_op_save-local',
      { filename: '微博热搜Top20.csv', value: HOT_SEARCH_CSV },
      executors,
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    // The literal became a reference to the producer, not a declared input.
    const nodes = actionNodesOf(getDraftSnapshot('conv-fixed')!)
    const save = nodes.find((n) => n.data['blockId'] === 'save-local')!
    expect(save.data['value']).toBe('{{hotList}}')

    // The small knob (`filename`) may still be declared as an input — that is
    // correct. What must NOT happen is the CONTENT being frozen into a
    // declaration's default, which is what made the broken graph look valid.
    const trigger = getDraftSnapshot('conv-fixed')!.nodes.find((n) => n.label === 'trigger')!
    const params = (trigger.data['parameters'] ?? []) as { defaultValue?: unknown }[]
    expect(params.some((p) => p.defaultValue === HOT_SEARCH_CSV)).toBe(false)
  })
})

describe('the gate is on every record path', () => {
  it('refuses on the non-executing path too', async () => {
    const result = await runOperatorTool({
      name: 'wf_op_save-local',
      args: { filename: 'a.csv', value: HOT_SEARCH_CSV },
      conversationId: 'conv-plain',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('wf_op_export-data')
    expect(actionNodesOf(getDraftSnapshot('conv-plain')!)).toHaveLength(0)
  })

  it('still records a reference on the non-executing path', async () => {
    const result = await runOperatorTool({
      name: 'wf_op_save-local',
      args: { filename: 'a.csv', value: '{{hotList}}' },
      conversationId: 'conv-plain-ok',
    })
    expect(result.ok).toBe(true)
  })
})

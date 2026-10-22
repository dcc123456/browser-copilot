/**
 * Tests for the vendor-neutral thinking-effort layer (`lib/thinking`):
 * vendor resolution, the per-vendor level sets and request bodies, the
 * model-level support verdict, and the recognition of a provider error that
 * says the model rejects the parameter.
 */
import { describe, expect, it } from 'vitest'

import {
  THINKING_LEVELS,
  isUnsupportedThinkingDetail,
  normalizeThinkingLevel,
  normalizeThinkingProfile,
  thinkingBodyFor,
  thinkingLevelsFor,
  thinkingModelSupport,
  thinkingParamSummary,
  thinkingShapeVerified,
  thinkingVendorOf,
} from '../src/lib/thinking'

describe('thinkingVendorOf', () => {
  it('resolves vendors from the host, not from the preset id', () => {
    // A profile whose base URL was edited keeps a vendor URL; the preset id
    // would have become 'custom' by then.
    expect(thinkingVendorOf('https://api.deepseek.com/v1')).toBe('deepseek')
    expect(thinkingVendorOf('https://api.openai.com/v1')).toBe('openai')
    expect(thinkingVendorOf('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(thinkingVendorOf('https://ark.cn-beijing.volces.com/api/v3')).toBe('ark')
    expect(thinkingVendorOf('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('dashscope')
    expect(thinkingVendorOf('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu')
    expect(thinkingVendorOf('https://api.moonshot.cn/v1')).toBe('kimi')
    expect(thinkingVendorOf('https://api.minimaxi.com/v1')).toBe('minimax')
    expect(thinkingVendorOf('https://api.siliconflow.cn/v1')).toBe('siliconflow')
    expect(thinkingVendorOf('https://api.groq.com/openai/v1')).toBe('groq')
    expect(thinkingVendorOf('https://api.x.ai/v1')).toBe('xai')
  })

  it('falls back to unknown for endpoints it cannot place', () => {
    expect(thinkingVendorOf('http://localhost:11434/v1')).toBe('unknown')
    expect(thinkingVendorOf('')).toBe('unknown')
    expect(thinkingVendorOf('not a url')).toBe('unknown')
  })
})

describe('thinking levels per vendor', () => {
  it('offers every level where the vendor can express it', () => {
    expect(thinkingLevelsFor('https://api.openai.com/v1', 'gpt-5')).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ])
    expect(thinkingLevelsFor('https://openrouter.ai/api/v1', 'openai/gpt-5')).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ])
  })

  it('hides levels the vendor cannot express', () => {
    // DeepSeek documents none/low/high/max — no 'medium'.
    expect(thinkingLevelsFor('https://api.deepseek.com/v1', 'deepseek-reasoner')).toEqual([
      'off',
      'low',
      'high',
    ])
    // Kimi and Groq document no level that turns reasoning off.
    expect(thinkingLevelsFor('https://api.moonshot.cn/v1', 'kimi-k3')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(thinkingLevelsFor('https://api.groq.com/openai/v1', 'openai/gpt-oss-120b')).toEqual([
      'low',
      'medium',
      'high',
    ])
    // GLM documents only an on/off switch.
    expect(thinkingLevelsFor('https://open.bigmodel.cn/api/paas/v4', 'glm-5')).toEqual([
      'off',
      'high',
    ])
  })

  it('follows the model when one vendor documents a different shape per model', () => {
    // Qwen3.8 takes reasoning_effort; the older Qwen3 takes a token budget.
    expect(
      thinkingLevelsFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max'),
    ).toEqual(['off', 'low', 'medium', 'high'])
    expect(
      thinkingLevelsFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-max'),
    ).toEqual(['off', 'low', 'medium', 'high'])
    // MiniMax: only M3.1-Flash takes a depth, and it cannot be turned off.
    expect(thinkingLevelsFor('https://api.minimaxi.com/v1', 'MiniMax-M3.1-Flash')).toEqual([
      'low',
      'medium',
      'high',
    ])
    // M3 can be turned off but takes no depth level.
    expect(thinkingLevelsFor('https://api.minimaxi.com/v1', 'MiniMax-M3')).toEqual(['off'])
    // The M2 series always thinks and accepts no level at all.
    expect(thinkingLevelsFor('https://api.minimaxi.com/v1', 'MiniMax-M2.5')).toEqual([])
  })

  it('marks an unverified vendor as such', () => {
    expect(thinkingShapeVerified('https://api.openai.com/v1', 'gpt-5')).toBe(true)
    expect(thinkingShapeVerified('http://localhost:11434/v1', 'qwen3:8b')).toBe(false)
  })
})

describe('thinkingBodyFor', () => {
  it('sends each vendor its own parameter shape', () => {
    expect(thinkingBodyFor('https://api.openai.com/v1', 'gpt-5', 'high')).toEqual({
      reasoning_effort: 'high',
    })
    expect(
      thinkingBodyFor('https://openrouter.ai/api/v1', 'deepseek/deepseek-chat', 'low'),
    ).toEqual({ reasoning: { effort: 'low' } })
    expect(thinkingBodyFor('https://api.deepseek.com/v1', 'deepseek-reasoner', 'off')).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(thinkingBodyFor('https://api.deepseek.com/v1', 'deepseek-reasoner', 'low')).toEqual({
      thinking: { type: 'enabled', reasoning_effort: 'low' },
    })
    expect(
      thinkingBodyFor('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-code', 'medium'),
    ).toEqual({ reasoning: { effort: 'medium' } })
    expect(
      thinkingBodyFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-max', 'low'),
    ).toEqual({ enable_thinking: true, thinking_budget: 1024 })
    expect(thinkingBodyFor('https://open.bigmodel.cn/api/paas/v4', 'glm-5', 'high')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  it('sends Qwen3.8 the reasoning level it documents instead of a budget', () => {
    // Qwen3.8 refuses thinking_budget and reasoning_effort in one request,
    // and it documents the levels by name.
    expect(
      thinkingBodyFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max', 'medium'),
    ).toEqual({ reasoning_effort: 'medium' })
    expect(
      thinkingBodyFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max', 'high'),
    ).toEqual({ reasoning_effort: 'xhigh' })
    expect(
      thinkingBodyFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max', 'off'),
    ).toEqual({ enable_thinking: false })
    // The older Qwen3 keeps the budget, and it stays inside the documented
    // 1–32768 range.
    expect(
      thinkingBodyFor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-max', 'high'),
    ).toEqual({ enable_thinking: true, thinking_budget: 32768 })
  })

  it('sends MiniMax only what its model documents', () => {
    // M3.1-Flash is the only MiniMax model that takes a depth, and its
    // thinking cannot be turned off.
    expect(thinkingBodyFor('https://api.minimaxi.com/v1', 'MiniMax-M3.1-Flash', 'medium')).toEqual({
      reasoning_effort: 'medium',
    })
    expect(
      thinkingBodyFor('https://api.minimaxi.com/v1', 'MiniMax-M3.1-Flash', 'off'),
    ).toBeUndefined()
    // M3 takes no depth but can be turned off.
    expect(thinkingBodyFor('https://api.minimaxi.com/v1', 'MiniMax-M3', 'off')).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(thinkingBodyFor('https://api.minimaxi.com/v1', 'MiniMax-M3', 'high')).toBeUndefined()
    // The M2 series always thinks: nothing may be sent.
    expect(thinkingBodyFor('https://api.minimaxi.com/v1', 'MiniMax-M2.5', 'off')).toBeUndefined()
  })

  it('folds a level the vendor lacks into its nearest equivalent', () => {
    // DeepSeek documents no 'medium' and folds it into 'high'.
    expect(thinkingBodyFor('https://api.deepseek.com/v1', 'deepseek-reasoner', 'medium')).toEqual({
      thinking: { type: 'enabled', reasoning_effort: 'high' },
    })
  })

  it('sends nothing when no level is set', () => {
    expect(thinkingBodyFor('https://api.openai.com/v1', 'gpt-5', undefined)).toBeUndefined()
  })

  it('sends nothing for a model documented to reject the parameter', () => {
    expect(thinkingBodyFor('https://api.openai.com/v1', 'gpt-4o-mini', 'high')).toBeUndefined()
    expect(thinkingBodyFor('https://api.deepseek.com/v1', 'deepseek-chat', 'high')).toBeUndefined()
  })

  it('sends nothing for a level the vendor cannot express at all', () => {
    // Kimi has no "off"; the request must not carry a made-up parameter.
    expect(thinkingBodyFor('https://api.moonshot.cn/v1', 'kimi-k3', 'off')).toBeUndefined()
  })
})

describe('thinkingModelSupport', () => {
  it('names the models documented to reject thinking control', () => {
    expect(thinkingModelSupport('https://api.openai.com/v1', 'gpt-4o-mini')).toBe('unsupported')
    expect(thinkingModelSupport('https://api.openai.com/v1', 'gpt-4.1')).toBe('unsupported')
    expect(thinkingModelSupport('https://api.deepseek.com/v1', 'deepseek-chat')).toBe('unsupported')
    // The MiniMax M2 series always thinks and accepts no level.
    expect(thinkingModelSupport('https://api.minimaxi.com/v1', 'MiniMax-M2.5')).toBe('unsupported')
  })

  it('names the models documented to accept it', () => {
    expect(thinkingModelSupport('https://api.openai.com/v1', 'gpt-5')).toBe('supported')
    expect(thinkingModelSupport('https://api.deepseek.com/v1', 'deepseek-reasoner')).toBe(
      'supported',
    )
    expect(
      thinkingModelSupport('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-code'),
    ).toBe('supported')
  })

  it('says "unknown" instead of guessing', () => {
    expect(thinkingModelSupport('https://api.openai.com/v1', 'some-future-model')).toBe('unknown')
    expect(thinkingModelSupport('https://api.deepseek.com/v1', '')).toBe('unknown')
    expect(thinkingModelSupport('http://localhost:11434/v1', 'qwen3:8b')).toBe('unknown')
  })
})

describe('thinkingParamSummary', () => {
  it('spells out the parameters the request will carry', () => {
    expect(thinkingParamSummary('https://api.openai.com/v1', 'gpt-5', 'high')).toBe(
      'reasoning_effort=high',
    )
    expect(thinkingParamSummary('https://api.deepseek.com/v1', 'deepseek-reasoner', 'low')).toBe(
      'thinking.type=enabled, thinking.reasoning_effort=low',
    )
  })

  it('follows the model when the vendor documents a different shape per model', () => {
    expect(
      thinkingParamSummary(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3.8-max',
        'high',
      ),
    ).toBe('reasoning_effort=xhigh')
    expect(
      thinkingParamSummary(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3-max',
        'high',
      ),
    ).toBe('enable_thinking=true, thinking_budget=32768')
    expect(
      thinkingParamSummary('https://api.minimaxi.com/v1', 'MiniMax-M3.1-Flash', 'medium'),
    ).toBe('reasoning_effort=medium')
  })
})

describe('normalizeThinkingLevel', () => {
  it('keeps legal levels and drops everything else', () => {
    expect(normalizeThinkingLevel('high')).toBe('high')
    expect(normalizeThinkingLevel('HIGH')).toBeUndefined()
    expect(normalizeThinkingLevel('extreme')).toBeUndefined()
    expect(normalizeThinkingLevel(undefined)).toBeUndefined()
  })

  it('drops an unknown level from a stored profile', () => {
    const profile = { id: 'p1', thinkingEffort: 'extreme' }
    expect(normalizeThinkingProfile(profile)).toEqual({ id: 'p1' })
    const legal = { id: 'p1', thinkingEffort: 'low' }
    expect(normalizeThinkingProfile(legal)).toBe(legal)
  })
})

describe('isUnsupportedThinkingDetail', () => {
  it('recognizes a provider saying the parameter is unsupported', () => {
    expect(
      isUnsupportedThinkingDetail(
        "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
      ),
    ).toBe(true)
    expect(
      isUnsupportedThinkingDetail(
        'InvalidParameter.NotSupportEnableThinking: the model does not support thinking',
      ),
    ).toBe(true)
    expect(isUnsupportedThinkingDetail('unknown parameter: thinking')).toBe(true)
  })

  it('does not mistake a value problem for a missing capability', () => {
    expect(isUnsupportedThinkingDetail('thinking_budget must be between 1 and 32768')).toBe(false)
    expect(isUnsupportedThinkingDetail('context length exceeded, too large')).toBe(false)
  })

  it('ignores failures that say nothing about thinking', () => {
    expect(isUnsupportedThinkingDetail('model not found')).toBe(false)
    expect(isUnsupportedThinkingDetail('invalid api key')).toBe(false)
    expect(isUnsupportedThinkingDetail('')).toBe(false)
  })
})

describe('level list', () => {
  it('keeps the four neutral levels', () => {
    expect(THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high'])
  })
})

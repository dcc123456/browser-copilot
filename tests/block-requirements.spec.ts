/**
 * The per-block required-parameter contract (`lib/workflow/block-requirements`).
 *
 * This table is the fix for the "99% of generated workflows cannot run" class:
 * the generation session recorded whatever the executors "succeeded" at —
 * including an `element-exists` with NO locator (it reports 元素不存在 and the
 * empty node gets recorded), a key-less `press-key`, and a url-less `webhook`
 * (record-only blocks never execute, so nothing ever proved their params).
 *
 * The tests pin both directions of the contract: the blocks whose omissions
 * produced unrunnable workflows ARE refused, and the blocks with legitimately
 * optional parameters are NOT.
 */
import { describe, expect, it } from 'vitest'

import {
  formatRequirementRefusal,
  hasLocator,
  missingRequirements,
  missingTriggerParam,
  schemaRequiredArgs,
} from '../src/lib/workflow/block-requirements'

const VALID_TARGET = { primary: { how: 'role', value: '登录' } }

describe('locator requirement (the empty-selector class)', () => {
  it('refuses element-exists with no locator at all', () => {
    // THE reported defect: the executor returned 元素不存在, the bridge read
    // that as success, and a node with an empty selector entered the draft —
    // where it would forever replay the notExists branch.
    const problems = missingRequirements('element-exists', {})
    expect(problems.map((p) => p.key)).toContain('selector')
  })

  it('refuses element-exists with an all-empty rich target', () => {
    // `{primary: {how: 'role', value: ''}}` matched EVERY element in the page
    // (the kernel's role matcher treats empty role+value as "any element"),
    // so the action "succeeded" against an arbitrary element.
    expect(hasLocator({ target: VALID_TARGET })).toBe(true)
    expect(hasLocator({ target: { primary: { how: 'role', value: '  ' } } })).toBe(false)
    expect(missingRequirements('element-exists', { target: { primary: { how: 'role', value: '' } } }).map((p) => p.key)).toContain('selector')
  })

  it('accepts every locator form: selector, target, or a resolved ref', () => {
    expect(missingRequirements('event-click', { selector: '#go' })).toEqual([])
    expect(missingRequirements('event-click', { target: VALID_TARGET })).toEqual([])
    // A resolved snapshot ref merges into `selector`/`target` before the gate
    // runs — simulating that with a non-empty selector is equivalent.
    expect(missingRequirements('get-text', { selector: '.title' })).toEqual([])
  })

  it('covers every element-acting interaction block', () => {
    for (const blockId of ['event-click', 'hover-element', 'link', 'element-exists', 'loop-elements']) {
      expect(missingRequirements(blockId, {}), blockId).toEqual([
        expect.objectContaining({ key: 'selector' }),
      ])
    }
  })

  it('leaves genuinely locator-less blocks alone', () => {
    expect(missingRequirements('delay', {})).toEqual([])
    expect(missingRequirements('go-back', {})).toEqual([])
    expect(missingRequirements('some-future-block', {})).toEqual([])
  })
})

describe('per-block required parameters', () => {
  it('press-key requires a key', () => {
    expect(missingRequirements('press-key', {})).toHaveLength(1)
    expect(missingRequirements('press-key', { keys: 'Enter' })).toEqual([])
    expect(missingRequirements('press-key', { keysToPress: 'Control+a' })).toEqual([])
  })

  it('new-tab / new-window / webhook require a url', () => {
    for (const blockId of ['new-tab', 'new-window', 'webhook']) {
      expect(missingRequirements(blockId, {}), blockId).toEqual([
        expect.objectContaining({ key: 'url' }),
      ])
      expect(missingRequirements(blockId, { url: 'https://x.test' }), blockId).toEqual([])
    }
  })

  it('webhook headers must be a JSON object string when present', () => {
    expect(missingRequirements('webhook', { url: 'https://x', headers: 'not json' })).toHaveLength(1)
    expect(missingRequirements('webhook', { url: 'https://x', headers: '[1,2]' })).toHaveLength(1)
    expect(missingRequirements('webhook', { url: 'https://x', headers: '{"A":"b"}' })).toEqual([])
  })

  it('notification requires a message; export-data requires a name', () => {
    expect(missingRequirements('notification', {}).map((p) => p.key)).toContain('message')
    expect(missingRequirements('export-data', {}).map((p) => p.key)).toContain('name')
  })

  it('export-data in variable mode also requires the variable', () => {
    expect(
      missingRequirements('export-data', { name: 'x.csv', dataToExport: 'variable' }).map(
        (p) => p.key,
      ),
    ).toContain('variableName')
    expect(missingRequirements('export-data', { name: 'x.csv' })).toEqual([])
  })

  it('save-local refuses a literal value and a missing filename', () => {
    const problems = missingRequirements('save-local', { value: 'frozen literal', filename: 'a.md' })
    expect(problems.map((p) => p.key)).toContain('value')
    expect(missingRequirements('save-local', { value: '{{hotList}}' }).map((p) => p.key)).toContain('filename')
    expect(missingRequirements('save-local', { value: '{{hotList}}', filename: 'a.md' })).toEqual([])
  })

  it('set-variable / get-secret demand their names', () => {
    expect(missingRequirements('set-variable', {}).map((p) => p.key)).toEqual([
      'variableName',
      'value',
    ])
    expect(missingRequirements('get-secret', {}).map((p) => p.key)).toEqual([
      'credential',
      'variableName',
    ])
    expect(missingRequirements('get-secret', { credential: 'a::b', variableName: 'pw' })).toEqual([])
  })

  it('get-text only demands dataColumn when it claims to collect', () => {
    expect(missingRequirements('get-text', { selector: '.a', saveData: true }).map((p) => p.key)).toContain('dataColumn')
    expect(missingRequirements('get-text', { selector: '.a', saveData: true, dataColumn: '热搜' })).toEqual([])
    expect(missingRequirements('get-text', { selector: '.a' })).toEqual([])
  })

  it('forms demands value in write mode and variableName in read mode', () => {
    expect(missingRequirements('forms', { selector: '#q' }).map((p) => p.key)).toContain('value')
    // Checkbox / radio flip without a value; getValue mode reads instead.
    expect(missingRequirements('forms', { selector: '#q', type: 'checkbox' })).toEqual([])
    expect(missingRequirements('forms', { selector: '#q', getValue: true }).map((p) => p.key)).toContain('variableName')
    expect(
      missingRequirements('forms', { selector: '#q', getValue: true, variableName: 'v' }),
    ).toEqual([])
    // A bad type enum is refused too.
    expect(missingRequirements('forms', { selector: '#q', value: 'x', type: 'textarea' })).toHaveLength(1)
  })

  it('loop / branch blocks demand something to drive on', () => {
    expect(missingRequirements('repeat-task', {}).map((p) => p.key)).toContain('repeatFor')
    expect(missingRequirements('while-loop', {}).map((p) => p.key)).toContain('code')
    expect(missingRequirements('loop-data', {})).toHaveLength(1)
    expect(missingRequirements('loop-data', { loopData: '[1,2]' })).toEqual([])
    expect(missingRequirements('conditions', {})).toHaveLength(1)
    expect(missingRequirements('conditions', { code: 'true' })).toEqual([])
    expect(missingRequirements('conditions', { conditions: [{ conditions: [{}] }] })).toEqual([])
  })

  it('ai-agent demands prompt and variableName', () => {
    expect(missingRequirements('ai-agent', {}).map((p) => p.key)).toEqual(['prompt', 'variableName'])
    expect(missingRequirements('ai-agent', { prompt: '总结页面', variableName: 'summary' })).toEqual([])
  })

  it('record-only side-effect blocks are validated even though they never run', () => {
    // This is the second half of the defect class: record-only blocks never
    // execute during generation, so only this gate stands between the model
    // and a webhook node that fetches nothing.
    expect(missingRequirements('webhook', {}).map((p) => p.key)).toContain('url')
    expect(missingRequirements('execute-workflow', {}).map((p) => p.key)).toContain('workflowId|executeId')
  })

  it('the trigger validates per kind', () => {
    expect(missingRequirements('trigger', { type: 'visit-web' }).map((p) => p.key)).toContain('url')
    expect(missingRequirements('trigger', { type: 'visit-web', url: 'https://x.test' })).toEqual([])
    expect(missingRequirements('trigger', { type: 'manual' })).toEqual([])
    expect(missingTriggerParam('interval', { interval: 0 })).toBe('interval')
    expect(missingTriggerParam('interval', { interval: 30 })).toBeNull()
    expect(missingTriggerParam('element-change', { observeElement: { selector: '#feed' } })).toBeNull()
    expect(missingTriggerParam('element-change', {})).toBe('observeElement.selector')
  })
})

describe('schemaRequiredArgs (what the tool schema marks required)', () => {
  it('exposes only unconditional requirements', () => {
    expect(schemaRequiredArgs('new-tab')).toEqual(['url'])
    expect(schemaRequiredArgs('get-secret')).toEqual(['credential', 'variableName'])
    expect(schemaRequiredArgs('save-local')).toEqual(['value', 'filename'])
    expect(schemaRequiredArgs('trigger-event')).toEqual(['event'])
    // Conditional (get-text.dataColumn), anyOf (press-key.keys) and locator
    // requirements cannot be expressed in JSON-Schema `required` — the gate
    // enforces those.
    expect(schemaRequiredArgs('get-text')).toEqual([])
    expect(schemaRequiredArgs('press-key')).toEqual([])
    expect(schemaRequiredArgs('element-exists')).toEqual([])
    expect(schemaRequiredArgs('trigger')).toEqual([])
    expect(schemaRequiredArgs('unknown-block')).toEqual([])
  })
})

describe('the refusal the model sees', () => {
  it('names the block, every missing parameter and the fact nothing was recorded', () => {
    const message = formatRequirementRefusal('Element exists', [
      { key: 'selector', message: '缺少元素定位' },
    ])
    expect(message).toContain('Element exists')
    expect(message).toContain('selector')
    expect(message).toContain('未记录')
  })
})

import { describe, expect, it } from 'vitest'
import {
  collectGeneralizationCandidates,
  generalizeInputs,
  isSensitiveName,
  isSensitiveValue,
  nameHintFromTaskText,
} from '../src/lib/workflow/input-generalization'
import type { WorkflowDraft } from '../src/lib/workflow/draft-types'
import type { WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

let seq = 0
function nid(): string {
  seq += 1
  return `m${seq}`
}

function formsNode(value: string): WorkflowNode {
  return {
    id: nid(),
    label: 'forms',
    position: { x: 0, y: 0 },
    data: { blockId: 'forms', selector: '#q', value },
  }
}

function draftWith(nodes: WorkflowNode[], goalText?: string): WorkflowDraft {
  const trigger: WorkflowNode = {
    id: 't',
    label: 'trigger',
    position: { x: 0, y: 0 },
    data: { blockId: 'trigger', type: 'manual' },
  }
  const all = [trigger, ...nodes]
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < all.length - 1; i += 1) {
    edges.push({ id: `e${i}`, source: all[i]!.id, target: all[i + 1]!.id })
  }
  return {
    conversationId: 'c1',
    name: 'test',
    nodes: all,
    edges,
    tail: all.at(-1)!.id,
    source: 'chat-generate',
    ...(goalText ? { goalText } : {}),
  }
}

describe('runtime input generalization', () => {
  it('derives a keyword name from a search task', () => {
    expect(nameHintFromTaskText('Search for iPhone on Amazon')).toBe('keyword')
  })

  it('derives an order id name', () => {
    expect(nameHintFromTaskText('Look up order 123')).toBe('orderId')
  })

  it('returns undefined when no intent is recognizable', () => {
    expect(nameHintFromTaskText('just click the button')).toBeUndefined()
  })

  it('generalizes a task-text literal into a {{keyword}} trigger parameter', () => {
    const result = generalizeInputs(
      draftWith([formsNode('iPhone 17 Pro Max')], 'Search for iPhone 17 Pro Max on Amazon'),
    )
    expect(result.declarations).toHaveLength(1)
    expect(result.declarations[0]!.name).toBe('keyword')
    expect(result.declarations[0]!.defaultValue).toBe('iPhone 17 Pro Max')
    const forms = result.draft.nodes.find((n) => n.label === 'forms')!
    expect(forms.data['value']).toBe('{{keyword}}')
    expect(result.rewrittenNodeIds).toHaveLength(1)
  })

  it('reuses one declaration for repeated identical values', () => {
    const draft = draftWith(
      [formsNode('iPhone'), formsNode('iPhone')],
      'Search for iPhone twice',
    )
    const result = generalizeInputs(draft)
    expect(result.declarations).toHaveLength(1)
    expect(result.draft.nodes.filter((n) => n.data['value'] === '{{keyword}}')).toHaveLength(2)
  })

  it('does not promote a literal that is not in the task text', () => {
    const result = generalizeInputs(
      draftWith([formsNode('unrelated value')], 'do something else entirely'),
    )
    expect(result.declarations).toHaveLength(0)
    const forms = result.draft.nodes.find((n) => n.label === 'forms')!
    expect(forms.data['value']).toBe('unrelated value')
  })

  it('blocks API-key-like values from being promoted', () => {
    const secret = 'ak_' + 'a'.repeat(40)
    const result = generalizeInputs(draftWith([formsNode(secret)], `use ${secret} please`))
    expect(result.declarations).toHaveLength(0)
    expect(result.blockedSensitive).toContain(secret)
  })

  it('blocks JWT-shaped values', () => {
    const jwt = 'eyJ' + 'A'.repeat(30)
    expect(isSensitiveValue(jwt)).toBe(true)
  })

  it('blocks bearer tokens', () => {
    expect(isSensitiveValue('Bearer abcdefgh12345678')).toBe(true)
  })

  it('does not treat short business codes as sensitive', () => {
    expect(isSensitiveValue('AAPL')).toBe(false)
    expect(isSensitiveValue('iPhone 17')).toBe(false)
  })

  it('flags sensitive names', () => {
    expect(isSensitiveName('password')).toBe(true)
    expect(isSensitiveName('api_key')).toBe(true)
    expect(isSensitiveName('keyword')).toBe(false)
  })

  it('collects forms literals but ignores urls and existing references', () => {
    const draft = draftWith(
      [
        formsNode('plain keyword'),
        {
          id: nid(),
          label: 'forms',
          position: { x: 0, y: 0 },
          data: { blockId: 'forms', value: 'https://example.com' },
        },
        {
          id: nid(),
          label: 'forms',
          position: { x: 0, y: 0 },
          data: { blockId: 'forms', value: '{{existing}}' },
        },
      ],
      'plain keyword',
    )
    const candidates = collectGeneralizationCandidates(draft)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.value).toBe('plain keyword')
  })
})

/**
 * Semantic locator recording (spec §5 Phase 2): role/name identity must be
 * savable on its own, the selector must stop being the ONLY identity, and the
 * recorded node data carries `__reliability.locator` alongside the legacy
 * flat fields without touching them.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  reliabilityLocatorOf,
  resolveRecordedLocator,
} from '../src/lib/workflow/target-to-selector'
import { semanticLocatorFromTarget } from '../src/lib/workflow/element-fingerprint'

describe('semantic identity on recorded locators', () => {
  it('a role-only target keeps NO selector and still carries semantic identity', () => {
    const locator = resolveRecordedLocator({
      target: { primary: { how: 'role', value: '发货', role: 'button' } },
    })
    expect(locator.selector).toBe('')
    expect(locator.target).toBeDefined()
    expect(locator.semantic).toEqual({ role: 'button', accessibleName: '发货' })
  })

  it('a testid target derives testId identity', () => {
    const locator = resolveRecordedLocator({
      target: { primary: { how: 'testid', value: 'submit-order' } },
    })
    expect(locator.selector).toBe('[data-testid="submit-order"]')
    expect(locator.semantic?.testId).toBe('submit-order')
  })

  it('a css-only target derives no semantic identity (position is not identity)', () => {
    const locator = resolveRecordedLocator({ selector: '.list > div:nth-child(2)' })
    expect(locator.semantic).toBeUndefined()
  })

  it('a stable id becomes stableAttributes identity; a generated one does not', () => {
    const stable = resolveRecordedLocator({
      target: { primary: { how: 'id', value: 'login-submit' } },
    })
    expect(stable.semantic?.stableAttributes).toEqual({ id: 'login-submit' })
    const unstable = resolveRecordedLocator({
      target: { primary: { how: 'id', value: 'ember-1234' } },
    })
    expect(unstable.semantic).toBeUndefined()
  })

  it('semanticLocatorFromTarget reads snapshot targets with a label', () => {
    const locator = semanticLocatorFromTarget({
      primary: { how: 'role', value: '登录', role: 'button' },
      label: '登录',
    })
    expect(locator?.accessibleName).toBe('登录')
  })
})

describe('__reliability.locator patch', () => {
  it('carries semantic + verification when both are known', () => {
    const patch = reliabilityLocatorOf({
      selector: '[data-testid="go"]',
      target: { primary: { how: 'testid', value: 'go' } },
      semantic: { testId: 'go' },
      verified: true,
    })
    expect(patch).toEqual({ semantic: { testId: 'go' }, selectorVerified: true })
  })

  it('carries verification alone for a css-only locator', () => {
    const patch = reliabilityLocatorOf({ selector: '#a', verified: false })
    expect(patch).toEqual({ selectorVerified: false })
  })

  it('returns undefined when there is nothing reliability-relevant to say', () => {
    expect(reliabilityLocatorOf({ selector: '.x' })).toBeUndefined()
  })
})

describe('operator record path saves __reliability.locator', () => {
  it('the click record path merges the reliability locator metadata additively', async () => {
    // The operator bridge persists drafts through chrome.storage — mock it
    // exactly like the other operator-record tests do.
    const store = new Map<string, unknown>()
    vi.stubGlobal('chrome', {
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
    })
    const { getDraftSnapshot } = await import('../src/background/operator-tool-handler')
    const { runOperatorToolWithExecution } = await import('../src/background/operator-tool-run')
    const recorded: Record<string, unknown>[] = []
    const executors = {
      'event-click': async (data: Record<string, unknown>) => {
        recorded.push(data)
        return null
      },
    }
    const result = await runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      args: { target: { primary: { how: 'role', value: '发货', role: 'button' } }, label: '发货' },
      conversationId: 'conv-sem-1',
      executors: executors as never,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    const node = recorded[0] ?? {}
    expect(node['selector']).toBeUndefined() // role targets have no CSS
    expect(node['target']).toBeDefined()
    const reliability = node['__reliability'] as
      | { locator?: { semantic?: { role?: string; accessibleName?: string }; selectorVerified?: boolean } }
      | undefined
    expect(reliability?.locator?.semantic?.role).toBe('button')
    expect(reliability?.locator?.semantic?.accessibleName).toBe('发货')
    // The draft node carries it too (the thing that actually gets saved).
    const draftNode = getDraftSnapshot('conv-sem-1')?.nodes.find(
      (n) => n.data?.['blockId'] === 'event-click',
    )
    const draftReliability = draftNode?.data?.['__reliability'] as typeof reliability
    expect(draftReliability?.locator?.semantic?.role).toBe('button')
  })
})

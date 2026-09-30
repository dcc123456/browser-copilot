/**
 * The page-context guard as the RUNTIME applies it (spec §11): a strict run
 * must refuse to act on a page it was not grounded on — but a block that
 * navigates of its own accord is judged on where it is GOING, not on the
 * stale tab it starts from.
 */
import { describe, expect, it, vi } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import { EXECUTORS, type BlockExecutor } from '../src/background/workflow-engine/executors'
import { edge, linearChain, makeWorkflow } from './repair/helpers'
import type { Workflow } from '../src/lib/workflow/types'

function strictGraph(
  navUrl: string,
  grounding: Record<string, unknown>,
): Workflow {
  const chain = linearChain(['t', 'nav', 'click'], (id) =>
    id === 't' ? 'trigger' : id === 'nav' ? 'new-tab' : 'event-click',
  )
  chain.nodes[1]!.data = { ...chain.nodes[1]!.data, url: navUrl }
  chain.nodes[2]!.data = { ...chain.nodes[2]!.data, selector: '.publish' }
  const workflow = makeWorkflow(chain.nodes, [edge('t', 'nav'), edge('nav', 'click')])
  return {
    ...workflow,
    settings: { ...workflow.settings, ...grounding, reliabilityMode: 'generated-strict' },
  }
}

/** Executors that only record that the guarded step was allowed to run. */
function recorder() {
  const ran: string[] = []
  const executors = {
    ...EXECUTORS,
    'new-tab': (async () => {
      ran.push('new-tab')
      return null
    }) as BlockExecutor,
    'event-click': (async () => {
      ran.push('event-click')
      return null
    }) as BlockExecutor,
  }
  return { ran, executors }
}

describe('page-context guard at the engine', () => {
  it('lets the first navigation through when its DESTINATION is the grounded site', async () => {
    // The exact false positive: the tab the run starts on is someone else's
    // site, and the workflow's own first step opens the grounded one.
    const workflow = strictGraph('https://github.com/new', {
      generationOriginUrl: 'https://github.com',
    })
    const { ran, executors } = recorder()
    const getPageContext = vi.fn(async () => ({ url: 'https://creator.xiaohongshu.com', title: '创作中心' }))

    const result = await runWorkflow(workflow, { executors, getPageContext })

    expect(result.outcome).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(ran).toEqual(['new-tab', 'event-click'])
    // The stale tab is never consulted for a self-navigating block.
    expect(getPageContext).not.toHaveBeenCalled()
  })

  it('still refuses a navigation whose own destination is off-site', async () => {
    const workflow = strictGraph('https://evil.test/github', {
      generationOriginUrl: 'https://github.com',
    })
    const { ran, executors } = recorder()

    const result = await runWorkflow(workflow, {
      executors,
      getPageContext: async () => ({ url: 'https://github.com/' }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('WRONG_ORIGIN')
    expect(result.error).toContain('导航目标（https://evil.test）')
    expect(ran).toEqual([])
  })

  it('judges a navigation with a dynamic destination on the current page', async () => {
    const workflow = strictGraph('{{startUrl}}', { generationOriginUrl: 'https://github.com' })
    const { ran, executors } = recorder()

    const result = await runWorkflow(workflow, {
      executors,
      getPageContext: async () => ({ url: 'https://creator.xiaohongshu.com' }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('WRONG_ORIGIN')
    expect(result.error).toContain('当前页面（https://creator.xiaohongshu.com）')
    expect(ran).toEqual([])
  })

  it('refuses a page action that has no navigation to vouch for it', async () => {
    const chain = linearChain(['t', 'click'], (id) => (id === 't' ? 'trigger' : 'event-click'))
    chain.nodes[1]!.data = { ...chain.nodes[1]!.data, selector: '.publish' }
    const workflow = makeWorkflow(chain.nodes, [edge('t', 'click')])
    const strict: Workflow = {
      ...workflow,
      settings: {
        ...workflow.settings,
        reliabilityMode: 'generated-strict',
        pageContext: { origin: 'https://github.com' },
      },
    }
    const { ran, executors } = recorder()

    const result = await runWorkflow(strict, {
      executors,
      getPageContext: async () => ({ url: 'https://creator.xiaohongshu.com' }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('WRONG_ORIGIN')
    expect(ran).toEqual([])
  })

  it('does not gate a run the workflow was never grounded for', async () => {
    const chain = linearChain(['t', 'nav'], (id) => (id === 't' ? 'trigger' : 'new-tab'))
    chain.nodes[1]!.data = { ...chain.nodes[1]!.data, url: 'https://anywhere.test' }
    const workflow = makeWorkflow(chain.nodes, [edge('t', 'nav')])
    const { ran, executors } = recorder()
    const getPageContext = vi.fn(async () => ({ url: 'https://creator.xiaohongshu.com' }))

    const result = await runWorkflow(workflow, { executors, getPageContext })

    expect(result.outcome).toBe('ok')
    expect(getPageContext).not.toHaveBeenCalled()
    expect(ran).toEqual(['new-tab'])
  })
})

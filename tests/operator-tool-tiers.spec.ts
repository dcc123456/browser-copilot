import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) {
            if (store.has(key)) out[key] = store.get(key)
          }
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

import { TOOL_GROUPS } from '../src/background/agent'
import {
  actionNodesOf,
  getDraftSnapshot,
  TRIGGER_BLOCK_ID,
} from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_BLOCK_IDS,
  CORE_OPERATOR_TOOL_NAMES,
  OPERATOR_CATEGORY_BLOCK_IDS,
  OPERATOR_CATEGORY_ENTRIES,
  OPERATOR_CATEGORY_TOOL_NAMES,
  categoryOfOperatorGroup,
  operatorCategoryGroup,
} from '../src/lib/workflow/operator-categories'
import {
  JAVASCRIPT_BLOCK_ID,
  OPERATOR_BLOCK_IDS,
  WORKFLOW_ACTION_OPERATOR_IDS,
  WORKFLOW_AUTHOR_BLOCK_IDS,
  WORKFLOW_AUTHOR_OPERATOR_IDS,
  WORKFLOW_AUTHOR_OPERATOR_NAMES,
  WORKFLOW_CATEGORY_TOOL_GROUPS,
  WORKFLOW_ESCAPE_BLOCK_IDS,
  WORKFLOW_ESCAPE_OPERATOR_IDS,
  WORKFLOW_ESCAPE_OPERATOR_NAMES,
  buildOperatorTools,
  buildWorkflowAuthorTools,
  buildWorkflowCategoryTools,
  buildWorkflowCoreTools,
  buildWorkflowEscapeTools,
  operatorToolName,
} from '../src/lib/workflow/operator-tools'

/**
 * The operator surface is dispatched by CATEGORY. Four operators ride along on
 * every round; the rest arrive only after the model declares their category
 * through `use_operators`. `operators_author` stays as a deliberate
 * "give me everything" group, so it is the union of the categories rather than
 * a disjoint tier — the overlap is intentional and asserted below.
 *
 * The partition is what keeps the per-round payload from carrying all 54
 * schemas, so it is worth pinning in both directions: a block that leaks into
 * the core is paid on every round, and a block reachable from no category at
 * all is a block the model can never use.
 */
describe('operator category partition', () => {
  it('names only real operators in the author set', () => {
    const known = new Set(OPERATOR_BLOCK_IDS)
    expect([...WORKFLOW_AUTHOR_BLOCK_IDS].filter((id) => !known.has(id))).toEqual([])
  })

  it('names only real operators in the escape set', () => {
    const known = new Set(OPERATOR_BLOCK_IDS)
    expect([...WORKFLOW_ESCAPE_BLOCK_IDS].filter((id) => !known.has(id))).toEqual([])
  })

  it('leaves no operator unreachable', () => {
    // Every operator must be reachable from a category or from the escape
    // hatch. A block in neither is invisible to the model forever.
    const categories = ADVERTISABLE_OPERATOR_CATEGORIES.flatMap(
      (category) => OPERATOR_CATEGORY_BLOCK_IDS[category],
    )
    const uncovered = OPERATOR_BLOCK_IDS.filter(
      (id) => !categories.includes(id) && !WORKFLOW_ESCAPE_BLOCK_IDS.has(id),
    )
    expect(uncovered).toEqual([])
  })

  it('advertises each operator through at most one category', () => {
    // Categories must be disjoint with each other (and with the escape hatch),
    // or the "only send what was asked for" accounting is a lie.
    const categories = ADVERTISABLE_OPERATOR_CATEGORIES.flatMap(
      (category) => OPERATOR_CATEGORY_BLOCK_IDS[category],
    )
    expect(new Set(categories).size).toBe(categories.length)
    expect(categories).not.toContain(JAVASCRIPT_BLOCK_ID)
  })

  it('makes operators_author exactly the union of the categories', () => {
    const categories = new Set(
      ADVERTISABLE_OPERATOR_CATEGORIES.flatMap((category) => OPERATOR_CATEGORY_BLOCK_IDS[category]),
    )
    expect([...WORKFLOW_AUTHOR_OPERATOR_IDS].sort()).toEqual([...categories].sort())
    // And it must not smuggle in the escape hatch.
    expect(WORKFLOW_AUTHOR_OPERATOR_IDS).not.toContain(JAVASCRIPT_BLOCK_ID)
  })

  it('keeps the always-advertised core small and inside the catalog', () => {
    const known = new Set(OPERATOR_BLOCK_IDS)
    // Every extra core schema is paid on every round of every conversation.
    expect(CORE_OPERATOR_BLOCK_IDS.length).toBeLessThanOrEqual(5)
    for (const id of CORE_OPERATOR_BLOCK_IDS) expect(known.has(id)).toBe(true)
    // `WORKFLOW_ACTION_OPERATOR_IDS` is derived in catalog order while the core
    // list is hand-ordered for readability, so compare the sets.
    expect([...WORKFLOW_ACTION_OPERATOR_IDS].sort()).toEqual([...CORE_OPERATOR_BLOCK_IDS].sort())
  })

  it('offers no empty category to the model', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(OPERATOR_CATEGORY_ENTRIES[category].length).toBeGreaterThan(0)
    }
    // `onlineServices` / `package` are cloud-only in this build: listing them
    // would only teach the model to ask for an empty set.
    expect(ADVERTISABLE_OPERATOR_CATEGORIES).not.toContain('onlineServices')
    expect(ADVERTISABLE_OPERATOR_CATEGORIES).not.toContain('package')
  })

  it('keeps the JavaScript escape hatch out of every category', () => {
    // A generated workflow has to stay maintainable by someone who does not
    // read code, so the one block that emits code must never be advertised
    // alongside the declarative operators.
    expect(WORKFLOW_ESCAPE_OPERATOR_IDS).toEqual([JAVASCRIPT_BLOCK_ID])
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(OPERATOR_CATEGORY_BLOCK_IDS[category]).not.toContain(JAVASCRIPT_BLOCK_ID)
    }
    expect(WORKFLOW_ACTION_OPERATOR_IDS).not.toContain(JAVASCRIPT_BLOCK_ID)
  })

  it('derives the same tool names as the operator-tools module', () => {
    // `operator-categories` spells the prefix out to keep the dependency
    // one-way, so the two derivations have to be checked against each other.
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(OPERATOR_CATEGORY_TOOL_NAMES[category]).toEqual(
        OPERATOR_CATEGORY_BLOCK_IDS[category].map(operatorToolName),
      )
    }
    expect(CORE_OPERATOR_TOOL_NAMES).toEqual(CORE_OPERATOR_BLOCK_IDS.map(operatorToolName))
  })

  it('round-trips a category through its group name', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(categoryOfOperatorGroup(operatorCategoryGroup(category))).toBe(category)
    }
    // Non-category groups must not be mistaken for one, or a stray `tabs` call
    // would "activate" a category that does not exist.
    expect(categoryOfOperatorGroup('tabs')).toBeUndefined()
    expect(categoryOfOperatorGroup('operators_author')).toBeUndefined()
    expect(categoryOfOperatorGroup('operators_escape')).toBeUndefined()
  })

  it('marks the escape hatch required-arg in its own schema only', () => {
    const escape = buildWorkflowEscapeTools()[0]!
    const params = escape.function.parameters as { required?: string[] }
    expect(escape.function.name).toBe('wf_op_javascript-code')
    expect(params.required).toEqual(['justification'])
    // No declarative operator may carry a required arg — they must stay
    // callable with whatever the page needs.
    const declarative = [
      ...buildWorkflowCoreTools(),
      ...buildWorkflowCategoryTools(ADVERTISABLE_OPERATOR_CATEGORIES),
      ...buildWorkflowAuthorTools(),
    ]
    for (const tool of declarative) {
      expect((tool.function.parameters as { required?: string[] }).required).toBeUndefined()
    }
  })

  it('matches TOOL_GROUPS for the author, escape and category groups', () => {
    expect(TOOL_GROUPS.operators_author).toEqual(WORKFLOW_AUTHOR_OPERATOR_NAMES)
    expect(TOOL_GROUPS.operators_escape).toEqual(WORKFLOW_ESCAPE_OPERATOR_NAMES)
    for (const [group, names] of Object.entries(WORKFLOW_CATEGORY_TOOL_GROUPS)) {
      expect(TOOL_GROUPS[group]).toEqual(names)
    }
  })

  it('builds each tier with matching tool names', () => {
    // Catalog order vs hand-declared order differ, so compare the sets.
    expect(
      buildWorkflowCoreTools()
        .map((t) => t.function.name)
        .sort(),
    ).toEqual([...CORE_OPERATOR_TOOL_NAMES].sort())
    expect(buildWorkflowAuthorTools().map((t) => t.function.name)).toEqual(
      WORKFLOW_AUTHOR_OPERATOR_NAMES,
    )
    expect(buildWorkflowEscapeTools().map((t) => t.function.name)).toEqual(
      WORKFLOW_ESCAPE_OPERATOR_NAMES,
    )
    expect(buildOperatorTools()).toHaveLength(OPERATOR_BLOCK_IDS.length)
  })

  it('advertises a category without duplicate tool names', () => {
    // The core four are also `interaction` members, so a naive union would
    // advertise `wf_op_forms` twice — and a provider rejects a tool list with
    // repeated names outright.
    const names = buildWorkflowCategoryTools(['interaction']).map((t) => t.function.name)
    expect(names).toEqual(OPERATOR_CATEGORY_TOOL_NAMES.interaction)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps every operator description short', () => {
    // Descriptions are re-sent on every round. The cap exists so one chatty
    // catalog entry cannot outweigh several ordinary operators.
    for (const tool of buildOperatorTools()) {
      expect(tool.function.description.length).toBeLessThanOrEqual(260)
    }
  })
})

const signal = new AbortController().signal

function run(conversationId: string, name: string, args: Record<string, unknown>) {
  const executors: Record<string, BlockExecutor> = {
    'event-click': async () => null,
    'new-tab': async () => null,
  }
  return runOperatorToolWithExecution({ name, args, conversationId, signal, executors })
}

/**
 * The trigger head node is inserted automatically, so `wf_op_trigger` must
 * EDIT it rather than append a second trigger — two trigger nodes would make
 * `triggerFromNodes` pick an arbitrary one, and a workflow can only have one
 * entry point.
 */
describe('wf_op_trigger edits the trigger head in place', () => {
  it('does not append a second trigger node', async () => {
    await run('t1', 'wf_op_event-click', { selector: '#a' })
    const before = getDraftSnapshot('t1')!.nodes.length

    const out = await run('t1', 'wf_op_trigger', { type: 'visit-web', url: 'https://x.test' })
    expect(out.ok).toBe(true)

    const draft = getDraftSnapshot('t1')!
    expect(draft.nodes).toHaveLength(before)
    expect(draft.nodes.filter((n) => n.label === TRIGGER_BLOCK_ID)).toHaveLength(1)
  })

  it('merges the new parameters into the head node', async () => {
    await run('t2', 'wf_op_trigger', { type: 'visit-web', url: 'https://x.test' })

    const head = getDraftSnapshot('t2')!.nodes.find((n) => n.label === TRIGGER_BLOCK_ID)!
    expect(head.data['type']).toBe('visit-web')
    expect(head.data['url']).toBe('https://x.test')
    // Untouched defaults survive the merge.
    expect(head.data['enabled']).toBe(true)
    expect(head.data['blockId']).toBe(TRIGGER_BLOCK_ID)
  })

  it('leaves the chain cursor alone so the next node still follows the tail', async () => {
    await run('t3', 'wf_op_event-click', { selector: '#a' })
    // A `next` hint on the trigger must not rewind the chain to the head.
    await run('t3', 'wf_op_trigger', { type: 'manual', next: 'output-1' })
    await run('t3', 'wf_op_event-click', { selector: '#b' })

    const draft = getDraftSnapshot('t3')!
    const clicks = actionNodesOf(draft)
    expect(clicks).toHaveLength(2)

    const secondEdge = draft.edges.find((e) => e.target === clicks[1]!.id)!
    expect(secondEdge.source).toBe(clicks[0]!.id)
    expect(secondEdge.sourceHandle).toBe('event-click-output-1')
    expect(secondEdge.targetHandle).toBe('event-click-input-1')

    // Exactly one edge leaves the trigger, and it points at the first click.
    const head = draft.nodes.find((n) => n.label === TRIGGER_BLOCK_ID)!
    const fromTrigger = draft.edges.filter((e) => e.source === head.id)
    expect(fromTrigger).toHaveLength(1)
    expect(fromTrigger[0]!.target).toBe(clicks[0]!.id)
  })

  it('reports the head node id and does not count it as an action', async () => {
    const out = await run('t4', 'wf_op_trigger', { type: 'manual' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const draft = getDraftSnapshot('t4')!
    const head = draft.nodes.find((n) => n.label === TRIGGER_BLOCK_ID)!
    expect(out.nodeId).toBe(head.id)
    expect(out.workflowSize).toBe(0)
  })
})

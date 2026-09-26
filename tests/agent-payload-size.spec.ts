import { describe, expect, it } from 'vitest'
import { advertiseTools, buildSystemPrompt, TOOLS } from '../src/background/agent'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_TOOL_NAMES,
  OPERATOR_CATEGORY_TOOL_NAMES,
} from '../src/lib/workflow/operator-categories'
import { JAVASCRIPT_BLOCK_ID, operatorToolName } from '../src/lib/workflow/operator-tools'
import { BUILT_IN_SKILLS } from '../src/lib/builtin-skills'
import type { BlockCategory } from '../src/lib/workflow/blocks/types'

/**
 * Pins the size of the agent payload. Every turn re-sends the system prompt plus
 * the advertised tool schemas, so bloated descriptions are paid on every single
 * round of every conversation. When you add a tool or expand descriptions, raise
 * a budget deliberately — and prefer deleting duplicated prose over growing it.
 *
 * Workflow generation used to be the cheap case: four operators outright, the
 * rest handed out by CATEGORY. That dispatch is what made the mode lose runs —
 * a step whose operator sat in an undeclared category stalled the turn on a
 * use_operators detour or the activate-and-retry penalty — so the mode now
 * advertises EVERY operator category from round one (the model may still narrow
 * the surface consciously via `use_operators`). The price is accepted
 * deliberately: round 1 measures ~59k chars (~17.9k tokens), roughly 3× full
 * auto, and only in this mode.
 *
 * Raised 18_000 → 20_000 when `present_plan` (the plan skill's approval
 * hand-off, ~1.2k schema) joined the always-advertised core: plan-first needs
 * the tool reachable in round one, not after a load_tools round trip.
 */
const MAX_ADVERTISED_PAYLOAD_CHARS = 20_000
/**
 * The full catalog (core + every on-demand group) must also stay bounded.
 * Raised 19_500 → 21_500 when the on-demand "delegate" group
 * (`delegate_to_agent`) was added, then → 24_500 when `create_scheduled_task`
 * joined the `ops` group (~2.3k schema), then → 25_500 when `present_plan`
 * (the plan skill's approval hand-off, ~1.2k schema) joined the core TOOLS.
 * The delegate schema stays OUT of the advertised budget above because the
 * group is only loaded via `load_tools({groups:['delegate']})`.
 */
const MAX_CATALOG_CHARS = 25_500
/**
 * Round 1 of a workflow conversation: the core tool set, EVERY operator
 * category (the round-1 default — see the file header), `use_operators`, the
 * workflow-specific `load_tools`, AND the mounted `workflow-generator` skill in
 * the system prompt (see {@link workflowSystemPrompt}). Measures ~57.3k
 * (~17.4k tokens) — the accepted price of never losing a run to an undeclared
 * category. Kept separate from MAX_WORKFLOW_ALL_CATEGORIES_PAYLOAD_CHARS (the
 * numbers coincide today) so a future round-1 trim does not have to move the
 * explicit-declaration ceiling and vice versa. Raised 58_000 → 59_500 when
 * prepare_workflow_goal and find_workflow_operators (the generation goal gate
 * and discovery engine) joined the round-1 core.
 */
const MAX_WORKFLOW_ROUND1_CHARS = 59_500
/**
 * The real per-round ceiling: one declared category on top of round 1. The
 * largest (`interaction`, 13 schemas) measures ~32.8k; the smallest (`data`)
 * ~28.3k. Raised 25_100 → 34_000 together with the round-1 budget (the mounted
 * operator guide), after the mode paragraph's duplicated prose was deleted.
 * Raised 34_000 → 35_500 together with the round-1 budget (required args).
 * Raised 35_500 → 37_000 when the generation goal and discovery tools joined.
 */
const MAX_WORKFLOW_CATEGORY_PAYLOAD_CHARS = 37_000
/**
 * The ceiling for the worst case the model can actually reach: every category
 * declared at once, which is the same set as `operators_author` (~42.9k of tool
 * schemas). It is an escape hatch, not a steady state, but it must not run away
 * either. Raised 46_700 → 56_000 together with the round-1 budget (the mounted
 * operator guide). Raised 56_000 → 58_000 together with the round-1 budget
 * (required args). Raised 58_000 → 59_500 when the generation goal and
 * discovery tools joined.
 */
const MAX_WORKFLOW_ALL_CATEGORIES_PAYLOAD_CHARS = 59_500
/**
 * Absolute worst case: every category plus both escape hatches loaded. Stays
 * loaded for the rest of the conversation, so this is a per-round cost, not a
 * one-off. Raised 48_000 → 57_500 together with the round-1 budget (the
 * mounted operator guide). Raised 57_500 → 59_500 together with the round-1
 * budget (required args). Raised 59_500 → 60_800 when the generation goal and
 * discovery tools joined.
 */
const MAX_WORKFLOW_FULL_PAYLOAD_CHARS = 60_800
/**
 * The guardrails that matter, expressed as ratios against full auto. Round 1
 * now deliberately carries EVERY operator schema, so workflow runs ~2.8× full
 * auto's tool surface and ~2.9× its total payload — the accepted price of not
 * losing runs to undeclared categories (see the file header). These ceilings
 * (measured 2.79 / 2.95) keep that price from silently creeping further.
 */
const MAX_WORKFLOW_TOOLS_RATIO = 3
const MAX_WORKFLOW_OVER_FULL_AUTO_RATIO = 3.2

/**
 * Workflow-generation turns mount the built-in `workflow-generator` skill into
 * the system prompt (see `modeSkill` in background/agent), so every workflow
 * measurement below passes it — the numbers must reflect what production sends,
 * not the bare prompt. Kept here once so the skill body and the budgets can
 * never drift apart silently.
 */
const WORKFLOW_MODE_SKILL = BUILT_IN_SKILLS.find(
  (skill) => skill.id === 'builtin-workflow-generator',
)
if (!WORKFLOW_MODE_SKILL) throw new Error('builtin-workflow-generator skill is missing')

const workflowSystemPrompt = (): string =>
  buildSystemPrompt({ mode: 'workflow', modeSkill: WORKFLOW_MODE_SKILL })

const workflowRound1 = () => advertiseTools({ mode: 'workflow' })
const workflowNames = (options: Parameters<typeof advertiseTools>[0]) =>
  advertiseTools(options).map((tool) => tool.function.name)

describe('first-turn agent payload size (full auto)', () => {
  it('stays under the advertised-payload budget', () => {
    const system = buildSystemPrompt({ mode: 'full' })
    const tools = JSON.stringify(advertiseTools({ mode: 'full' }))

    console.log(
      `[payload-size] advertised: system=${system.length} tools=${tools.length} ` +
        `total=${system.length + tools.length} chars (~${Math.round((system.length + tools.length) / 3.3)} tokens @ ~3.3 chars/token)`,
    )
    expect(system.length + tools.length).toBeLessThanOrEqual(MAX_ADVERTISED_PAYLOAD_CHARS)
  })

  it('keeps the full tool catalog bounded', () => {
    const catalog = JSON.stringify(TOOLS).length

    console.log(`[payload-size] full catalog (all groups): ${catalog} chars`)
    expect(catalog).toBeLessThanOrEqual(MAX_CATALOG_CHARS)
  })
})

describe('first-turn agent payload size (workflow generate)', () => {
  it('advertises every operator category before anything is declared', () => {
    const names = workflowNames({ mode: 'workflow' })
    const operators = names.filter((name) => name.startsWith('wf_op_'))
    const expected = ADVERTISABLE_OPERATOR_CATEGORIES.flatMap(
      (category) => OPERATOR_CATEGORY_TOOL_NAMES[category],
    )
    expect([...operators].sort()).toEqual([...expected].sort())
    // The core four ride along in the workflow core set.
    for (const name of CORE_OPERATOR_TOOL_NAMES) expect(names).toContain(name)
    // The native action tools are gone for good: they record nothing, so using
    // one produces an empty draft and the mode has no workflow to offer.
    for (const name of ['click', 'fill', 'open_url', 'press_key']) {
      expect(names).not.toContain(name)
    }
  })

  it('stays under the round-1 budget', () => {
    const system = workflowSystemPrompt()
    const tools = JSON.stringify(workflowRound1())
    const total = system.length + tools.length

    console.log(
      `[payload-size] workflow round 1: categories=${ADVERTISABLE_OPERATOR_CATEGORIES.length} ` +
        `system=${system.length} tools=${tools.length} total=${total} chars ` +
        `(~${Math.round(total / 3.3)} tokens)`,
    )
    expect(total).toBeLessThanOrEqual(MAX_WORKFLOW_ROUND1_CHARS)
  })

  it('stays under the budget with any single category declared', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      const system = workflowSystemPrompt()
      const tools = JSON.stringify(
        advertiseTools({ mode: 'workflow', activeOperatorCategories: new Set([category]) }),
      )
      const total = system.length + tools.length
      console.log(
        `[payload-size] workflow + ${category}: n=${OPERATOR_CATEGORY_TOOL_NAMES[category].length} ` +
          `tools=${tools.length} total=${total}`,
      )
      expect(total).toBeLessThanOrEqual(MAX_WORKFLOW_CATEGORY_PAYLOAD_CHARS)
    }
  })

  it('stays bounded with every category declared at once', () => {
    const system = workflowSystemPrompt()
    const tools = JSON.stringify(
      advertiseTools({
        mode: 'workflow',
        activeOperatorCategories: new Set(ADVERTISABLE_OPERATOR_CATEGORIES),
      }),
    )
    const total = system.length + tools.length

    console.log(`[payload-size] workflow + ALL categories: tools=${tools.length} total=${total}`)
    expect(total).toBeLessThanOrEqual(MAX_WORKFLOW_ALL_CATEGORIES_PAYLOAD_CHARS)
  })

  it('stays bounded once both escape hatches are loaded', () => {
    const system = workflowSystemPrompt()
    const tools = JSON.stringify(
      advertiseTools({
        mode: 'workflow',
        activeOperatorCategories: new Set(ADVERTISABLE_OPERATOR_CATEGORIES),
        loadedGroups: new Set(['operators_author', 'operators_escape']),
      }),
    )
    const total = system.length + tools.length

    console.log(`[payload-size] workflow + everything: tools=${tools.length} total=${total}`)
    expect(total).toBeLessThanOrEqual(MAX_WORKFLOW_FULL_PAYLOAD_CHARS)
  })

  it('round-1 default equals the every-category surface', () => {
    // The round-1 default IS the deliberate design: nothing hidden. If these
    // two surfaces ever diverge, either a category lost its default visibility
    // or an explicit declaration stopped being exact.
    const round1 = [...workflowNames({ mode: 'workflow' })].sort()
    const declaredAll = [
      ...advertiseTools({
        mode: 'workflow',
        activeOperatorCategories: new Set(ADVERTISABLE_OPERATOR_CATEGORIES),
      }).map((tool) => tool.function.name),
    ].sort()
    expect(round1).toEqual(declaredAll)
  })

  /**
   * The cost of the default is accepted, but it must stay BOUNDED and known:
   * workflow round 1 carries every operator schema, so it runs ~2.8× full
   * auto's tool surface and ~2.9× its total payload. The ceilings below pin
   * that tradeoff (measured 2.79 / 2.95); a change that pushes past them needs
   * a deliberate budget decision, same as the absolute budgets above.
   */
  it('round-1 tool surface stays within the accepted multiple of full auto', () => {
    const fullTools = JSON.stringify(advertiseTools({ mode: 'full' })).length
    const workflowTools = JSON.stringify(workflowRound1()).length
    const ratio = workflowTools / fullTools

    console.log(
      `[payload-size] workflow/full round-1 tool-schema ratio: ${ratio.toFixed(3)} ` +
        `(workflow=${workflowTools} full=${fullTools})`,
    )
    expect(ratio).toBeLessThanOrEqual(MAX_WORKFLOW_TOOLS_RATIO)
  })

  it('round-1 total payload stays within the accepted multiple of full auto', () => {
    const full =
      buildSystemPrompt({ mode: 'full' }).length +
      JSON.stringify(advertiseTools({ mode: 'full' })).length
    const workflow = workflowSystemPrompt().length + JSON.stringify(workflowRound1()).length

    console.log(
      `[payload-size] workflow/full round-1 total ratio: ${(workflow / full).toFixed(3)} ` +
        `(workflow=${workflow} full=${full})`,
    )
    expect(workflow / full).toBeLessThanOrEqual(MAX_WORKFLOW_OVER_FULL_AUTO_RATIO)
  })

  it('never advertises a duplicate tool name', () => {
    // The core four are also members of `op_interaction`, so a naive union
    // repeats them — and a provider rejects a tool list with duplicate names.
    const sets: BlockCategory[][] = [
      [],
      ['interaction'],
      ['data'],
      [...ADVERTISABLE_OPERATOR_CATEGORIES],
    ]
    for (const categories of sets) {
      const names = workflowNames({
        mode: 'workflow',
        activeOperatorCategories: new Set(categories),
      })
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('keeps the JavaScript escape hatch out until it is explicitly loaded', () => {
    const escapeTool = operatorToolName(JAVASCRIPT_BLOCK_ID)
    const categories = new Set(ADVERTISABLE_OPERATOR_CATEGORIES)

    expect(workflowNames({ mode: 'workflow' })).not.toContain(escapeTool)
    // Declaring every category must not smuggle it in.
    expect(workflowNames({ mode: 'workflow', activeOperatorCategories: categories })).not.toContain(
      escapeTool,
    )
    expect(
      workflowNames({ mode: 'workflow', loadedGroups: new Set(['operators_author']) }),
    ).not.toContain(escapeTool)
    expect(
      workflowNames({ mode: 'workflow', loadedGroups: new Set(['operators_escape']) }),
    ).toContain(escapeTool)
  })

  it('keeps every category reachable, so nothing is silently unreachable', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      const names = workflowNames({
        mode: 'workflow',
        activeOperatorCategories: new Set([category]),
      })
      for (const name of OPERATOR_CATEGORY_TOOL_NAMES[category]) expect(names).toContain(name)
      // …and declaring one category does not drag in another.
      for (const other of ADVERTISABLE_OPERATOR_CATEGORIES) {
        if (other === category) continue
        const foreign = OPERATOR_CATEGORY_TOOL_NAMES[other].filter(
          (name) => !CORE_OPERATOR_TOOL_NAMES.includes(name),
        )
        for (const name of foreign) expect(names).not.toContain(name)
      }
    }
  })
})

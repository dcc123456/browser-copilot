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
 * Workflow generation is the interesting case. All 54 operator schemas are
 * ~32.4k chars on their own; advertising them every round is what made the old
 * mode cost ~50k chars per round and pushed a 10-step task into its 20-round
 * cap. The mode now advertises four operators outright and hands out the rest by
 * CATEGORY, so the budget that matters is "one category at a time".
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
 * Round 1 of a workflow conversation: the core tool set, the core four
 * operators, `use_operators`, the workflow-specific `load_tools`, AND the
 * mounted `workflow-generator` skill in the system prompt (see
 * {@link workflowSystemPrompt}). Measured ~24.1k. Raised 16_500 → 25_000 when
 * the operator guide started riding in the system prompt: the mode paragraph
 * was trimmed to pure mechanics (dedupe), and the guide is the one place the
 * action→operator mapping, the data rules and the keep/drop criteria live.
 */
const MAX_WORKFLOW_PAYLOAD_CHARS = 25_000
/**
 * The real per-round ceiling: one declared category on top of round 1. The
 * largest (`interaction`, 13 schemas) measures ~32.8k; the smallest (`data`)
 * ~28.3k. Raised 25_100 → 34_000 together with the round-1 budget (the mounted
 * operator guide), after the mode paragraph's duplicated prose was deleted.
 */
const MAX_WORKFLOW_CATEGORY_PAYLOAD_CHARS = 34_000
/**
 * The ceiling for the worst case the model can actually reach: every category
 * declared at once, which is the same set as `operators_author` (~42.9k of tool
 * schemas). It is an escape hatch, not a steady state, but it must not run away
 * either. Raised 46_700 → 56_000 together with the round-1 budget (the mounted
 * operator guide).
 */
const MAX_WORKFLOW_ALL_CATEGORIES_PAYLOAD_CHARS = 56_000
/**
 * Absolute worst case: every category plus both escape hatches loaded. Stays
 * loaded for the rest of the conversation, so this is a per-round cost, not a
 * one-off. Raised 48_000 → 57_500 together with the round-1 budget (the
 * mounted operator guide).
 */
const MAX_WORKFLOW_FULL_PAYLOAD_CHARS = 57_500
/**
 * The guardrails that matter, expressed as ratios against full auto: the tool
 * surface of round 1 must be meaningfully SMALLER (the whole point of the
 * dispatch) — that guard is unchanged. The total-cost ratio was raised
 * 0.95 → 1.4 because workflow now carries the operator guide in its system
 * prompt while full auto does not; the tool-surface ratio above still guards
 * the dispatch mechanism itself.
 */
const MAX_WORKFLOW_TOOLS_RATIO = 0.75
const MAX_WORKFLOW_OVER_FULL_AUTO_RATIO = 1.4

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
  it('advertises only the core four operators before anything is declared', () => {
    const names = workflowNames({ mode: 'workflow' })
    const operators = names.filter((name) => name.startsWith('wf_op_'))
    expect([...operators].sort()).toEqual([...CORE_OPERATOR_TOOL_NAMES].sort())
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
      `[payload-size] workflow round 1: core=${CORE_OPERATOR_TOOL_NAMES.length} ` +
        `system=${system.length} tools=${tools.length} total=${total} chars ` +
        `(~${Math.round(total / 3.3)} tokens)`,
    )
    expect(total).toBeLessThanOrEqual(MAX_WORKFLOW_PAYLOAD_CHARS)
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

  /**
   * The regression this whole change exists to prevent. The mode used to
   * advertise all 54 operator schemas on every round; if its round-1 tool
   * surface creeps back toward full auto's, an operator tier has quietly
   * returned to the every-round advertisement.
   */
  it('advertises a round-1 tool surface well under full auto’s', () => {
    const fullTools = JSON.stringify(advertiseTools({ mode: 'full' })).length
    const workflowTools = JSON.stringify(workflowRound1()).length
    const ratio = workflowTools / fullTools

    console.log(
      `[payload-size] workflow/full round-1 tool-schema ratio: ${ratio.toFixed(3)} ` +
        `(workflow=${workflowTools} full=${fullTools})`,
    )
    expect(ratio).toBeLessThanOrEqual(MAX_WORKFLOW_TOOLS_RATIO)
  })

  it('costs no more per round than full auto', () => {
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

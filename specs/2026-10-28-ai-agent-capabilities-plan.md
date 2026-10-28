# AI-agent block: per-node skill/tool switches and a tool-free answer contract

Date: 2026-10-28
Status: implemented

## Request

1. The workflow `ai-agent` block gets capability switches for skills and tools
   so a node pays only for what it needs.
2. A node sometimes answers and then keeps calling tools to "compute" the same
   answer again, burning time and tokens. Make that stop.
3. The block must not use tools that change state outside the page it automates:
   `tab_close`, `pin_tab`, `unpin_tab`, `save_local`, `create_skill`,
   `list_scheduled_tasks`, `create_scheduled_task`, `present_plan`,
   `delegate_to_agent`.
4. Skills are **off by default** for new nodes and the author enables what the
   step needs; workflows saved before this change keep every skill on.

## Part 1 — skills and tools are selectable per node

### Two list shapes, on purpose

- **Tools** stay a deny list (`disabledTools`): the default is "all on", so a
  tool shipped later must not be silently absent from old nodes. This matches
  the global settings switch (`Settings.disabledTools`).
- **Skills** are an allowlist (`enabledSkills`): the default for a new node is
  "no skills", because most steps need none and the catalogue is prompt cost.
  An **absent** key means the legacy all-on path (nodes saved before the
  switch), an **empty array** means none, and a listed set is exactly what the
  turn may load.

The two must stay distinguishable, so the executor reads the raw node value:
`undefined` → omit the option; `[]` → forward an empty allowlist.

`migrateNodeData` merges catalog defaults into stored data, which would
backfill `enabledSkills: []` into old nodes and switch their skills off. The
migration therefore deletes the backfilled key when the **stored** data has no
key — the same stored-vs-merged test `paths` uses for legacy `conditions`
nodes. A node keeps all skills on until its author edits the list.

Generated nodes (`appendOperatorNode`) copy only the model's args, so the
append primitive writes `enabledSkills: []` for an `ai-agent` node unless the
model supplied a list.

### Runtime path

- `ai-agent` executor reads the node data and hands
  `options.disabledTools` + `options.enabledSkills` to `runUnattendedPrompt`.
  The tool list always includes the forbidden floor (Part 3).
- `runUnattendedPrompt` merges the node's disabled tools with the global
  `settings.disabledTools` (the user's global switch still wins) and passes both
  lists through `getToolConfig`; an empty allowlist is forwarded, not dropped.
- `runAgentTurn`:
  - the tool deny set feeds `advertiseTools`, so a disabled tool's schema never
    enters the request and the dispatch layer still refuses a hallucinated call;
  - the skill allowlist filters the catalogue before `buildSystemPrompt`, so a
    non-enabled skill costs no catalogue line (`use_skill` off and an empty
    allowlist both collapse to "no catalogue");
  - `use_skill` refuses a name outside the allowlist at execution time (defence
    in depth) and its "available" hint lists only allowlisted skills.

Names are compared case-insensitively, matching `validateSkill`'s uniqueness
rule.

### UI

`EditAiAgent` renders a "Skills & tools" fold-out, collapsed by default:

- every saved skill (`skills.list`) except the manual-only `plan`; a new node
  renders all unchecked, a legacy node (no key) renders all checked. Toggling a
  legacy node off materialises the full list minus that name;
- every tool in `TOOL_META` that an unattended turn can actually call, checked.
  Bridge-only tools (generation/repair/reload), the forbidden set (Part 3),
  `ask_user` (withheld when there is no panel) and `compose_workflow`
  (workflow-generation only) are hidden — offering a switch for a tool that can
  never appear would be a lie;
- unchecking a tool writes the name into the node's deny list; toggling a skill
  writes the allowlist;
- a note states both defaults and the request-size consequence, and a failed
  `skills.list` shows a retry instead of pretending no skills exist.

Labels and notes are bilingual in the editor's block-form dictionary.

## Part 2 — stop tool calls after the answer is known

The loop's actual contract is: **a round with tool calls is work in progress;
the turn ends on the first round with no tool calls.** Text streamed next to a
tool call is narration and is discarded (`agent-unattended` keeps only the
final round's text). The workflow prompt never said this, so a model could print
the answer, then call a tool "to confirm" — and the run paid another round
(and had to answer again).

`buildAgentPrompt` now states the contract and the stop rule:

- the final answer must be written in a response with **no tool calls**;
- do not call a tool to double-check, recompute or confirm a result already in
  hand (including arithmetic the model can do itself, the element text, or an
  earlier tool result);
- call a tool only when a fact still needed is missing.

This is prompt-level, not a heuristic in the loop: the runtime cannot tell a
real answer from narration in a mixed round, and the existing answer-assembly
tests deliberately refuse to launder narration into the output variable. The
node's tool switches (Part 1) are the complementary hard lever — a content node
that needs no page access can switch every tool off.

## Part 3 — tools a workflow run may never use

`AI_AGENT_FORBIDDEN_TOOLS` (in `lib/tool-catalog`, chrome-free, shared by the
editor and the executor) lists nine tools whose effects outlive the run or
need an approval a run cannot supply:

- `tab_close`, `pin_tab`, `unpin_tab` — rewrite the user's browser layout;
- `save_local` — writes files outside workflow state;
- `create_skill`, `list_scheduled_tasks`, `create_scheduled_task` — read or
  mutate stores that outlive the run;
- `present_plan` — waits for interactive approval;
- `delegate_to_agent` — fans out into sub-agents (unattended turns never
  enable delegation).

The block form hides them, and the executor unions the set into every run's
`disabledTools`, so a stale authored list or a hallucinated call is refused at
dispatch rather than merely unadvertised.

## Verification

- unit: executor always includes the forbidden floor, forwards/omits
  `enabledSkills` (`[]` vs absent), and a generated node carries `[]`;
  migration deletes the backfilled allowlist for legacy nodes; unattended
  forwards an empty allowlist; agent filters the catalogue, refuses
  `use_skill` outside the allowlist, and keeps the finish rule;
- component: new node renders skills unchecked, legacy node renders them
  checked, toggles write the expected lists, forbidden tools are absent;
- real Chrome: open a new `ai-agent` node (skills unchecked) and a legacy one
  (skills checked), toggle and save, reopen — the state persists; confirm the
  forbidden tools are not listed.

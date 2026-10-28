# AI-agent block: per-node skill/tool switches and a tool-free answer contract

Date: 2026-10-28
Status: implemented

## Request

1. The workflow `ai-agent` block gets an enable list for skills and tools. All
   are enabled by default; the author can switch individual ones off to cut the
   tokens each run pays for.
2. A node sometimes answers and then keeps calling tools to "compute" the same
   answer again, burning time and tokens. Make that stop.

## Part 1 — skills and tools are selectable per node

### Why a deny list, not an allow list

The node stores the names it switched **off** (`disabledTools`,
`disabledSkills`), not the ones left on. An allow list would silently exclude
every tool or skill added after the workflow was authored — the default is "all
on", and a stored list of enabled names cannot express that. The settings tab
already models its global tool switch the same way (`Settings.disabledTools`).

Empty/absent lists mean "nothing disabled", so old nodes need no migration;
the catalog defaults are `[]` only so the editor can read the key without a
special case.

### Runtime path

- `ai-agent` executor reads both arrays from node data and hands them to
  `runUnattendedPrompt` as `options.disabledTools` / `options.disabledSkills`.
- `runUnattendedPrompt` merges the node's disabled tools with the global
  `settings.disabledTools` (the user's global switch still wins) and passes both
  lists through `getToolConfig`.
- `runAgentTurn`:
  - the tool deny set feeds `advertiseTools`, so a disabled tool's schema never
    enters the request and the dispatch layer still refuses a hallucinated call;
  - the skill deny set filters the catalogue before `buildSystemPrompt`, so a
    disabled skill costs no catalogue line and cannot be loaded;
  - `use_skill` refuses a disabled name at execution time (defence in depth) and
    its "available" hint omits disabled skills;
  - when `use_skill` itself is disabled, the whole skill catalogue is dropped —
    a list of skills the model cannot load is pure prompt cost.

Names are compared case-insensitively, matching `validateSkill`'s uniqueness
rule.

### UI

`EditAiAgent` renders a "Skills & tools" fold-out, collapsed by default:

- every saved skill (`skills.list`) except the manual-only `plan`, checked;
- every tool in `TOOL_META` that an unattended turn can actually call, checked.
  Bridge-only tools (generation/repair/reload), `ask_user` (withheld when there
  is no panel) and `compose_workflow` (workflow-generation only) are hidden —
  offering a switch for a tool that can never appear would be a lie;
- unchecking writes the name into the node's disabled list, checking removes it;
- a note states the consequence (request size), and a failed `skills.list` shows
  a retry instead of pretending no skills exist.

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

## Verification

- unit: executor forwards/omits both lists; unattended merges global + node
  tool denies; agent drops disabled skills from the prompt and refuses
  `use_skill`; format prompt contains the finish rule;
- component: picker renders checked by default, toggling writes the expected
  node data, stored disabled names render unchecked;
- real Chrome: open a `ai-agent` node, toggle a tool and a skill, save, reopen —
  the switches persist; run a node with `snapshot_page` disabled and confirm the
  tool is absent from the request.

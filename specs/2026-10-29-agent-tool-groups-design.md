# Agent tool groups — classify the page tools like the operator categories

Status: implemented (this date)
Area: `src/background/agent.ts`, `src/lib/system-prompt.ts`, `tests/agent-tool-groups.spec.ts`

## Request

「这个项目的工具也应该像工作流算子工具那样进行分类 不要把全部工具都一次塞到提示词中
导致 token 消耗很大 但是要保证工具调用不能出错」

Every agent round re-sends the system prompt plus the advertised tool schemas. Full
auto advertised 18 schemas (~15.7k chars, ~4.8k tokens) on every round; a long chat
turn (the 100-request turn from
`specs/2026-10-27-chat-turn-resilience-design.md`) paid that ~450 times.

## Evidence (measured, `tests/agent-payload-size.spec.ts` + `tmp/` probe)

Round 1 of full auto before this change: system 4,200 + tools 15,663 = 19,863 chars
(~6.0k tokens). Per-schema sizes:

| tool          | chars |     | tool                  | chars |
| ------------- | ----: | --- | --------------------- | ----: |
| fill          |  1582 |     | run_plan              |   781 |
| scroll        |  1381 |     | load_tools            |   778 |
| click         |  1266 |     | recognize_image       |   671 |
| select_option |  1187 |     | run_javascript        |   547 |
| press_key     |  1182 |     | screenshot            |   484 |
| wait_for      |  1166 |     | read_selected_element |   428 |
| present_plan  |  1159 |     | open_url              |   321 |
| set_checkbox  |  1149 |     | snapshot_page         |   318 |
| ask_user      |   966 |     | read_current_page     |   278 |

The locator block (`target` + its `spec` `$defs`) is ~700 chars inside every action
schema; it cannot be shared across tools because each tool's parameters must be
self-contained for the OpenAI-compatible wire format.

## Decision

Reuse the EXISTING on-demand group mechanism (`TOOL_GROUPS` + `load_tools` +
auto-load on a stray call). No second dispatch mechanism: workflow mode already has
`use_operators`, and AGENTS.md §5.6 forbids a second infrastructure of the same kind.

New groups (conversation-scoped, accumulate like `tabs`/`data`):

- `forms`: `select_option`, `set_checkbox` (2,336 chars)
- `flow`: `scroll`, `wait_for` (2,547 chars)
- `keys`: `press_key` (1,182 chars)
- `vision`: `screenshot`, `recognize_image` (1,155 chars)
- `script`: `run_javascript` (547 chars)

Core stays the universal browse loop: `read_current_page`, `snapshot_page`,
`read_selected_element`, `click`, `fill`, `open_url`, `run_plan`, `present_plan`,
`ask_user`, `load_tools`. Measured round 1 after the change: 10 schemas,
8,091 chars; system prompt 4,317; total 12,408 (~3.8k tokens) — 37.5% below the
19,863 before it, paid on every round of every conversation. The first group
load costs at most one round per conversation.

The whole catalog is unchanged in size (32,229 — the same schemas, filed
differently, plus ~200 chars naming the groups in `load_tools`' description).
Workflow round 1 stays at 62,793; its ratio against full auto rose from 3.08 to
5.85 purely because the denominator shrank — no workflow schema was added.

## Why calls still cannot fail

1. **A stray call self-heals.** Dispatch already auto-loads the owning group and
   answers `"<tool>" was not loaded: its "<group>" tool group has been auto-loaded
now … Call "<tool>" again immediately — do not tell the user you lack tools.`
   The tool then executes on the retry (`runOneToolCall` gate above `executeTool`).
2. **`run_plan` bypasses the gate.** Inner steps call `executeTool` directly and
   validate names against the full `TOOLS` catalog, so a batched plan can still
   drive a grouped tool without spending a load round.
3. **Runtime mode gates are unchanged.** Read-only/chat refusals are enforced at
   dispatch (`isPageAction`), not by advertisement, so a hidden tool that is
   called anyway cannot mutate the page.
4. **Vision reads stay immediately available where they were promised.**
   `readonly` turns keep `screenshot` / `recognize_image` advertised (an image
   `ai-agent` block must not flail), and workflow mode keeps them core because
   its own `load_tools` menu cannot widen to page-edit groups.
5. **A workflow-mode stray cannot "load" a group it will never be offered.**
   `WORKFLOW_WITHHELD_TOOLS` (native click/fill/scroll/press_key/save_local/…)
   is now refused at dispatch, before the group gate, with a pointer to the
   recording operator. Before this, such a call would have executed unrecorded;
   with the new groups it would first auto-load `flow`/`keys` and then claim a
   retry that can never be advertised.

## Real-browser evidence (2026-10-29, built `dist/`, Chromium channel)

`tmp/tool-groups-probe.mjs` (fake SSE model, real extension, real page):
`PASS` on all nine checks — round 1 = 10 tools / 8,091 chars with no
`scroll`/`press_key`/`select_option`/`screenshot`/`run_javascript`; a stray
`scroll` call answered with the `flow` auto-load hint; the retry round
advertised `scroll`; the retried call returned `ok:true`, `window.scrollY > 0`,
and the panel showed the final answer.

`tmp/turn-resilience-probe.mjs` still passes 8/8 with `run_javascript` inside
the `script` group (the auto-load round precedes the failure-streak checks).

## Rejected alternatives

- **`use_tools` with REPLACE semantics (a copy of `use_operators`).** A second
  mechanism with its own store, dispatch branch and tests, for the same effect.
  Workflow mode's history also shows the cost of category narrowing: runs stalled
  on declaration detours, which is why round 1 there advertises everything.
  Accumulating groups cannot strand a model mid-task.
- **One merged `page_action` tool with an action enum.** Collapses ~8.9k chars of
  locator boilerplate into one schema, but changes every tool name in transcripts,
  prompts, tests and workflow recordings — a far larger blast radius than the
  token problem justifies.
- **Trimming the locator schema.** The `target`/`spec` fallbacks are what let a
  stale ref recover without a new snapshot; deleting them trades reliability for
  the same tokens this change saves structurally.

## Budgets

`tests/agent-payload-size.spec.ts` pins the new numbers: full auto round 1
≤ 12.6k chars total, and the workflow/full ratios re-based because the full-auto
baseline shrank (the absolute workflow caps are the real guard and stay put).

## Settings list grouped by loading group (follow-up, 2026-10-29)

The Settings → Tools list used to be one flat run of 40 switches. It now renders
one section per on-demand loading group, in load order: **Always on** (the core
loop + `load_tools`), Tabs, Files & saved data, Skills, Diagnostics & schedules,
Forms & choices, Scrolling & waits, Keyboard, Images & OCR, Scripts, Delegation,
then **Workflow & developer** (`compose_workflow` + bridge-only tools, i.e.
everything the workflow mode advertises but `load_tools` never offers).

- **Single source.** `TOOL_GROUPS` moved from `src/background/agent.ts` to the
  chrome-free `src/lib/tool-groups.ts`; the background imports it and
  `src/lib/tool-catalog.ts` derives `TOOL_SECTIONS` from the same constant. No
  second hand-maintained group list exists, so a tool that changes group moves
  in the UI automatically. `tests/tool-config.spec.ts` asserts every `TOOL_META`
  entry appears in exactly one section and that core/workflow membership matches
  the advertised sets.
- **Only the grouping changed.** Every switch keeps its `disabledTools` write
  path and its per-tool label/warning; the header total and the enable-all /
  disable-all buttons still count `TOOL_META`.
- **Copy.** Twelve new bilingual headings (`settingsToolGroup*`), a singular-aware
  `settingsToolGroupCount` ("1 tool" / "3 tools" / "1 个工具"), and a rewritten
  `settingsToolsHint` that explains load-on-first-use instead of plain enablement.

Real-browser evidence: `tmp/settings-tool-sections-probe.mjs` loads the built
`dist/` in Chromium, opens Settings → Tools, and `PASS`es 9/9 — 12 headings in
order under both `en` and `zh-CN`, 40 switches across the sections (10 Always on
… 5 Workflow & developer), per-section counts, and toggling the Keyboard switch
persists `press_key` into `disabledTools` (restored afterwards).

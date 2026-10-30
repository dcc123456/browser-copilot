# Side panel / workflow editor UI polish · plan

Date: 2026-10-30
Status: implementing

## Scope (dcc's seven items)

1. Top-of-panel notices (workflow publish, run result, task result, …) must be
   manually dismissible.
2. Workflows tab: the "add workflow" menu opens on hover today — it must open on
   click only.
3. Workflow editor · while-loop block: the "Edit condition" entry and the
   condition builder differ from Automa; the value control and the input below
   it are flush.
4. Workflow editor · conditions block: the "Add path" surface looks unlike
   Automa.
5. Workflow editor · log-data block: pick the workflow from a dropdown instead
   of pasting an id.
6. History tab · run log: the record title (task / workflow name) is truncated
   with no way to read it in full — hover must reveal it.
7. Tokens tab: workflow rows must read as the workflow name (never the id) and
   hover must reveal the full name.

## Evidence (Automa parity)

Fetched from `AutomaApp/automa@master` on 2026-10-30:

- `components/newtab/shared/SharedConditionBuilder/index.vue`
- `components/newtab/shared/SharedConditionBuilder/ConditionBuilderInputs.vue`
- `components/newtab/workflow/edit/EditWhileLoop.vue`
- `components/newtab/workflow/edit/EditConditions.vue`
- `components/newtab/workflow/edit/EditLogData.vue`

Findings used here:

- A condition row is `flex flex-wrap items-end space-x-2`: the value-type
  select sits **left of** its input, not above it. That is the missing gap dcc
  sees. AND groups get a left rail with a blue badge; OR groups are separated by
  a line + indigo badge.
- While-loop exposes a **full-width accent** "Edit condition" button and keeps
  no summary row; the condition tree lives in a modal.
- EditConditions shows an accent "Add path" button above a plain list; the list
  is not wrapped in a second card.
- EditLogData selects from the workflow store (`getWorkflows`, sorted by name);
  this is exactly what `EditExecuteWorkflow` already does through
  `workflows.list` in this repo.

## Decisions

- **One shared `Banner`** (`sidepanel/components/Banner.tsx`) replaces the nine
  hand-written `.banner` blocks. It renders the existing `.banner` /
  `.banner-link` / `.banner-text` class names (tests pin them) plus a Tailwind
  close button and one new bilingual string `bannerDismiss`. Dismissal stays
  owned by the caller (`setBanner(null)`), so a new message is never swallowed.
- **Workflow picker** is extracted from `EditExecuteWorkflow` into
  `blocks/shared/WorkflowPicker.tsx` and reused by `EditLogData` (§5.2: second
  occurrence). It keeps the reload button, the "no workflows yet" hint and the
  stored-id-preserved option.
- **Condition rendering** keeps every existing affordance (inline path rename,
  move buttons, edit modal, AND/OR buttons) because
  `tests/conditions-path-form.spec.tsx` pins them; only the visual layer moves
  to Automa's rail/badge/horizontal-input layout. Inline hex colours are
  replaced with semantic tokens (§2).
- **Tokens / History hover**: the tooltip is the full display name (not the
  raw `kind:id` key and not the jump hint). The jump affordance stays on the
  row itself.

## Files

- `src/lib/i18n.ts` — `bannerDismiss`.
- `src/sidepanel/components/Banner.tsx` — new shared notice.
- `src/sidepanel/{WorkflowsTab,TasksTab,HistoryTab,AgentsTab,SkillsTab,DataTab,ModelsTab,SettingsTab,MarketplaceTab}.tsx`.
- `src/workflow-editor/blocks/shared/PopupField.tsx` — button trigger variant.
- `src/workflow-editor/blocks/batchC/{ConditionBuilder,EditWhileLoop,EditConditions,EditLogData}.tsx`.
- `src/workflow-editor/blocks/shared/WorkflowPicker.tsx` (new) +
  `batchC/EditExecuteWorkflow.tsx` — share the dropdown.
- `src/workflow-editor/i18n.ts` — new block-form strings.
- `tests/token-board-naming.spec.tsx` — hover now carries the name.

## Verification

- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm build`.
- Real browser: load unpacked extension, open the panel and the editor; exercise
  each of the seven items (steps reported in the handoff).

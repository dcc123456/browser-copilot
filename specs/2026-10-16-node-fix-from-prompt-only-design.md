# AI Fix from a prompt only — design

Date: 2026-10-16 · Area: workflow-editor AI Fix (per-node) · Status: implemented

## 1. The ask

> 算子中的 AI 修复弹窗 功能 支持用户仅使用提示词就能执行修复。比如用户提供了报错日志，
> 就可以不用根据目标和成功条件来执行修复。

Ruling (dialog): **「报错日志 + 本次临时判据」** — the repair runs from the user's prompt and
the failure output, and success is judged by a criterion that exists **only for this repair**.

Today the loop refuses outright (`node-fix-engine.ts`: `This node has no goal contract…`), and
the dialog's confirm button is disabled until the operator fills in a goal plus at least one
success criterion. That makes AI Fix unusable on the most common case: a hand-built node that
just failed in a run, where the user has the error text and knows what they want, but never
authored a contract.

## 2. What the temporary criterion is

One `WorkflowCondition` — the same vocabulary the persisted contract uses (`elementExists`,
`elementText`, `elementValue`, `urlMatches`, …) — **authored by the model inside its repair
reply** and evaluated by the existing condition runtime against the live page.

```json
{ "rationale": "…", "data": { …full params… }, "verify": { "kind": "elementValue", "target": { "selector": "#search" }, "expectation": "notEmpty" } }
```

The row is spelled with `kind`, the same key the persisted contracts and the
operator guide already use (`operator-guide.ts` teaches `{kind:'urlContains',…}`),
because `isWorkflowCondition` whitelists on `kind` and would drop a `type` row.

Properties that make it safe:

- **Machine-checked, not model-claimed.** `verify` is handed to `evaluateCriteria`, i.e. the
  page is the arbiter. The model only states how success will be recognised; it cannot vote.
- **Ephemeral.** It lives in the loop's local `workingCriteria` array. It is never written into
  `blockData`, so it never reaches `__workflowAi`, the saved workflow, or the AI-operator schema
  (`NODE_FIX_RESERVED_KEYS` still strips the namespace from every reply).
- **Replaced, not accumulated.** Each reply's `verify` supersedes the previous round's, so the
  check always describes the parameters that are about to be trial-run.
- **Optional.** A reply without a usable `verify` is still valid; see §4.

Parsing goes through the existing tolerant reader `workflowConditionsOf([raw])`, which drops
malformed rows — so a hallucinated criterion silently means "no criterion", never a crash and
never a fake pass.

## 3. When the loop may run at all

| Node has a contract | Prompt or error log | Runs?  | What judges success                                   |
| ------------------- | ------------------- | ------ | ----------------------------------------------------- |
| yes                 | any                 | yes    | the persisted `successCriteria` (unchanged behaviour) |
| no                  | yes                 | yes    | the temporary criterion, else exec-only (§4)          |
| no                  | no                  | **no** | refusal: there is nothing to repair towards           |

The refusal is the one thing that must stay: a prompt-less, contract-less fix would be an
unbounded "make the node do something" request with no way to call the result good.

## 4. No criterion at all: `exec-only`, said out loud

If nothing in the run ever yields a verifiable criterion, a trial run that does not throw is the
strongest available evidence. Settling on it is acceptable **only if it is labelled**, so the
result carries `verifiedBy: 'criteria' | 'exec-only'`:

- `criteria` — the operator ran without error AND every criterion (persisted or temporary) held.
  The dialog keeps saying 全部成功条件均满足.
- `exec-only` — the operator ran without error, and **no page criterion was available**. The
  dialog says exactly that and tells the user to confirm the effect themselves.

This keeps the repo's no-fake-success line: the engine never reports that criteria were verified
when there were none, and the acceptance suite pins the wording difference.

## 5. Prompt shape without a contract

`buildNodeFixPrompt` states a target section in both cases; only its source differs.

- Contract: `Goal:` = contract goal, `Success criteria:` = persisted criteria.
- Prompt-only: `Goal (as stated by the user — this node has no stored contract):` = the user's
  prompt, and the criteria list is either the temporary `verify` in force or an explicit
  `none yet — you MUST return a "verify" object with the parameters` instruction. Making the
  model author the check is part of the ask, not an extra round: it rides the same reply.
- A pasted error log is appended as its own section (`## Error log from the failed run`) so it is
  not confused with the user's intent, and it is length-capped like every other string.

## 6. Rejected alternatives

- **Write a temporary contract into `node.data` and delete it afterwards.** The editor's node data
  is the persisted artifact; a mid-run cancel, a crash or a closed tab leaves a synthetic goal
  contract in the user's workflow. Rejected: mutation risk for zero benefit.
- **Judge the run by the prompt text** ("the model says the goal is met"). Not machine-checkable —
  it is the fake-success pattern the acceptance suite already forbids.
- **Require the user to build the criterion in the dialog** (embed `ConditionEditor`). That puts a
  structured prerequisite in front of a feature that must work from a prompt, and duplicates UI
  that the block form already owns.
- **Skip verification entirely and just return re-authored parameters.** Then "AI Fix" is a
  parameter generator with a success banner it cannot justify.

## 7. Touched files

| File                                                                                                  | Change                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/node-fix.ts`                                                                        | `goal` optional + `errorLog` in the prompt input; the target section splits by contract/prompt-only; reply gains `verify`; result gains `verifiedBy`; `temporaryCriterionOf(raw)` reads one row through `workflowConditionsOf`. |
| `src/background/workflow-engine/node-fix-engine.ts`                                                   | refusal only when contract **and** prompt/error log are absent; `workingCriteria` holds the ephemeral criterion; the "already satisfied" shortcut requires ≥1 criterion; success reports `verifiedBy`.                          |
| `src/lib/messages.ts`                                                                                 | `workflows.nodeFix` command gains optional `errorLog`.                                                                                                                                                                          |
| `src/background/index.ts`                                                                             | passes `errorLog` into `runNodeFix`.                                                                                                                                                                                            |
| `src/workflow-editor/sidebar/NodeFixModal.tsx`                                                        | error-log input; confirm enabled when prompt or error log is present; the missing-contract note now explains the temporary judgement; success banner branches on `verifiedBy`.                                                  |
| `src/workflow-editor/i18n.ts`                                                                         | en + zh-CN keys for the above.                                                                                                                                                                                                  |
| `tests/node-fix.spec.ts`, `tests/node-fix-engine.spec.ts`, `tests/acceptance-node-fix-modal.spec.tsx` | the new path + the two refusal cases + the labelled fallback.                                                                                                                                                                   |

Cross-host note: nothing here runs in the Runner (`server/`) — AI Fix is an editor-driven,
in-extension capability, and the engine already lives in `src/background/**` with its pure
vocabulary in `src/lib/workflow/**` (§5.7 unchanged).

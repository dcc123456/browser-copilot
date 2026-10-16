# get-secret only for values that must stay secret

Date: 2026-10-16 · Area: workflow generation (operator guidance + generated-workflow validation) · Status: implemented

## 1. The report

> AI 生成工作流时误添加获取凭证算子。这个算子只是用于填充一些敏感参数，比如密码这种，但是登录场景
> 用户名同样可以当作触发器参数，不需要每次都走获取凭证算子。

So: a generated login workflow carried a `get-secret` node for the **username**. The operator is
named 获取凭证 and its catalog sentence only says what it does ("fetch stored credential fields at
runtime"), never what it is for — so "the login form has two fields, one operator fetches field
values" reads as a perfectly good plan to the model. Nothing in the codebase disagrees: the recorded
node is well-formed (`credential` + `variableName` both present), the credential id it names is one
the user really has (a stored account usually carries both an account and a password field), so the
run succeeds. It is _wrong_ in a way no existing check can see: an ordinary input now depends on a
stored secret, and the workflow stops working for anyone who has not configured that credential with
the same field key.

## 2. What the model is told today (evidence)

| Where                               | File:line                                                         | What it says                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog sentence → tool description | `src/lib/workflow/blocks/custom.ts:125-149`                       | "Fetch stored credential fields at runtime, each into its own variable. The secret values are never embedded in the workflow…" — capability only, no scope.                                                                      |
| Tool description assembly           | `src/lib/workflow/operator-tools.ts:321-338`                      | catalog sentence clamped to 160 chars (`MAX_OPERATOR_DESCRIPTION_CHARS`) + the shared "runs now, records on success" suffix. The clamp is why the _scope_ sentence has to come first, not appended.                              |
| Operator guide (workflow generator) | `src/lib/workflow/operator-guide.ts:117-119` (before this change) | one negative rule, about a different mechanism: credentials the USER TYPED IN CHAT should be written as literals (the engine captures them as a secret trigger input) — "无需改用 get-secret". No rule for non-sensitive inputs. |
| Palette description (zh)            | `src/workflow-editor/block-i18n.ts:158`                           | mirrors the catalog sentence; same capability-only framing.                                                                                                                                                                      |
| Runtime failure                     | `src/background/workflow-engine/executors.ts:1397-1446`           | already strict: a missing/unknown credential id or field throws, so a _guessed_ credential never records silently. The reported node was therefore a resolvable one — a needless fetch, not a broken one.                        |

The generation path never hands the model the list of stored credentials, and no check anywhere asks
whether a fetch is needed at all: `producer-completeness.ts:197` only reports references **without**
a producer (`MISSING_PRODUCER`), `generated-validation.ts:370-388` only reports `{{var}}` reads
nothing writes (`DATA_UNWRITTEN_VARIABLE`). The mirror case — a producer nobody reads — has no check
(grep for `unused`/`unreferenced`/`no consumer` across `src/lib` finds only `dynamic-data.ts:273`,
which picks a free name).

## 3. Design

Two layers, in order of leverage. Scope guidance where the model reads it; keep a machine guard for
the residue.

### 3.1 Say what the operator is FOR (prompt-side)

- `custom.ts` catalog sentence, rewritten to 158 characters so it survives the 160-char tool-description
  clamp whole: "Fetches stored credential fields into variables each run. Only for values that must stay
  secret — a username belongs in the form value or a trigger parameter." `block-i18n.ts` carries the
  same sentence for the zh palette (blocks with no zh entry keep the English catalog text).
- `operator-guide.ts`: the credential guidance becomes ONE section, `## 凭证：只有必须保密的值才走
get-secret`: the trade (a fetch buys "the value is not in the workflow" at the price of "every run
  needs that stored credential with that field"), the sensitive set (password / token / OTP / API key),
  the non-sensitive set (username, email, phone, search term, URL) and the login recipe — **username as
  an ordinary input (literal or `inputName` trigger parameter), password via get-secret** — followed by
  the pre-existing chat-typed-credential rule, whose separate paragraph it absorbs. Deleting that
  duplicate rather than stacking a second paragraph is what keeps the growth small: +43 characters of
  the mounted guide, so `tests/agent-payload-size.spec.ts`'s three workflow budgets move 59_500 →
  59_600 / 37_000 → 37_100 with the reason recorded there, and the `skills.spec.ts` instruction headroom
  (≥100 chars) still holds.

Prompt text is the fix for the reported case; the guard below is what makes it stick.

### 3.2 A fetch nothing reads is a mistake we can prove (guard)

`generated-validation.ts` DATA layer, beside `DATA_UNWRITTEN_VARIABLE`, new code
`DATA_UNUSED_SECRET` (severity `warning`, so it rides the existing
`save-gate.ts:107-112` warning plumbing and the review UI instead of blocking a save):

- for each reachable `get-secret` node, take the variables it writes (the same multi-row set the
  DATA layer already computes via `variableWritesOf`, which special-cases
  `SECRET_PRODUCER_BLOCK` at `:234`);
- if no other reachable node references any of them, report it, with a suggested fix that names the
  cheap alternative (drop the node; write the value or declare a trigger parameter).

Warning, not error, for one reason: the check proves the fetch is _useless_, never that a later
human edit won't reference the variable — and a save-time hard block over a judgement call is the
wrong trade. The suggestedFix is what makes the row actionable rather than noise.

## 4. Rejected alternatives

- **Refuse `get-secret` at record time.** Undecidable there: whether the value is needed is a
  property of the nodes recorded _after_ it, and the operator runs-and-records immediately. Refusing
  would also break the legitimate case (one node, several password rows).
- **Blocklist field names (`username`, `account`, `email`) and reject those rows.** Reads the
  credential's _label_, not the page's sensitivity: sites store the login id under `password`-adjacent
  keys and real secrets under innocent names, so it both misfires and teaches the model a keyword
  rule instead of the trade-off.
- **Detect "the filled element is not a password field".** Needs the live DOM at generation time; the
  generalized graph keeps a selector/fingerprint, not `input[type]`, and Runner-replayed workflows have
  no element to consult. The same judgement is already available statically (§3.2) when the value is
  unused, and cheaply available to the model when it is used.
- **Make `validateGeneratedWorkflow` read the user's secret store** to check that each `credential`
  resolves. The module is chrome-free by rule (§5.7), the executor already fails loudly on an
  unresolvable id, and the reported bug is a _resolvable_ id — this would add a storage dependency to
  a pure validator for a case that is not broken.
- **A second "unused node" validator module.** The DATA layer already owns variable liveness; adding
  the reverse edge there reuses its reachability, per-node write set and issue shape
  (`§5.1/5.3`), instead of a parallel graph pass.

## 5. Surfaces touched

| File                                                                       | Change                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/blocks/custom.ts`                                        | the get-secret sentence now carries its scope and says where an ordinary input goes (158 chars, inside the clamp).                                                                                                                     |
| `src/workflow-editor/block-i18n.ts`                                        | the zh palette sentence mirrors it.                                                                                                                                                                                                    |
| `src/lib/workflow/operator-guide.ts`                                       | one `## 凭证` section: the trade, the sensitive/non-sensitive sets, the login recipe — absorbing the duplicated chat-credential paragraph.                                                                                             |
| `src/lib/workflow/generated-validation.ts`                                 | `DATA_UNUSED_SECRET` warning in the DATA layer.                                                                                                                                                                                        |
| `tests/generated-validation.spec.ts`, new `tests/get-secret-scope.spec.ts` | the guard's shapes (unread fetch → warning and non-blocking, read fetch → clean, per-row on a multi-credential node, other producers untouched, unreachable fetch left to layer A) and the guide / tool-description / palette wording. |
| `tests/agent-payload-size.spec.ts`                                         | three workflow budgets raised by 100 chars, reason recorded in the file's existing style.                                                                                                                                              |

## 6. Acceptance

- G-1: a generated workflow whose `get-secret` variable nothing reads reports exactly one
  `DATA_UNUSED_SECRET` warning, and the same workflow with a `forms` node referencing the variable
  reports none (`tests/generated-validation.spec.ts`).
- G-2: the guard is scoped to credential fetches — an unread `set-variable`/`get-text` output stays
  silent (a scratch variable is a normal generation artefact).
- G-3: the model-facing text states the scope: the operator tool description the model is sent still
  carries both "must stay secret" and "trigger parameter" after the clamp, and the operator guide
  contains the trade, the sensitive set and the login recipe (username as ordinary input, password via
  get-secret), pinned by test so a future edit cannot drop it.
- G-4: nothing user-facing changes shape: severity `warning` reaches the panel through the existing
  save-gate warning list, so no new UI copy is invented and no locale key is added.
- G-5: the prompt cost is measured, not assumed — `tests/agent-payload-size.spec.ts` and
  `tests/skills.spec.ts` still pass with the merged section (the +43-char guide growth is the only
  growth, and it is written down where the budgets live).

Browser evidence (§收尾自检 ⑤): BLOCKED — the claim is about what a live generation session records,
which needs a real provider run (`pnpm selftest` / a generate session in the unpacked extension). The
offline suites prove the guard and the text; the model's behaviour change is not measured here.

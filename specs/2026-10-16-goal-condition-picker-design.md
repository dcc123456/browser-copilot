# Goal criteria: pick the element, and check a control's value

Design record for the operator-panel request
「成功条件应该支持：当用户选择元素可见 / 元素存在 / 元素文本等值时，支持用户手动选择元素
（使用 css 选择器组件）；并且支持这样的情况：比如元素 input 只要有值就判定成功，
也要支持要有固定值才能判定成功。」

## 1. What the two halves are really asking

1. **A row must be pointable at a hand-picked element.** Today a manual row names its
   element with words (the accessible-name input in `ConditionEditor`). The page is
   free to answer those words with a different element, and the operator has no way
   to say _that one_. The extension already ships exactly the missing control — the
   element picker — and every block form that edits a selector reaches it through one
   shared component (`blocks/shared/SelectorField.tsx`, which wraps
   `ElSelectorActions` + the pick/verify round-trip to the active tab). So this half
   is wiring, not new infrastructure (§5.1/§5.3): reuse `SelectorField`.
2. **「A value was entered」 is not a text claim.** `elementText` reads `innerText` /
   `textContent`, and for `<input>`/`<textarea>`/`<select>` those are always empty —
   typed content never becomes text. Nor is it an attribute: the kernel's
   `get_attribute` reads `element.getAttribute('value')`, which stays at the markup
   default while the user types. The live value is the DOM **property**, and the
   kernel already reads it as a first-class op (`get_value` → `readControlValue`,
   `src/inpage/kernel.ts:1070,2558`). So the honest model is a new condition kind
   over that observation, not a mode switch bolted onto `elementText`.

## 2. Where the picked selector goes (the part that can silently do nothing)

`WorkflowCondition.target` is `SemanticLocator | Target` (`lib/workflow/element-fingerprint.ts:65`)
and the observer reads it through `conditionTargetSpecs`:

- if the target carries a resolvable `primary`/`fallbacks` chain, **that chain is the
  search** and the locator fields are ignored;
- only a chain-less locator is converted, by `targetSpecsFromSemantic`
  (identity specs first, then `locator.selector`, then `stableAttributes['data-css']`).

Therefore writing a flat `target.selector` onto a rich target — which is what a
generated node actually produces — would be **accepted by the form and ignored by the
run**: the classic silent side effect. The write helper has to branch on the shape it
was given:

- chain present → insert `{how:'css', value}` as the **new primary** and demote the
  recorded specs to fallbacks. The operator picked this element deliberately, so it is
  the strongest claim about intent; the old specs stay as the drift rescue, which is
  the same order of authority a recorded node's own target uses.
- bare locator → set `selector`, which `targetSpecsFromSemantic` already honours.

Reads use the mirror helper (`conditionTargetSelector`) so the input always shows the
selector the observer would actually search for, including the `data-css` form
`auto-contract` records.

Consequence worth stating: a row whose element is named **only** by a picked selector
counts as "came from an observation" for `conditionTargetIsNamed` when it rides the
rich chain, and as "invented" when it rides `selector` on a bare locator. Both are
correct by that function's own rule (chain = produced by a real read; a bare class name
typed by hand = a guess), and nothing here changes it: the gate is only evidence at
`prepare_workflow_goal` time and a warning line in `ungroundedGoalConditions`, never a
drop — `groundGoalSpecToGraph` (`lib/workflow/goal.ts:233`) only drops variable rows
whose name the graph never mentions, so a hand-edited row survives.

## 3. The value criterion

One new kind, two modes — because the ask is exactly two behaviours (§5.5):

```ts
{ kind: 'elementValue'; target: ConditionTarget; op: 'notEmpty' | 'equals'; expected?: string }
```

- `op:'notEmpty'` → the control holds a value. `op:'equals'` → it holds `expected`,
  after the same `{{variable}}` interpolation every other row gets (`condition-runtime`'s
  `fill`), so a row can demand 「标题输入框等于 {{title}}」.
- Hard, like `attributeEquals` (`isHardCondition`): it is a fact about a control this
  step touched, not a prediction about a business outcome.
- `equals` requires a string `expected` in the guard, and `notEmpty` ignores it — an
  empty `expected` under `equals` would pass on an empty input, which is the opposite
  of the claim.

**Non-textual control values read as "no value", not as `'true'`.** `readControlValue`
answers a boolean for a checkbox and `null` for a file input. Coercing `false` to the
string `'false'` would make `notEmpty` pass on an unchecked box, so the probe returns
`undefined` for anything that is not a string/string[]; the row then reports 「不是可读
值的控件」. Checkbox claims stay `attributeEquals`/`elementEnabled` territory.

The pre-run baseline matters more here than anywhere else: a form can arrive filled in
(draft restore, autofill, a page that prefills its own search box), and then
「输入框有值」 is furniture, exactly the round-77 「页面文本包含 草稿」 hole. So the value
is captured with the other quoted observations (`captureQuotedObservations` → the new
`values` bag) and `didHoldBeforeTheRun` reads it, which lets the L3 layer refuse a row
that already held before the run started.

## 4. Which host evaluates this (a claim to correct)

The batch ask said "both hosts". Verified instead: goal conditions are evaluated **only
in the extension host**. `evaluateCondition` is an _optional_ injection on the shared
engine (`src/background/workflow-engine/engine.ts:132`, guards at :731/:761/:982) and
`server/src/**` never supplies it — no `evaluateCondition`, no `ConditionPageProbe`, no
`verifyWorkflowGoal` anywhere in the Runner (grep over `server/src` returns nothing).
The Runner's `condition`/`conditions` blocks speak a different, older vocabulary
(`lib/workflow/condition-tree.ts`) and are untouched by this change.

So `elementValue` needs one evaluator, and the Runner gains it for free the day it
injects the browser-host probe. Recording this beats shipping a second copy of the
switch (§5.2/§5.6) — and it is the same mirror discipline `driver.ts` follows, minus a
second implementation that nothing calls.

## 5. Files touched

- `lib/workflow/conditions.ts` — kind, whitelist, guard, `describeCondition`,
  `isHardCondition`, element-target list.
- `lib/workflow/element-fingerprint.ts` — `conditionTargetSelector` /
  `withConditionTargetSelector` next to the existing name accessors.
- `background/workflow-engine/condition-runtime.ts` — `value()` on the probe, the
  `elementValue` case, `values` in `ConditionBaseline`, `probeFromBaseline`, the
  driver probe's `get_value` call.
- `workflow-editor/sidebar/ConditionEditor.tsx` — `elementValue` in the offered kinds,
  the `SelectorField` row on every element-bearing kind, the value-mode inputs.
- `workflow-editor/i18n.ts` — en + zh-CN keys (§3).
- `background/agent.ts` — the generation-facing vocabulary, so a model can write the
  row too instead of only the operator.
- `lib/workflow/operator-guide.ts` — **not changed.** The guide is sliced to
  `MAX_INSTRUCTIONS_LENGTH = 9400` (`src/lib/skills.ts:23`) and
  `tests/skills.spec.ts:208` demands ≥100 chars of headroom; at baseline the
  generator guide sits at 9273, so ~27 chars are available — not enough for a clause
  that explains the kind. The rejected candidate, kept here so nobody re-measures it:
  「填完表单用控件取值收尾…{kind:'elementValue',target:{selector:'#title'},op:'equals',
  expected:'{{title}}'}，op 也可为 'notEmpty'」 (+152 chars, budget red). If the guide is
  ever re-cut for length, this is the clause to put back — `prepare_workflow_goal`'s
  refusal message already lists `elementValue`, which is where a model actually reads it.

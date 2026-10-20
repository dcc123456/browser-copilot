# Editor AI operator assistant — page grounding, act-once, edit & replace

Date: 2026-10-19 · Area: workflow-editor AI (canvas-scoped chat) · Status: designing
Supersedes parts of: `2026-10-19-editor-operator-ai-chat-design.md` (the "不验证" ruling is amended here — see §2)

## 1. The ask

> - ai 算子助手 能直接读取页面参数 然后操作页面 比如用户要从一个下拉中选择并添加一个值
>   算子助手要先自己操作一次页面 然后根据操作过程数据来添加算子节点
> - ai算子助手可以支持用户选中一个算子节点 然后ai能修改这个节点的参数 甚至能替换这个算子节点

Rulings (dialog, 2026-10-19):

| question                       | ruling                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 授权口径(助手开始真实改动页面) | **读优先,必要时才动**:先用只读快照定参数;读不出来才请求确认、真做一次                                                                         |
| 执行代码走哪条路               | **扩 operator-advise 引擎**:复用 `executeOperatorNode` + `target-to-selector`,结果仍走 `appendOperatorChain` 落地;不碰 `conversationId`/draft |
| 改参数 / 换算子放哪            | **同一个聊天窗**:回复契约加 `action: append \| edit \| replace`                                                                               |
| 换算子的边界                   | **按 key 迁移 + 剪边点名 + 快照撤销**                                                                                                         |

## 2. What this amends

The first slice ruled out trial runs ("不验证"). That ruling covered _verification_ — running the
chain to prove it works. This slice adds a different thing: running **the assistant's own proposed
steps once, to learn what the page actually requires**, and it is gated behind a read-first policy
plus a user confirmation. Verification still belongs to Run / AI Fix: an observation never certifies
a workflow, and it never re-runs after landing.

## 3. 选型与证据 (what already exists, and what is rejected)

Verified against the code, not against docs:

| need                                     | existing, reused                                                                                                                                                                                                                                                                     | why not something new                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run ONE operator on the live page        | `executeOperatorNode(blockId, data, deps)` — `background/workflow-engine/operator-exec.ts:142`; never throws, returns `{status, lines, resolution:{usedSpec,usedFallback,matched}}`, takes `{signal, scope, tabId, setTab, variables, executors, attribution}`                       | AI Fix already calls it as a trial executor (`node-fix-engine.ts:94-118`), so the editor-adjacent path is proven                                                                                                 |
| which blocks may run standalone          | `operatorExecClass` / `recordOnlyReason` — `lib/workflow/operator-class.ts:151,163` (loops, real HTTP/notifications/disk writes, nested model calls, placeholders are `record-only`; a test pins exhaustiveness so a new block cannot silently default to running)                   | it is already the generation pipeline's single list; a second safety list would drift                                                                                                                            |
| record the locator that REALLY worked    | `resolveOperatorLocator` (`operator-tool-run.ts:178`) → `countSelectorMatches` (`selector-probe.ts:186`) → `withLocator` → `selectorAfterExecution` / `recordedTargetChainOf` (`lib/workflow/target-to-selector.ts:415,486`)                                                         | this is exactly "act once → node data from observation"                                                                                                                                                          |
| read the page (incl. `<select>` options) | `snapshotActiveTab(maxChars, maxElements, scope)` (`driver.ts:1209`) → kernel `buildSnapshot` enumerates option labels/values (`inpage/kernel.ts:1607-1612`); compacted by `summarizeSnapshot` (`agent.ts:2380`) which keeps per-element `loc` via `locatorHintOf` (`lib/ops.ts:62`) | option enumeration already exists, so **no injected-function edit** → 收尾自检 ④ stays out of scope                                                                                                              |
| which tab / window                       | `ScopeWindow` + `resolveAutomationTab(undefined, scope)` (`driver.ts:131`); the editor already knows its host window (`workflow-editor/host-window.ts:22`)                                                                                                                           | a scoped window with no injectable page resolves to `undefined` and never leaks into another window (:209-216)                                                                                                   |
| swap a node's operator                   | **nothing** — no code rewrites `data.blockId` while keeping the node id and its edges                                                                                                                                                                                                | handles are named by block id (`${blockId}-output-1`, `conditions-output-<path>`, `-output-fallback`) and React Flow **silently drops** an edge whose handle does not resolve, so a swap must re-hook and report |

Rejected:

- **`runOperatorToolWithExecution` (`operator-tool-run.ts:352`) as a whole.** It is the right
  pipeline but it is keyed by `conversationId`: it hydrates and writes a background draft, pins a
  per-conversation tab, captures credentials into `secret` trigger inputs, applies the JS escape
  gate and the ai-prefill decision. The canvas is the source of truth and may hold unsaved edits, so
  importing the draft model is the one thing this feature must not do (§2 of the first design doc
  still holds). What is reusable is its **leaf helpers**, and `withLocator` is exported in place for
  that reason rather than reimplemented (AGENTS.md §5.2).
- **`wf_op_*` / `runAgentTurn`.** Same rejection as before: agent side effects + a second messaging
  path (§5.6/§5.7).
- **A new page-inspection module.** `inspectPage` exists for repair (`page-inspect.ts:233`) but does
  not enumerate `<select>` options; `snapshotActiveTab` does, and it is what the agent already feeds
  the model.

## 4. Reply contract v2

```json
{
  "reply": "<one sentence, in the user's language>",
  "action": "append" | "edit" | "replace",
  "proposals": [{ "blockId": "forms", "data": { "selector": "#city", "value": "上海" }, "rationale": "…" }]
}
```

- `action` defaults to `append` when the model omits it — the append path cannot regress.
- **The target of `edit`/`replace` is the editor's own selection, never a node id from the model.**
  The id is captured when the request goes out and re-validated against the live graph when the
  answer lands; gone ⇒ refused as `unknown-target`. A model that invents or stale-names a node id
  therefore cannot edit anything.
- `edit`: exactly one proposal whose `blockId` equals the target's — otherwise refused and the chat
  says "要换成别的算子请说明". Parameters are **merged** over the node (`{...current, ...sanitized}`),
  deliberately unlike AI Fix's complete re-authoring: a chat edit is one thing ("把 url 改成 x"), and
  re-authoring every key from a one-line ask would drop parameters the model was not told to change.
- `replace`: exactly one proposal, `blockId` must be in the offer it was given and differ from the
  target's.
- `data` keeps going through `sanitizeNodeData` (`node-fix.ts:265`), which strips `blockId` and the
  `__workflowAi` namespace — so neither an edit nor a replace can forge provenance or identity.

## 5. Replace: key migration, pruned ports, snapshot undo

`applyOperatorAction(graph, nodeId, action, proposals)` (pure, `operator-advise.ts`) — one entry for
both in-place actions, so every refusal lives next to the graph it checks:

1. new data = catalog defaults for the new block → the old node's values under the same key **plus
   the node's own policy** (`PROTECTED_PARAMS`: error routing, goal contract, disabled — those
   describe the node, not the operator) → the model's `data` on top. No `data[key] === undefined`
   guards (catalog defaults poison migrations).
2. every incident edge is re-anchored to the new block's port naming. A port that the new block does
   not have (e.g. leaving a 3-path `conditions` for a single-output block, or an
   `output-fallback` onto a block without an error port) is **pruned and named** in the result —
   React Flow's silent drop is the failure mode being designed out.
3. node id, label position and the `<< selected` identity are kept; `label` follows the new block.
4. the patch carries a `before` snapshot `{node, incident edges}`; the dock's undo restores that
   snapshot wholesale. One level, matching the append batch's one level.
5. missing required parameters are reported the same way append does.

`__workflowAi` is not stamped on edited or replaced nodes: the provenance ring answers "who put this
node here", and the chat row plus 撤销 answers "what did the assistant just change".

## 6. Read-first grounding

- `workflows.operatorAdvise` gains `windowId` and `skipPageRead`, and the engine, before the model
  call, best-effort reads the scoped page: `normalScopeFromWindowId(windowId)` →
  `snapshotActiveTab(4000, 40, scope)` → `summarizeSnapshot(snap, { elementLimit: 40, textCap: 0 })`.
  What crosses into the prompt is an `OperatorPageRead` — `{url, title, elements, forms}` only, with
  body prose dropped (`textCap: 0`), because parameters come from controls and option labels and a
  paragraph of prose is the part most likely to carry something sensitive. The section renders through
  `capModelPayload` as `## The page the user is looking at — <title> (read just now, read-only)`,
  placed after the canvas digest and **before** the operator offer, so the model copies from the page
  instead of inventing a selector for the offer to fit; it is told to leave a parameter out rather
  than guess one.
- The read is side-effect free and therefore **automatic** (AGENTS.md zero-config): no checkbox must
  be ticked before the assistant can use the page. The override is the dock's footer toggle
  (`operatorAiPageToggleOn` / `operatorAiPageToggleOff`, Eye/EyeOff, `aria-pressed`) and it rides the
  command as `skipPageRead: true` — the reader is then not called at all, not called and ignored.
- No page, unreadable page, or an editor in a window with no injectable tab ⇒ the request goes out
  without the section, and the result says `page: null` so the chat can state that parameters are
  ungrounded. A failed read is never a turn failure: `defaultReadPage` swallows and returns `null`.
- The result returns `{url, title}` of whatever page was read, and the assistant's reply row shows
  "参数按〈title〉页面填写" / `Parameters filled from "{title}"`, with "本次未读取页面…" when it is `null`
  — the user must be able to see which page the selector came from.
- `summarizeSnapshot` moves from `agent.ts` to `lib/ops.ts` (next to `PageSnapshot` and
  `locatorHintOf`, both already there) and `agent.ts` imports it: this is the second consumer, so the
  extraction is mandatory, not optional (§5.2).

## 7. Act once

Trigger, not automatic: an `append` answer whose steps read a page element **and** whose landed
parameters still miss a requirement (`proposalsNeedingPage`), on a turn that did read a page in a
window the editor knows, is **held** — nothing goes on the canvas. The row asks 这些步骤还缺少页面
参数：… 要不要先在页面上做一次 and offers **先做一次再添加 / 直接添加**. Steps the observation would
refuse to run are named in that row (`operatorAiOfferRefused`), so the choice is made knowing which
steps a page run would not touch.

- Command `workflows.operatorObserve {sessionId, steps:[{blockId,data}], windowId, workflowId}` (+
  `…Cancel`) — a second entry in the same family, sharing the existing abort map (renamed
  `assistantAborts`: one facility, `sessionId` is per request).
- Per step, the same order the generation bridge uses: `resolveOperatorLocator` → probe counts →
  `withLocator` → `executeOperatorNode(blockId, data, {signal, scope, tabId, setTab, variables,
attribution})` → `selectorAfterExecution` + `recordedTargetChainOf` → `withLocator` again. Output
  is the **refined node data**, which the dock hands straight to `appendOperatorChain` — no second
  model call, so the landed parameters are the observed ones, not a re-guess. Only
  `OBSERVED_PARAM_KEYS` (the locator family) ride back, never a value the page typed.
- What the page reported is shown in chat as its own line per step: matched count, the locator that
  resolved, and for a dropdown the option actually chosen (from the executor's `lines`, incl. the
  kernel's `Available: …` when the wanted option did not exist).
- Failure is per-step and non-fatal: a `failed` step keeps its proposed data and says why; a
  cancelled or refused run reports its reason and **leaves the offer open**, so 直接添加 is still
  available after a stopped run.
- A step whose block is not observable is skipped and named, never executed.
- **Undo does not undo the page.** The row states it (撤销只会移除这些步骤——助手在页面上已经做的操作
  不会被撤回).

`isObservableBlock(id) = isAppendableBlock(id) && operatorExecClass(id) === 'execute' &&
id !== JAVASCRIPT_BLOCK_ID && !NEVER_OBSERVED_BLOCK_IDS.has(id)`, with `NEVER_OBSERVED_BLOCK_IDS =
{cookie, new-window, close-tab, upload-file, handle-download}`: beyond generation's own gate, one
assistant turn must not grant cookie/access permissions, open or destroy windows, take a file handle,
or claim a download. `javascript-code` stays behind the JS gate and is never an observation.

## 8. Tests

- `tests/operator-advise.spec.ts`: `action` parsing (default append, unknown action refused);
  `applyOperatorAction('edit')` merge + refusal table + deep-copied `before`;
  `applyOperatorAction('replace')` key migration (same-key + `PROTECTED_PARAMS` policy), port
  re-anchoring, pruned-edge naming, snapshot undo round-trip, conditions→plain and legacy
  handle-less edges; `selectedOperatorSpecOf` (nested params, secret masking); the prompt's action
  section appearing only with a selection; `isObservableBlock` (record-only, JS, browser-state ids),
  `proposalsNeedingPage` (element-reading step with a still-missing requirement, and the two cases
  that must not fire: a filled selector, a step that reads no element) and
  `operatorDataOfProposal` (catalog defaults + the marker the model cannot forge) — the act-once
  half, §7.
- `tests/operator-advise-engine.spec.ts`: injected read dep → page section present in the prompt and
  `page` reported; read failure ⇒ prompt without it; the toggle ⇒ no read at all; injected exec dep
  for `runOperatorObserve` ⇒ refined data per step with `selectorVerified`, denial list naming an
  unobservable block, a failed step keeps its proposal and the loop continues, a navigation step is
  followed by the next one, a leaked typed value never lands, abort ⇒ rejects `AbortError`.
- `tests/acceptance-operator-chat-dock.spec.tsx`: edit/replace rows apply to the selection captured
  at send time; selection gone at landing ⇒ refused; a grounded missing-param batch is held with
  nothing on the canvas and the send button waiting; 直接添加 lands the proposals as written;
  先做一次 puts `workflows.operatorObserve` (steps + the editor's own `windowId`) on the wire and
  lands the refined data with the page's report line; a stopped run keeps the offer open;
  "不读页面" suppresses the read field.
- `summarizeSnapshot` relocation is covered by the existing agent snapshot suites; no behaviour
  change asserted there.

## 9. Verification

`pnpm typecheck`, `pnpm test`, `TZ=UTC pnpm test`, eslint+prettier over `git ls-files` (bare
`pnpm lint`/`format:check` are red on `tmp/` and `server/data` artifacts), `pnpm build`.
`bench:debug` applies only if `workflow-engine/**` is touched — `executeOperatorNode` is _imported_,
not modified, so re-check that claim before reporting. `verify:injected` applies only if an injected
function body changes — §6 deliberately avoids one. Browser evidence (⑤) is BLOCKED for extension
pages: numbered manual steps will be provided, with the dropdown example
(打开页面 → 读优先给出选项列表 → 做一次 → 落地 `forms` 节点带真实 selector 与选中值) and a replace
case (选中 `new-tab` → 换成 `reload-tab` → 连线不丢、被剪的端口点名 → 撤销恢复原节点与原边).

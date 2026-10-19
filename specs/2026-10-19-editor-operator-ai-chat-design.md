# Editor AI operator assistant — design

Date: 2026-10-19 · Area: workflow-editor AI (canvas-scoped chat) · Status: implemented

## 1. The ask

> 工作流编辑页中 在右下角增加一个圆形悬浮按钮 文案写 AI 点击后出现一个聊天悬浮窗
> 这个按钮的功能是 帮助用户逐个智能选择并添加算子的智能工具
> 比如 用户说我需要 打开 https://www.baidu.com 那么就自动在已有的工作流后面新建一个算子节点
> （新建标签页）并且 url 填写了 https://www.baidu.com

Rulings (dialog):

- **直接追加 + 可撤销 + 边框标记** — the assistant lands nodes on the canvas as soon as it
  answers, each AI-authored batch is removable in one click, and an AI-added node is outlined in
  a dedicated colour so the user can tell its provenance apart at a glance.
- **一次可提议多个算子组成的子链** — one turn may hand back several operators, chained in order.
- **不验证、不存历史** — no trial run, no transcript persistence. Whether the chain works stays
  with Run / AI Fix, which already own execution and page evidence.

## 2. Why not the existing agent loop (选型与证据)

The repo already has a multi-turn agent (`src/background/agent.ts:4889 runAgentTurn`) that can
author workflows through the `wf_op_*` operator tools, and the whole-workflow generation path
(`src/background/workflow-generation-bridge.ts`) uses it. Rejected for this feature on three
counts, each verified against the code:

1. **It changes the representation of truth.** `wf_op_*` tools _execute_ the operator and record
   into a background-side session draft (`src/background/operator-tool-handler.ts:242,657,900`;
   `loadDraftFromWorkflow` seeds it from a **saved** workflow). The editor canvas is the source of
   truth and may hold **unsaved** edits (`App.tsx:255` dirty flag); routing through the draft
   would either lose those edits or require a two-way sync this feature does not need.
2. **The editor page has no port.** The agent protocol (`AGENT_PORT`, `src/lib/messages.ts:732-941`)
   has exactly one client today (`src/sidepanel/ChatTab.tsx:2255`); the editor talks only through
   `sendCommand` + `chrome.runtime.onMessage` broadcasts (`use-repair-events.ts:59`,
   `NodeFixModal.tsx:347`). Adding a second port consumer would be a third messaging path, which
   AGENTS.md §5.6/§5.7 forbids.
3. **The agent carries machinery this task must not have**: tab/page tools, plan gate,
   confirmation gates, `maxToolRounds`, history compaction. The ask is "pick the right operator
   and fill its parameters".

**Chosen shape:** the narrow one-shot command triple that AI Fix already proves out —
pure module (`src/lib/workflow/node-fix.ts`) + background engine
(`src/background/workflow-engine/node-fix-engine.ts`) + `workflows.nodeFix` /
`…Cancel` commands with `AbortController` bookkeeping (`src/background/index.ts:2463-2508`).
This extends that family (`workflows.review`, `.repair`, `.nodeFix`); it adds no transport, no
agent loop and no store.

Reuse inventory (searched by capability before writing anything):

| need               | reused                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| LLM request        | `src/lib/llm.ts:634 streamCompletion` (+ `getActiveProvider()` `lib/storage.ts:446`)                                                  |
| token attribution  | `TokenConsumer 'workflow-generation'` + `entityKeyFor('workflow', …)` (`token-ledger.ts:36,64`) — no new bucket                       |
| operator shortlist | `src/lib/workflow/operator-discovery.ts:139 findWorkflowOperators`                                                                    |
| parameter schema   | `src/lib/workflow/operator-tools.ts:778 dataSchemaFromEntry`                                                                          |
| required params    | `src/lib/workflow/block-requirements.ts:636 schemaRequiredArgs` / `:574 missingRequirements`                                          |
| reply hardening    | `sanitizeNodeData` + `NODE_FIX_RESERVED_KEYS` (`node-fix.ts:274,99`), `stripThinkBlocks`/`unwrapFencedAnswer` (`lib/model-output.ts`) |
| pure graph patch   | pattern of `ensureSecretProducer` (`var-suggestions.ts:257`); its overlap-walk is extracted as `placeClearOfNodes` and shared         |
| canvas mutation    | `toFlowNode` + id-keyed edge reconciliation + certification invalidation (`App.tsx:826-856`)                                          |
| edge semantics     | `isFallbackHandle`/`incomingNormalEdges`/`loopBackEdgeIds` (`graph-edges.ts`)                                                         |

`src/lib/workflow/operator-guide.ts` is deliberately **not** touched: its length is pinned by
char-budget suites (`tests/skills.spec.ts`), and the assistant's candidate set is carried as JSON
Schema instead of prose.

## 3. Reply contract

One JSON object, whole history in, current graph digest in:

```json
{
  "reply": "<one sentence to the user, in the user's language>",
  "proposals": [
    {
      "blockId": "new-tab",
      "data": { "url": "https://www.baidu.com" },
      "rationale": "opens the site"
    }
  ]
}
```

- `proposals` are ordered and become a **chain**. It is **spliced**, not stapled: the chain starts
  after the anchor (the single selected node, else the end of the main line) and the anchor's own
  continuation moves to the far end of it — `anchor → proposals[0] → … → proposals[n] → continuation`
  — so steps the user asked for land mid-flow, where they meant them. An anchor with **several**
  normal continuations is a branch point: choosing one branch to reroute would move a path the user
  never pointed at, so the whole batch is refused with a readable message instead. Error
  (`output-fallback`) and loop-back ports are never taken over.
- `blockId` must be one of the ids actually sent in the prompt. Anything else (hallucinated id,
  cloud block, OCR-dependent block, hidden operator) is dropped and reported — never guessed at.
- `data` goes through `sanitizeNodeData`, which strips `blockId` and the `__workflowAi` namespace,
  so the model cannot forge the provenance marker described in §5.
- Catalog defaults survive: the node is built as `{...clone(entry.data), ...sanitized, blockId}`
  — the same semantics as `newFlowNode` (`App.tsx:114`). A `data[key] === undefined` guard would
  break the day a key joins the catalog template, so there is none.
- Missing required parameters are **not** a failure: the node still lands (the canvas already
  badges it via `nodeRunIssuesOf`), and the chat says which keys are still empty.

The prompt carries, besides the schemas, a **digest of the current graph** (step index, block id,
capped parameter summary, produced variable names from `producedVariableNames`). That is what lets
the model append in the right place and stop re-proposing a `new-tab` the workflow already has.

## 4. Multi-turn without a store

The transcript lives in the dock's React state and is sent whole with each request — the same
in-memory discipline `NodeFixModal` applies to its event stream. No conversation id, no
`conv:<id>` record, no new persistence layer. Closing the panel keeps the messages for the life of
the page; reloading the editor starts clean, which matches the ruling "不存历史".

On the wire it is one awaited command pair, `workflows.operatorAdvise` / `…Cancel` with the
`AbortController` map beside `nodeFixAborts` (`src/background/index.ts`) — **no**
`…Event` broadcast. AI Fix streams progress because it runs steps for up to minutes; this is a
single model call whose only intermediate output the user cares about is the reply itself, so a
second channel would be dead weight. Failure and cancel both settle into a readable result rather
than a rejection, which is what lets the chat bubble say _why_ instead of going quiet.

## 5. Provenance marker

`node.data.__workflowAi` is already the reserved AI-metadata namespace (`node-goal-contract.ts:19`)
and survives persistence: the storage normaliser shape-checks only `id`/`label`/`position` and
passes `data` through untouched (`src/lib/workflow/storage.ts:63-75`) — verified, because the same
file's history shows a `settings` whitelist silently dropping a key that was written upstream.

The marker is `{ addedBy: 'ai' }` under that namespace, written **only** by the pure patcher
(`appendOperatorChain`), read by `BlockNode` for the `.wf-node-aiadded` outline and the small `AI`
badge. Colour comes from a new design token `--bc-node-ai` defined in both theme blocks of
`src/ui/design-system.css` and mapped in `@theme inline`, so dark and light both work.

## 6. Undo

A landed batch touches two kinds of edges: the ones it creates, and the **one it borrows** — the
anchor's old continuation, whose `source` now points at the last inserted node. So undo is not
"drop every edge touching a batch node": that would delete the user's own wiring along with the
AI's, leaving the flow cut. `appendOperatorChain` therefore returns the borrowed edge as it was
(`splicedEdge: { id, source, sourceHandle }`), `operatorBatchOf` folds it together with the added
node ids into the batch record the editor keeps, and the pure
`edgesAfterBatchRemoved(edges, batch)` drops the batch's edges while re-hanging the borrowed one on
the anchor. Positions of existing nodes are never touched, so no geometry needs restoring either.
Round-trip is asserted in `tests/operator-advise.spec.ts` for both a tail append and a two-operator
splice: `edgesAfterBatchRemoved(patch.edges, operatorBatchOf(patch))` equals the original edge list.

Undo is single-level (the newest batch), not a snapshot stack like AI Fix's per-node one — the batch
record is the whole inverse, so the canvas state before it needs no copy.

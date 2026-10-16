# Live fix log, shared by both dialogs — design

Date: 2026-10-16 · Area: workflow AI fix (per-node) + workflow repair (chat) · Status: implemented

## 1. The asks

> 算子中的 AI 修复功能 修复时要显示实时修复日志，比如请求参数、AI 输出参数等具体信息。

> 工作流回复弹窗 也要实时显示修复日志。

Ruling (dialog): **「两弹窗共用一条事件流」** — one streamed event source, rendered live by both
the editor's per-node AI Fix dialog and the chat's workflow dialog. No second log pipeline, no
polled history endpoint (§5.6 forbids a parallel infrastructure).

## 2. What the code does today (evidence)

| Fact                                                                                                                                                                                                                                                                                       | Where                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| The per-node loop already emits a rich event stream (`observing/executing/diagnosing/applying/verifying`, per round, with status).                                                                                                                                                         | `src/lib/workflow/node-fix.ts` `NodeFixEvent`, `node-fix-engine.ts` `push()`             |
| …but each event carries only a one-line human `message`. The node parameters the trial run used, the model request and the model's returned parameters are never reported.                                                                                                                 | `node-fix-engine.ts:234-239`                                                             |
| …and the events are pushed over **panel ports** (`broadcastPanels`), which the workflow editor page does not own, while the dialog subscribes on `chrome.runtime.onMessage`. Net effect: the AI Fix dialog never renders a live log line.                                                  | `src/background/index.ts:2449` vs `src/workflow-editor/sidebar/NodeFixModal.tsx:317-325` |
| The chat's workflow repair dialog already receives a live stream (`workflows.repairEvent` → `useRepairEvents`), but renders six canned phase labels: `strategy`, `attempt`, `changedNodeIds` and the per-attempt `reason` are dropped, and the list is truncated to 6 rows with no detail. | `src/sidepanel/components/RepairProgressDialog.tsx:51-108`                               |
| Repair events travel by `chrome.runtime.sendMessage`, which is why the chat sees them and the node-fix stream (port broadcast) does not reach the editor.                                                                                                                                  | `src/background/index.ts:896-905`                                                        |

So the fix log the user asked for is **half built already**: the vocabulary and the fan-out exist,
the payload and the transport do not match the consumers.

## 3. Design

### 3.1 One stream, one transport

`workflows.nodeFixEvent` is delivered with `chrome.runtime.sendMessage` — the same transport the
repair stream already uses — so **every** extension page receives it: the editor dialog and the
side panel. `broadcastPanels` (ports, side-panel windows only) is dropped for this message type;
nothing else starts using it.

### 3.2 One stream, one payload shape

`NodeFixEvent` gains an optional structured payload, alongside the human line that is there today:

```ts
payload?: {
  /** What this step sent: the model request (node params + evidence) or the page state read. */
  request?: string
  /** What this step got back: the AI's returned parameters, a criterion verdict list. */
  response?: string
}
```

- Plain strings, not `unknown`: the log is a _display_ artifact, so the engine formats what it
  already has (`JSON.stringify` for params, `describeCondition` for criteria, `变量 x 已设置` for
  verdicts). `sanitizeNodeData` still strips `__workflowAi` before any of it is stringified, so
  the log cannot show a contract the model invented.
- Populated at every step the user named: `diagnosing` carries the request, `applying` carries the
  AI's returned parameters, `executing` the parameters the trial run used, `verifying` the
  criterion verdicts, `observing` the page summary.

### 3.3 One projector for both dialogs

`nodeFixLogLinesOf(event, labels)` (pure, in `src/lib/workflow/node-fix.ts`) turns one event into
the log lines a plain-text consumer needs — the shape the chat's workflow dialog already accepts
as `string[]`. Both surfaces render the same stream through it: the editor dialog keeps its
timeline (phase label + message + payload block), the chat mirrors the lines into its review/fix
log through `useNodeFixLog`. Phase names stay localized per surface; the payload is data, not copy.

### 3.4 The chat's repair dialog shows concrete steps

`RepairProgressDialog` stops discarding the fields it is already sent: `strategy` + `attempt` on
diagnosing, `changedNodeIds` on applying, `reason` on each failed attempt. Those values are
machine identifiers and existing messages, so no new copy is needed; the row cap is replaced by a
scrollable log so the whole repair stays readable while it runs.

## 4. Rejected alternatives

- **A `GET /api/history/repair-log/:id` poller.** The stream already exists in-process; a poll
  endpoint adds transport, lifecycle and a second rendering path for the same data.
- **A second event vocabulary for "log lines".** Two event types per feature is exactly the
  parallel-infrastructure pattern §5.6 bans; the existing event type just gains a payload.
- **`payload: { request: unknown; response: unknown }`.** Forces every consumer to invent its own
  formatting (and to re-implement `describeCondition` / variable verdicts) — three copies instead
  of one projector.
- **Turning repair events into node-fix events** (or the reverse). The workflow repair settles per
  attempt against a checkpoint resume, the node fix against a live criterion; unifying the
  vocabulary would either lose fields or invent a lowest-common-denominator type. They share the
  _log rendering_, not the state machine.

## 5. Surfaces touched

| File                                                                                                                                                | Change                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/node-fix.ts`                                                                                                                      | `NodeFixEvent.payload`; `nodeFixLogLinesOf` projector; `nodeFixRequestPayloadOf` / `nodeFixReplyPayloadOf` / `nodeFixParamsPayloadOf` / `nodeFixVerdictPayloadOf` (engine data → text). |
| `src/background/workflow-engine/node-fix-engine.ts`                                                                                                 | fill the payload at every step; report the variables the criteria read.                                                                                                                 |
| `src/background/index.ts`                                                                                                                           | node-fix events by `chrome.runtime.sendMessage` (reaches every page).                                                                                                                   |
| `src/workflow-editor/sidebar/NodeFixModal.tsx`                                                                                                      | render the payload under each row (collapsible, mono, wraps).                                                                                                                           |
| `src/sidepanel/hooks/useWorkflowRuntimeEvents.ts`                                                                                                   | `useNodeFixLog`: subscribe to the shared runtime-message stream and project it to lines.                                                                                                |
| `src/sidepanel/WorkflowReviewList.tsx`                                                                                                              | `LogSection` (one collapsible live-log block, reused) and the `fixLog` prop.                                                                                                            |
| `src/sidepanel/ChatTab.tsx`                                                                                                                         | pass the projected lines to the workflow dialog, next to the review log.                                                                                                                |
| `src/sidepanel/components/RepairProgressDialog.tsx`                                                                                                 | concrete per-event detail; scrollable log instead of a 6-row cap.                                                                                                                       |
| `src/lib/i18n.ts`, `src/workflow-editor/i18n.ts`                                                                                                    | the new labels, en + zh-CN in both dictionaries.                                                                                                                                        |
| `tests/node-fix.spec.ts`, `tests/node-fix-engine.spec.ts`, `tests/acceptance-node-fix-modal.spec.tsx`, new `tests/acceptance-live-fix-log.spec.tsx` | payload content, the projector, the transport choice, the chat mirror.                                                                                                                  |

## 6. Acceptance

Each row is pinned by a named test, not by intent.

- V-log-1: running an AI fix shows, while it runs, the node parameters sent to the model and the
  parameters the model returned, per round — `V-log-1 shows the parameters sent and the parameters
the AI returned`, plus `tests/node-fix.spec.ts › the live fix log payload` for the payload text.
- V-log-2: those lines reach BOTH dialogs from one stream — no per-surface second subscription
  endpoint. The background pushes one message type to every extension page
  (`V-log-2 pushes the fix stream to every page, not only to panel ports`) and the chat dialog reads
  the same events through the panel hook
  (`V-log-5 delivers the stream over runtime messages into the workflow dialog`).
- V-log-3: the workflow dialog keeps its own review log beside the fix log
  (`V-log-3 mirrors the fix stream into the workflow dialog`); the repair dialog shows strategy /
  attempt / changed nodes / failure reason instead of canned labels only
  (`V-log-4 reports the concrete repair steps, not only canned labels`).
- V-log-4: nothing user-visible is invented: a payload line states what the engine really sent or
  received (`tests/node-fix-engine.spec.ts › runNodeFix — the live fix log` asserts the request
  carries the node's real parameters, the response the model's real reply, and a `✗` verdict only
  when a criterion really failed); the terminal result still distinguishes `criteria` from
  `exec-only`.

Browser evidence (§收尾自检 ⑤): the dialogs are extension pages, which Playwright cannot drive —
the offline suites above cover the projection, the transport and both renders; the visible stream
in a real fix run stays BLOCKED until an unpacked-extension run with a configured provider.

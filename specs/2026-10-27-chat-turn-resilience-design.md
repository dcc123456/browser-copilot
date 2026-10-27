# Chat turn resilience — a long turn must not die half-way

Status: implemented (this date)
Area: `src/background/agent.ts`, `src/background/driver.ts`, `src/lib/tool-error.ts`

## Symptom

「聊天中一轮长任务就会出现执行到一半就断了」 — in a panel chat turn, a long
task stops in the middle. The transcript ends on a tool result, the composer
returns, and the user has to type 继续 to make the model pick the task back up.

## Evidence (real conversation, not a repro guess)

Conversation `mvqqghq6-34ydyr6e` (200 persisted messages, 2 user turns):

- Turn 1 spent **exactly 100 provider requests** (21:42:36 → 21:53:31); the
  token ledger's last row is the last request of the turn. The round budget in
  `settings.json` was 60, so the loop hit its cap and the turn ended there.
- 29 of its tool calls were `run_javascript`, and every one returned the same
  Chinese refusal: «该页面的内容安全策略（CSP）禁止执行自定义 JavaScript…».
  Interleaved with them were 29 `open_url` calls that re-opened the same search
  URLs (`site:… resume`-style queries), i.e. the model kept losing and
  re-fetching the same search results.
- The saved transcript's tail is a run of tool results with **no following
  assistant message**: the loop's stop line is a transient `status` event, so
  after a reload the turn looks like it simply vanished mid-step.

The CSP refusal itself is misleading. `run_javascript` first tries a MAIN-world
injection (whose `new Function` the page CSP blocks) and then falls back to
`chrome.debugger` + `Runtime.evaluate`, which is CSP-exempt. When that fallback
fails — DevTools already attached to the tab, a policy-blocked `chrome.debugger`,
etc. — `runExecJsViaCdp` returned `null`, the real reason was thrown away, and
the model was told only "this page forbids JS". It retried the same call 29
times.

### Verified facts

- `tmp/csp-eval-spike.mjs` (real Chromium, strict `script-src 'self'`):
  page-context `new Function` → `EvalError`; raw `Runtime.evaluate` (DevTools
  context) → `42`. CDP is genuinely CSP-exempt.
- `tmp/cdp-eval-extension-probe.mjs` (built extension, `chrome.debugger` from
  the service worker) → `{"ok":true,"data":42}` on the same page.
- `tmp/run-js-csp-probe.mjs` (end-to-end: fake OpenAI SSE model → agent loop →
  `run_javascript` on a CSP page, real `dist/`) → tool result
  `{"ok":true,"result":"CSP PROBE PAGE"}`, empty attach-error log.

So the fallback mechanism works in a clean environment. The user's turn failed
because the fallback failed there, the reason was swallowed, and nothing stopped
the model from repeating the same doomed call until the round budget ran out.

## Root causes

1. **A swallowed fallback error.** `runExecJsViaCdp` collapsed every failure to
   `null`, so a fixable/environmental attach problem was reported as a permanent
   page limitation.
2. **No circuit breaker.** Nothing in the loop distinguishes "retry may help"
   from "this will fail identically forever". The advisory `previousAttempts`
   block was already in the tool result and MiniMax ignored it.
3. **A budget-exhausted turn ends silently.** At the cap the loop emits a
   transient status line and returns; no assistant message is persisted, so the
   user's transcript ends on a tool result and the task looks broken rather than
   paused with a summary.

## Changes

1. `driver.ts`: `runExecJsViaCdp` reports its failure
   (`{ok:false,error}`) instead of `null`, and `runJsInMainWorld` folds that
   reason into the final error, stating explicitly that repeating the call will
   fail the same way. Model-facing text (the tool result is JSON read by the
   model), so it stays English like the kernel's other harness errors.
2. `lib/tool-error.ts`: new `JS_BLOCKED` class (CSP / page-eval refusals) with
   recovery text; `isUnchangeableFailure()` (JS_BLOCKED, PERMISSION);
   `failureSignature()` / `nextFailureStreak()` and `REPEAT_FAILURE_LIMIT = 3`.
3. `agent.ts`:
   - Track per-turn failure streaks keyed by tool + error class + message. After
     three identical **unchangeable** failures the tool is refused for the rest
     of the turn with an instruction to change approach or report the blocker.
     Retryable classes (timeouts, stale refs, not-found) are never blocked —
     their fixes are exactly "try again with fresh state".
   - When a **panel** turn (`deps.takeInterjections` present) exhausts its round
     budget, make one final tools-off completion that asks the model to summarise
     what was done, what is left, the blocker and the next step, then persist it
     as an assistant message. Unattended runs (scheduled tasks, workflow
     `ai-agent` blocks, Feishu) and delegated sub-agents keep the existing
     `Stopped after N tool rounds…` status, because their callers classify on it.
   - The per-round streaming block is extracted into one local helper so the
     wrap-up uses the same retry/idle-timeout/summary-filter behaviour instead of
     a second copy.
4. Tests: classification + streak semantics in `tests/tool-error.spec.ts`; a new
   `tests/agent-turn-resilience.spec.ts` covering the breaker (4th call refused,
   driver not invoked) and the wrap-up (final request carries no tools, assistant
   summary persisted; unattended run unaffected).

## Rejected alternatives

- **Raise `maxToolRounds`.** It buys more identical failures, not a result; the
  user's turn already spent 100 requests.
- **Block any tool after N identical failures.** A retried `click` that fails
  with the same not-found message may succeed after a fresh snapshot; only
  environment-level classes are treated as unchangeable.
- **Retire fewer page reads so the search results stay in context.** This is the
  context-policy theme (token cost vs. retention), not the stop itself; it needs
  its own measurement. The wrap-up plus breaker already removes the pathological
  loop.
- **Run the wrap-up for unattended turns too.** Their callers depend on the
  `Stopped after…` status to fail the step loudly; a partial summary would look
  like success.

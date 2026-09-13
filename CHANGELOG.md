# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — AI debugging reliability

- **Offline success-rate benchmark** (`tests/bench/`, `pnpm bench:debug`):
  8 deterministic scenarios driving the real `runDebugSession` with all
  dependencies injected — no browser, no model, no network, safe in CI. Strict
  metric: `verified = takeover-free pass AND goal achieved`.
- **Session telemetry**: `debugSessionStats` + `workflows.debugStats` + panel
  display (success rate, p50/p90 duration, failure phase and reason breakdown).
- **Global retry budget + escape hatch**: a takeover is now capped across the
  whole session, not just per node; exceeding it ends the episode with a reason
  instead of burning model calls.
- **Server tab pinning**: the takeover drives the same tab the run logged.
- **Structured validation results**: debug failures carry `failureReason` +
  `suggestedAction`.
- **Perf/network semantic summary**: console + network buffers are compressed
  into one "page health" line fed back with tool results.
- **Observer preflight** (opt-in, `BC_OBSERVER_PREFLIGHT=1`): a read-only check
  before the first takeover attempt that skips the agent entirely on a
  captcha/login wall.
- **Checkpoints + failure memory**: shared `checkpoints.ts` /
  `failure-memory.ts` modules; retries are primed with structured memory of
  earlier failures of the same node.
- **Per-step checkpoints, persisted**: the engine now reports a checkpoint for
  every settled node (ok / failed / cancelled), written by the extension to
  `checkpoints/<runId>.json` (file area when a data directory is configured,
  else `chrome.storage.local`) and by the server runner to
  `<dataDir>/checkpoints/checkpoint-<runId>.json`. Oldest runs are pruned
  automatically (20 kept by default).
- **Idempotent per-node retries**: attempt 2+ now starts from the variables the
  node saw BEFORE attempt 1, instead of inheriting the half-written state a
  failed attempt left behind (a form already partly filled, a counter already
  bumped) — the same non-idempotency trap, one level down.
- **Session correlation (M4)**: one `sessionId` is stamped onto every run a
  debug session spawns (takeover pass, fix-verify, rewrite-verify) and onto its
  pending-fix records, so runs, checkpoints and takeover stats can be joined.
- **Resume from checkpoint (M4)**: `resumePointOf` derives where an interrupted
  run picks up — the node after the last step that settled cleanly, carrying
  that step's variables. `executeWorkflow({ resumeFrom: runId })` and the new
  `workflows.resume` command use it, reading the in-memory store first and
  falling back to the persisted copy so a restart does not lose the point.
  This is the recovery path for non-idempotent flows: re-driving a login that
  already happened can only fail, so the retry skips what already landed.
- **Resume reaches the panel (M4)**: a workflow whose last run failed now shows a
  **Resume** action next to Run. The panel asks the new `workflows.resumePoint`
  command whether a clean checkpoint exists and only offers the action when it
  does, so it can never advertise a resume that would silently re-run
  everything. The run behind the point is resolved through the persisted index
  when the worker session no longer remembers it — an MV3 worker is evicted once
  a run settles, which is exactly when the user goes looking for Resume.
- **Configurable budgets**: `BC_TAKEOVER_MAX_ATTEMPTS`,
  `BC_TAKEOVER_TOOL_ROUNDS`, `BC_TAKEOVER_AUTORUN_BUDGET`.

### Fixed — AI debugging

- **Non-idempotent workflows no longer retry forever** (login / submit-order /
  send-message / register / pay). Previously a workflow that had ALREADY
  succeeded was judged "not achieved", retried — and because its preconditions
  were gone (there is no login page once you are logged in) every retry failed
  identically, looping until the rounds ran out and then re-looping through the
  replay phase. Three guards now make that impossible:
  - the goal judge returns `alreadySatisfied` when the goal's END STATE already
    holds, and a failed run is judged with that framing (`runFailed`);
  - the session consults the terminal-state check before EVERY retry, before
    the replay escalation and before the rewrite-verify verdict, and reports
    success immediately when the goal already holds;
  - a repeated-dead-end breaker (`REPEAT_FAILURE_LIMIT`) stops the session when
    the same failure signature keeps coming back, telling the user to reset the
    page state instead of looping.
  - The replay prompt also instructs the agent to recognise an already-done
    goal instead of hunting for a form that no longer exists.
  - New benchmark scenario `S9-non-idempotent` pins the behaviour: it ends as
    `✅ 终态已满足` after a single takeover phase, with no replay and no retry.

### Added — Runner hardening

- Timing-safe (`crypto.timingSafeEqual`) Bearer-token auth; **removed the
  `?token=` query-string fallback**; the runner now refuses to boot without a
  token unless `BC_ALLOW_UNAUTHENTICATED=1`.
- CORS allow-list (`BC_CORS_ORIGIN`) and per-IP rate limiting
  (`BC_RATE_LIMIT_MAX` / `BC_RATE_LIMIT_WINDOW`).
- zod request validation for `POST /api/runs`, `POST /api/hooks/:id` and
  `PUT /api/config` (structured `400` + field details).
- Structured `pino` logging throughout (replacing `console.*`), request
  id propagation, and a unified error sink (`server/src/observability.ts`).
- `server/config.json` written with `0600` permissions.

### Added — Engineering

- CI workflow (typecheck, test, lint, format, build, benchmark, server gates),
  Dependabot, `CODEOWNERS`, ESLint flat config, Prettier, coverage baseline.

### Changed

- Automatic runs (`takeoverOnRun`) are now limited to a **single** takeover
  episode (cost ceiling).
- `workflows.takeoverApply` accepts an optional `verify` flag to run a
  takeover-free verification pass after applying a fix (default off).
- Server takeover can apply the agent's `paramsPatch` to an in-memory copy and
  write an audit artifact when `BC_TAKEOVER_APPLY_PATCH=1` (default off).

### Fixed

- Interaction blocks now wait on **every** run (not only debug first rounds).
- Transient LLM failures (429/5xx/network) are retried with backoff, never
  after a stream body has been consumed.
- Snapshot element cap respects the requested `maxElements` (ceiling 250).
- Verdict parsing no longer treats a truncated payload as success.

[Unreleased]: https://github.com/dcc123456/browser-copilot/compare/v0.6.1...HEAD

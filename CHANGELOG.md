# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.6.3] - 2026-09-16

### Added — Built-in agents & delegation

- **Agent type distinct from Skill**: agents are active, delegatable
  execution units with their own `AGENT.md` persistence, import/export
  and background handlers; skills stay passive injected instructions.
  Six built-in agents ship (one supervisor + search / writing / ops /
  workflow / analysis specialists).
- **`delegate_to_agent` tool** in an on-demand group: runs an isolated
  sub-agent loop (own namespaced conversation id and history, whitelisted
  tools, ≤1200-char summary + artifact references) under the parent's
  confirm / scope. Three hard gates: small-task refusal costing no LLM
  call, ≤4 delegations per turn, ≤1 retry per (agent, task). Delegation
  is opt-in for panel turns; unattended runs stay single-agent.
- **Agents tab** in the side panel, mirroring the skills pattern:
  create / edit name, delegation hint, role, domain, tool whitelist,
  linked skills, delegation flag, round cap and instructions;
  drag-and-drop import and JSON export; built-ins are read-only with a
  "duplicate as mine" action.
- **Built-in agents are editable**: edits keep the `id` and the
  built-in marker under a real `updatedAt`, and the seeder matches by
  `id` first so a renamed built-in survives an upgrade. New
  `agents.reset` command and **Restore default** button write the
  shipped version back (`updatedAt: 0`).
- **Multi-window agent isolation (MCP)**: local bridge now binds
  `agentName → windowId` (N:N, schema v6) plus a per-worker
  `agentId → windowId` map for renames. An unassigned connection is
  refused with an actionable bilingual error once any binding exists;
  `ping` / `tools.list` stay open. `pin_tab` and the resolved-tab
  cache are scoped per window. New worker commands
  `agent.windows.list` and `agent.bindings.set`.
- **Built-in agent i18n**: display name, hint and instructions follow
  the user locale; user-edited built-ins show their custom content.

### Added — Workflow secrets

- **Secrets are no longer embedded in workflows**: when a workflow is
  generated from chat history, `get_secret` actions now emit a
  `get-secret` block that fetches the credential at runtime and stores
  it in a variable, with a downstream `forms` block that references the
  variable. Credential updates are picked up on the next run for free
  and the value is never written into the workflow body.
- **`get-secret` block becomes a dropdown**: catalog data, edit form
  and executor carry a `(credential · field)` pair loaded via
  `listPasswords()` (encoded as `credential="<id>::<field>"`). Older
  workflows with separate `secretId` + `fieldName` keep working through
  a backward-compat fallback. Static imports in the executor fix the
  `window is not defined` crash the MV3 service worker hit on
  `await import()`.
- **`BLOCK_FORM_STRINGS`** gains Credential label, "Loading
  credentials / no credentials" copy and a tip about runtime
  resolution.

### Added — Workflow editor UX

- **Pan / box select**: left-drag pans the canvas; holding Space
  switches to rubber-band selection. Cursor updates via
  `[data-pan-mode]`.
- **Unsaved-changes guard**: `beforeunload` surfaces a native confirm
  when closing the popup mid-edit.
- **Plain-language node descriptions**: generated JavaScript nodes are
  titled by their effects (click, fill, React-compatible value set,
  navigation, storage, network, event dispatch, scroll, …) instead of
  by the first line of code, with specificity-ordered phrases and a
  per-node cap so long batch scripts stay readable. Existing leading
  comments still win.

### Added — SEO & landing page

- **SEO meta** added to all extension HTML pages (description, favicon
  links, unified `lang`); manifest gains `short_name` / `author` /
  `homepage_url`; `package.json` gains repository, bugs, author and
  keywords.
- **Bilingual landing page** (`website/`) with full SEO meta, Open
  Graph, Twitter Card and JSON-LD structured data, auto-deployed by
  `.github/workflows/pages.yml`.
- **Shields.io badges** added to both READMEs.

### Added — Documentation

- **MCP multi-window agent assignment**: setup section explaining how
  to bind each connected agent to its own browser window, the
  isolation semantics, scoped `pin_tab`, refusal of unassigned
  connections, `BROWSER_COPILOT_AGENT_NAME` disambiguation, and the
  `agentId` / `agentName` identity fields in the WS protocol table.

### Fixed

- **Scheduled workflows no longer "look unstarted"**: `executeWorkflow`
  now accepts `reuseRun` so a task-runner-opened run is the one its
  steps land on. Per-storage-key write serialisation in `task-store`
  prevents `recordFinishedRun` / `addRun` / `saveTask` from losing
  each other. The opening line is per-kind (no more "Starting agent
  task…" on a workflow task), and the run `source` is read from the
  tracked value so both halves of one run stay in the same history
  section.
- **`pnpm dev` / `pnpm build` / `pnpm package` restored**: the
  previous scripts/vite.mjs wrapper was never committed; pointing the
  scripts back at `vite` directly is the working state.

## [0.6.2] - 2026-09-13

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

### Added — Side panel

- **Thinking and tool calls separated in the transcript**: model reasoning
  (`think` blocks) renders in its own collapsed style and tool calls no longer
  appear in the middle of an assistant reply, so one turn no longer reads as
  split paragraphs. Model-only envelopes (active-skill directive, page-selection
  block) are hidden from the user's own bubble through a `displayContent` field
  that is stripped before provider requests.

### Fixed

- Interaction blocks now wait on **every** run (not only debug first rounds).
- Transient LLM failures (429/5xx/network) are retried with backoff, never
  after a stream body has been consumed.
- Snapshot element cap respects the requested `maxElements` (ceiling 250).
- Verdict parsing no longer treats a truncated payload as success.
- **Conversation answer download**: `downloadBlob` relied on an
  `<a download>.click()` plus revoking the blob URL at `setTimeout(0)`, which
  races the browser's async download start and silently drops the file from the
  side panel ("clicking download does nothing"). It now routes through
  `chrome.downloads.download` and revokes the URL only once the transfer is
  accepted, keeping the anchor path as a non-extension fallback.
- **Workflow trigger edits now stick**: the trigger block is denormalized into
  the workflow's top-level `trigger` on editor save (`triggerFromNodes`), so the
  list chip and background listeners reflect the edited launch type. The list
  chip reads the effective trigger kind and six more trigger labels
  (interval / date / weekly / startup / shortcut / element-change) are localized.
  Workflow Import moved into a hover/focus bubble attached to the **New** button.
- Copy/download actions on assistant bubbles stay hidden while a chat answer is
  still streaming and appear only after the turn completes.

[Unreleased]: https://github.com/dcc123456/browser-copilot/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/dcc123456/browser-copilot/compare/v0.6.1...v0.6.2

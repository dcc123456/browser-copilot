# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_To be released._

## [0.6.12] - 2026-10-26

### Fixed — An imported credential shows up without a reload

Applying a listing that carries credentials writes them in the background, but
the Data tab and an already-open `get-secret` form had read the vault once when
they mounted, so the new entries and field names stayed invisible until the
panel was reloaded. Both now listen for vault changes and refresh in place.

### Added — Credentials travel with a published workflow

Publishing a workflow that uses stored credentials now lists the referenced
credential and field names in the publish dialog and commits them with the
listing. Password-style fields start empty and every other field starts at the
local value; both can be edited, and a filled password raises the existing
"publish anyway" warning. Applying such a listing imports the credentials into
the local vault before any workflow is saved, rewrites the `get-secret` steps in
the parent and its bundled sub-workflows to the imported ids, so the workflow
runs without picking a credential again. Re-applying keeps values the user has
already typed and only adds missing fields.

### Added — A bundled workflow arrives as its own group

Applying a marketplace workflow that calls other workflows now creates a group
named after the parent and files the parent plus every bundled sub-workflow
into it, so the call graph shows up together in the workflows list. An
existing group with that name is reused, and re-applying an update leaves the
workflow wherever the user put it.

### Added — Publish drafts survive closing the dialog

Closing the publish dialog halfway through now saves the form — title,
description, category, tags, video link, screenshots and attachments — as a
draft for that workflow. Opening the same workflow's publish dialog restores
it, and the draft wins over the copy previously published on GitHub. A
successful publish, the "Discard draft" link, or 30 days of inactivity clears
it; at most 8 drafts are kept.

### Changed — Publishing merges its own pull request

A publish now merges the pull request right after opening it when the GitHub
token may write to the marketplace repository, which today means the
maintainer's own releases: the workflow is live immediately and the marketplace
cache is dropped so the card shows up on the next visit. Third-party
publishers keep an open PR for review, exactly as before. Setting
`MARKETPLACE_AUTO_MERGE_PULLS` to `false` restores review for everyone.

### Changed — Marketplace card actions are icons

The marketplace card now carries the GitHub link as an icon beside the workflow
name, and shows like and comments as icon buttons with their counts side by
side in the action row. The like control left the discussion panel, which is
now comments only, and the owner action is labelled 下架 (delist).

### Added — Model settings live in their own tab

Providers, the image model and the AI-takeover model moved out of the general
Settings tab into a dedicated **Model settings** entry in the More menu; both
tabs share one settings store. The add-provider menu puts the custom endpoint
last, and fetched models became a checkbox list so several can be added at
once.

### Added — A scheduled task can carry several trigger methods

Task editing now holds a list of trigger methods instead of one schedule, and
each entry arms its own alarm — one added method is one more scheduled run. The
top-level schedule stays the mirror of the first entry, so existing records need
no migration, and the list shows one chip per method. Five-field **cron**
expressions join the presets, so cadences like "the 1st of every month" or "every
two hours" no longer need a fake weekly list; they are evaluated in local time
through the same parser the Runner already uses, invalid text keeps the editor
from saving, and a pattern that can never occur stays unarmed with a hint. The
`create_scheduled_task` agent tool gained `kind: "cron"`.

### Added — Create a workflow inside a group

Every group header carries a plus action that opens the editor with that group
already targeted, and the first save files the new workflow into it — a later
move from the panel still wins. Empty groups now stay visible so they can
receive their first workflow.

### Added — Editor save state, record-to-canvas and a data table

The Save button is marked while the graph differs from what is on disk, keyed off
a content fingerprint so React Flow's measurement renders never dirty a fresh
workflow. Recording now appends its steps to the open canvas after the terminal
node instead of persisting a second workflow, and a bottom-centre undo / redo /
auto-layout bar joins them; auto-layout keeps clear of the left palette and the
zoom controls moved beside the minimap. A new **Data table** tab explains the
run-scoped variable and lists every writer, reader and written column with
jump-to-node links, and the sidebar header shows a copyable workflow id.

### Changed — The trigger block edits exactly one trigger

The "Workflow triggers" list modal is gone: any change writes a single launch
config, matching what the scheduler can actually arm. A graph imported with
several triggers keeps its primary spec and says so.

### Changed — Webhook header and body panels

The webhook block mirrors Automa's HTTP request editor: a segmented tab strip, a
seven-column grid for header rows with an icon remove control and a full-width
add button, and an inset body preview that opens the body editor in a modal.
Switching to GET/HEAD now falls back to the headers tab instead of leaving an
empty body panel behind.

### Changed — Chat actions sit under every round

Copy and download moved out of the reply bubble into an action row **below** each
finished round (the user's own messages included), revealed on hover or keyboard
focus like desktop agent clients, with the download picker opening upward. Earlier
replies are exportable again instead of only the newest one.

### Fixed — Reasoning tokens always read zero

OpenAI and DeepSeek bill reasoning inside the completion and report it under
`completion_tokens_details.reasoning_tokens`, which the usage parser never read,
so the chat token bar always showed zero. It now prefers the completion-side
field and keeps the old one as a fallback for other gateways.

### Fixed — New group and batch move are distinguishable

Both used a bare plus beside "new workflow" in the workflows header; new group
now shows a folder with a plus and batch move a folder with an arrow.

### Docs — How to update an install without losing data

Both READMEs now describe the two upgrade paths: the in-place updater that ships
from 0.6.8, and the one-time manual file swap older installs still need, with the
reason an in-place swap keeps the extension id (and so its stored data) while
loading the new zip from another folder does not.

## [0.6.11] - 2026-10-26

### Fixed — The marketplace says why a refresh failed, and asks GitHub less often

A failed marketplace refresh used to fall back to the cached cards under a
generic "could not reach GitHub" message, so a shared anonymous rate limit
looked like a network outage. The stale banner now names the real cause, and
for a rate limit it shows the reset time. The catalog freshness window moved
from 30 minutes to 2 hours (`MARKETPLACE_CACHE_TTL_MS`) because the updater and
the marketplace spend the same 60-request/hour budget; manual refresh still
bypasses the window.

### Fixed — Update checks no longer drain the GitHub API quota

The updater and the workflow marketplace share the anonymous 60-request/hour
budget, so normal use could leave the next release check rate-limited and
stuck. A routine check now follows GitHub's public `/releases/latest`
redirect, which settles on the newest tag page without spending API quota, and
asks the API only once a newer tag actually exists — for the asset digest and
notes. A blocked or unreadable probe falls back to the old API path. A failed
check still retries at GitHub's reset time or with 15-minute-to-6-hour
backoff, a successful check clears it, and opening the panel or settings
re-checks a state older than the 12-hour window so a missed alarm heals by
itself.

## [0.6.10] - 2026-10-26

### Added — A workflow marketplace with no new server

Workflows are now shared through the public GitHub repository that already
backs the project. Publishing starts from the workflow card: category, tags,
cover, video and up to three attachments of 200 KB each are written to
`workflows/<slug>/` through a fork and a pull request, and the maintainer
merges it by hand. 工作流广场 lists every published workflow with its author,
category, tags and engagement; search, category filters and sorting narrow the
list, and likes and comments ride the merged PR's reactions and thread. Applying
a card asks for a trust confirmation first, installs a local copy with its
triggers disabled (never auto-run), and reuses that copy on a later apply
instead of stacking duplicates. Installed workflows show an update reminder when
the publisher moved ahead — a newer version, or a changed content hash at the
same version, so a listing that was removed and re-added under an old number
still reaches its users; a published version below the installed one is never
offered. Updating replaces the steps, trigger and settings while keeping the
local id, folder and creation time. Authors can re-edit a published workflow
(title, description, category, tags, video, images and attachments prefill) and
unpublish it through a deletion PR. A workflow that calls other workflows
bundles them into the same publication, and applying the bundle rewrites those
calls to deterministic local copies. Categories gained more built-ins and
publisher-defined entries. The marketplace card renders author, category and
tags as three distinct chips (neutral, filled accent, bordered `#`).

### Fixed — Storage reliability and lost folders

Switching the storage folder now carries the departing folder's data first:
collections merge per record, transcripts and checkpoints travel whole, skills
and agents land per entity file unless the adopted folder holds a newer copy,
and config never moves. A permission still pending is re-granted in the same
click, and a switch that cannot be completed is refused with a reconnect hint
instead of dropping the only copy. Directory changes are announced to every
context and the background's cached handle is dropped, so writes stop landing in
the old folder. A permission downgraded to `prompt` by an extension update is
re-tried when the panel becomes visible or the window regains focus. Editing a
workflow that is already open focuses its editor window instead of opening a
second copy, and a newly created workflow records its editor URL as soon as the
graph loads.

### Fixed — Marketplace reads

A raw-host response is cached for five minutes, 404s included, so the refresh
right after a merge could miss the new listing; metadata reads now bypass that
cache with a unique query while the API reads stay the same. A tree that lists
workflows but yields no readable metadata is treated as a failed read instead of
caching an empty catalog, an empty repository reads as an empty catalog, and a
failed GitHub connection reports its real cause.

## [0.6.9] - 2026-10-24

### Added — Automa-aligned control flow and operators

While loops, Repeat Task and Loop Elements join the loop family. Loop Data and
Loop Elements now expose a single output: the after-loop path belongs to the
loop breakpoint, and stored `output-2` graphs are migrated to the linear shape on
load and save while legacy edges still run as a fallback. Webhook, multi-trigger
workflows and breakpoint debugging arrive together — a `$breakpoint` node pauses
only in Testing mode, and the pause point, variable snapshot, resume and stop all
ride the existing debug bar. Set Variable writes several variables in one node,
and the trigger and webhook helpers are shared by the extension and the Runner.
The editor sidebar narrows to workflow identity and block search, the palette and
logs modal widen, `upload-file` picks its source in a dropdown, block fields can
be edited in a popup, and the operator-guide vocabulary is updated.

### Added — An editor assistant that shows its thinking and writes every operator

Model output streams back with reasoning and answer on separate channels and
stays behind a "Model output" disclosure; thinking effort is sent with the
request and a level the model cannot express is named in the editor. The
assistant may write all 60 writable operators (triggers, proxy and browser
events excluded), and the generation prompt grows from 7.5k to 13k characters
instead of 34k. Hand-picked elements are now editable attachments in step order:
they can be edited or deleted, carry their locator strategy and selector, and
fill empty slots at send time; unused picks are kept for the next message. An
edit that changes no parameter is refused as `no-change` (no undo entry, no
success toast, no certification reset), while a landed edit lists every changed
key old → new with secret values masked. A new-chat button clears the transcript
and bumps a generation counter so an in-flight reply cannot land in it, and the
composer has a drag/arrow height grip (52–240 px). A user edit clears the AI
provenance badge, which answers whether the assistant placed the step.

### Added — Goals, variable access and file paths

A Goal tab edits `settings.goalSpec` summary and success conditions visually,
preserves terminal-state rows, requires a complete row before saving, confirms
deletion and disables L3 certification, and marks the workflow unverified on any
change. Variable references resolve array and object access — `{{rows[0].name}}`,
`{{obj["key"]}}` — through a root variable plus accessors, and the save-time
scanner, provenance tracking, repair strategy and task chaining share that
resolution. `upload-file` and `parse-excel` paths accept `{{variables}}` through
a `{}` menu, and latest-download scans authorised download roots recursively so a
newest file in a subfolder is still found. `parse-excel` detects content first,
so a delimited text export named `.xlsx` parses instead of failing on a truncated
ZIP container; OLE `.xls` magic is still rejected explicitly, unreadable files
report the real cause, and repeated BOMs are stripped.

### Added — A bilingual operator reference

A bilingual reference covers all 63 operators with category pages and stable
anchors, guarded by a coverage check that every palette operator is documented
exactly once; the landing page navigation, footer and section link to it. Block
info icons in the property panel and on palette cards now point at the operator
manual, opening the `-zh` pages from the Chinese locale, and the five custom
operators link there too. The JavaScript code block's helper chips explain each
function's purpose and timing; the audit found `automaFetch` implemented in no
harness and `automaNextBlock`'s `insert` argument unused, so they were removed or
corrected, and a contract test verifies every helper against the page harness,
the local fallback and the Runner.

### Fixed — Close-tab targeted the focused tab

The close-tab operator now closes the tab the run is driving rather than
whatever the browser has focused, no longer reports success when there is nothing
to close, and follows the surviving tab only inside the run's own window instead
of carrying the run into another window. Stored readiness expectations now follow
a value the user later edits, so fill-type blocks stop reporting
`READINESS_TIMEOUT(value-committed)`. Debug mode and ordinary runs share one
behaviour contract, and an idle-timeout failure no longer masquerades as "Cannot
reach the base URL".

## [0.6.8] - 2026-10-22

### Added — In-place self-update from GitHub Releases

Unpacked Chrome installs can update themselves without a server. The panel checks
GitHub's `/releases/latest` every 12 hours and on install/startup, verifies the
package's SHA-256 digest, downloads and extracts the ZIP with path and size
validation, then overwrites the folder the extension was originally loaded from.
That folder is requested once and reused on later updates. Before anything is
replaced, every affected file is copied into a timestamped
`browser-copilot-backup-<version>-<time>` folder inside the install directory —
the old root manifest is stored as `manifest.json.bak`, so the backup cannot be
loaded as a second extension — and `manifest.json` itself is written last, so a
failed write leaves the running version intact. A banner offers the update; the
dialog confirms and ends with a reload action, and the new version takes effect
after `chrome.runtime.reload()`. Firefox and store installs get a release-page
link instead. No remote code is fetched into the running extension: the new
package only runs after Chrome reloads it.

### Added — Multi-model provider profiles and thinking effort

A provider profile now stores every model the user added plus the one in use, and
can send a thinking-effort parameter when the vendor supports it. Presets only
suggest a model, so a prefilled value no longer filters fetched suggestions down
to one entry. The vendor table resolves levels per model family: Qwen3.8 takes
`reasoning_effort` and refuses a token budget in the same request, older Qwen3
keeps the token budget across its documented range, MiniMax accepts a level only
on M3.1-Flash (which always thinks), M3 can be turned off but takes no depth, and
the M2 series always thinks and receives no control at all. Levels a model cannot
express are disabled in the editor, and a rejected request is restated in the
panel's language.

### Added — Workflow groups and batch import/export

The Workflows tab gains collapsible group sections backed by the existing
`folderId`, so grouping only rewrites membership and does not bump revisions or
`updatedAt`. Groups can be renamed, deleted (orphaned members fall back to
ungrouped), and exported as an envelope that carries its member workflows and can
be imported again. Checkbox selection drives batch export of checked workflows,
and the Data tab uses the same selection model for secrets and profiles with a
`browser-copilot-data` envelope. Imports always create new records with fresh ids
and never overwrite local entries.

### Added — Canvas groups, structural undo, and page-grounded AI edits

- A `blocks-group` group block lands on the canvas; its children live in the
  group's own data rather than in the drawflow graph, and the engine, integrity
  checks, run validation, operator classification and edge plumbing all account
  for that. Groups fold by clicking their name, reorder by dragging the header,
  and every card has its own move-to-group menu. Editing a workflow now merges
  the save over the stored record, so its group, plan, table, `createdAt` and
  revision line survive.
- `Ctrl+Z` walks the canvas's structural history back: connections, deletions,
  palette drops, drags (one entry per gesture), auto layout and every landing the
  assistant produced. There is no redo. The handler leaves the key to the field
  whenever focus is in a text input or CodeMirror.
- The floating assistant grounds its answer in a live page snapshot, accepts
  locators the user picked on the page (they outrank the DOM read), can chain
  operators in front of the selected step, and gained edit/replace actions for a
  selected node. When a required parameter cannot be derived from the DOM, the
  automatic retry rides with a screenshot — inline when the vision model is
  answering, otherwise as a description.

### Added — Element picker pins the Nth match and picks by text

A broad selector that matched several repeated rows used to be committed as-is,
so executors silently acted on the first visible match. When the picker finds
more than one match and the consuming block is not an all-matches consumer, the
committed selector is now pinned to the aimed element: the plain selector when it
is unique, otherwise a forced `:nth-of-type` path, then an absolute `:nth-child`
path (XPath wrapped as `(expr)[n]`). A match stepper switches matches and Enter
commits the pinned selector; loop blocks and `multiple` consumers opt out. Text
mode fills the selector with the element's visible text and counts matches with
the kernel's tightest-holder strategy, and verify mode outlines every match
before replying. The picker now swallows `pointerdown`, `mousedown` and `click`
at the window capture phase and can submit on hover plus Enter, so an overlay
that closes on any click no longer defeats it.

### Added — Latest-download uploads, Excel parsing, and specified-path sources

- **`upload-file`** can take the newest matching file from the configured or
  internal download folders (extension) or from the run's recorded downloads
  (Runner), with an optional manual fallback.
- **`parse-excel`** turns `.xlsx`/`.csv` into object rows plus the raw 2-D array,
  through a dependency-free parser shared by both hosts.
- Both operators can target one concrete file stored as a download-relative path
  and picked through a recursive editor list. The extension resolves nested OPFS
  paths; the Runner falls back to the recorded flat file name because headless
  downloads do not preserve directories.

### Added — Failure evidence and goal certification for generation

A failed operator call now carries an evidence bundle: the failure classified
through the shared code table, the kernel's message kept bounded, locator
resolution, candidate counts, and the safe re-run boundary. That boundary is the
last step that committed nothing — re-entering before a submit or publish would
commit it twice — and it is derived from the draft's own nodes. The generation
prompt states both rules: a committed step is never re-run, and a failure caused
by an earlier step is named rather than repeated. The pre-save trial also records
what the goal check actually found (level, unmet rows, reason) and carries it
across a save/load round trip; the save card distinguishes a broken graph from a
graph that ran and left the goal unmet, while a trial that stopped before the
last step still proves nothing and stays silent.

### Changed — One switch for capability toggles

The task panel's per-task enable, the Feishu bot and per-tool toggles, the
editor's boolean block fields, and the Runner console's schedule and trigger
controls now render through one hand-written switch (`role="switch"` with
`aria-checked`) instead of a checkbox. Multi-select and preference checkboxes
remain checkboxes.

### Changed — Saving a workflow no longer offers an AI review

The optional AI review on the chat save-as-workflow card is gone; saving always
persists the captured steps directly. The history review dialog is untouched.

### Fixed — A dropped stream resumes; the ungrouped section collapses

Chat streaming now allows ten fixed-interval reconnects and treats one full
request as the retry unit: a reply that already emitted text resumes from that
point instead of restarting, a stream ending with neither `[DONE]` nor a
`finish_reason` is recognised as the same transient break, and an in-stream error
frame is no longer swallowed. A tool call that was already announced is never
resumed, because half-formed arguments cannot be safely continued. Summary blocks
echoed by full-auto mode are filtered out of the visible reply.

The chevron on the Workflows tab's ungrouped bucket did nothing because the
toggle handler returned early without a group id; it now has its own
collapse-state key and folds without disturbing the groups above it.

## [0.6.7] - 2026-10-19

### Added — An AI assistant on the workflow canvas

The canvas offered two ways to grow a workflow: drag an operator from the palette,
or generate the whole flow from the side panel — and nothing for "add the next
step and fill in its parameters". A round AI button on the canvas now opens a chat
dock that sends the transcript plus a digest of the current graph, and lands the
operators the model picks straight onto the canvas: spliced after the selected
step, or after the end of the main line, chained in the proposed order. A landed
batch is one click from removal, and every AI-authored node keeps a violet
provenance ring and badge so it stays distinguishable from what you wired yourself.
It neither trials a run nor stores a transcript — execution and page evidence stay
with Run / AI Fix.

### Added — Repair reflects on why a round failed

A repair round that ran and still failed used to start the next attempt with
nothing to show for it: the ladder advanced a strategy while dropping everything
the failed candidate had learned, and its prompt carried no page evidence at all,
so the model re-guessed selectors it had already guessed wrong. Reflection is now
a separate model call whose evidence is a live inspection of the page **as it
stands after the failed replay** — the failure scene itself. A reflection may
propose a different strategy, but only as a proposal: the same safety, budget and
dead-end rules the ladder obeys apply to it, so it can reroute the ladder without
becoming a way past the policy gate. An unavailable or mangled reflection degrades
to nothing and the loop behaves exactly as before.

### Added — Two tab-driving blocks do what their labels promise

- **`reload-tab` takes a URL**: filled in, it replaces the tab's address and loads
  that; empty, it keeps reloading the page where it is. The field shares its
  implementation with `open-url`, so the scheme guard and the "one navigation,
  never goto plus reload" rule stay one behaviour.
- **`new-tab` can reuse a tab it opened earlier**: the "update previously opened
  tab" checkbox existed with its label but no executor read it, which is why it was
  left out of the model schema. Each `new-tab` now records the tab it landed on
  and a later one that asks to reuse goes back there instead of stacking another.
  A tab closed since then falls back to creating one.

### Fixed — A native dialog no longer hangs the run forever

A page's native `alert`/`confirm`/`prompt` parks the renderer's JS thread, so a
workflow step whose click handler alerted never settled and the run hung with no
error at all. The CDP monitor now answers `javascriptDialogOpening` (accepting
alert/confirm/prompt, dismissing beforeunload), and every injected operation is
backstopped by a 30-second injection timeout for tabs without a debugger.

### Fixed — A doubled URL scheme after variable interpolation

A `new-tab` URL assembled as protocol dropdown + `{{variable}}` interpolated to
`http://http://host//path` whenever the variable held a full URL, and the browser
parsed that as host `http` with an empty port. The doubled scheme is now collapsed
before navigation, so full-URL and host-only variables both work.

### Changed — Data-tab profiles and credentials edit in dialogs

The inline editor cards pushed the list around while you typed. Create and edit
now happen in the shared FormDialog — the same split as the skill and task
editors — with required-field gating on the save button and save failures
reported inside the dialog where the backdrop cannot hide them.

### Chore

`@pnpm/exe` is no longer offered among the managed package managers.

## [0.6.6] - 2026-10-16

### Added — One get-secret node, several credentials

A node could name exactly one credential, which made a workflow with two APIs cost
two nodes. It now holds a list: pick a credential, and its variable name defaults
to that credential's key and stays editable. Rows stay reachable even when nothing
is stored yet — the add button used to disappear behind an empty state, so the
panel looked dead. A blank row never reaches the graph, and only the reference
(`label · fieldKey`) is ever persisted: values are fetched at run time from
`BC_SECRET_*` in the Runner, and the extension keeps no copy. Guidance now also
tells the model when a plain input block is the better answer to a sensitive value.

### Added — Branch paths in conditions

Conditions can name each branch and the paths a value takes through the tree, so a
`switch`-style graph no longer hides which path ran. A new `elementValue` kind
compares against the text an element actually holds, with a picker on the operator
panel. Older shapes migrate on read; the stored format keeps working.

### Added — Live progress, prompts instead of logs, and duplication

- **Live thinking in chat**: the panel streams the model's reasoning, labels each
  tool call with a plain-language intent, and ticks an elapsed clock per step.
- **AI fix from a prompt alone**: the node-fix dialog no longer requires a log to
  paste — type the goal and it runs. Both repair dialogs then show the same
  detailed fix log as it streams, from one shared event stream.
- **Goal contract in view**: every operator panel can expand the explanation of
  what per-step verification and AI fix actually run on, without expanding the
  section by accident.
- **Workflow duplication**: the Workflows tab copies a saved workflow under a
  fresh id and an auto-generated `"(copy)"` name. The copy starts with no revision
  history — it has earned none — and its trigger is rescheduled in the same step.

### Added — `/` in string fields

Every operator parameter that takes a string opens a variable menu when you type
`/`. Suggestions are scoped to what the node can read at run time (upstream names,
loop context, reader aliases); picking a credential reuses a reachable get-secret
producer or splices a new node upstream, and never writes a secret value anywhere.

### Fixed — Canvas box-select and the empty add button

Holding Space on the canvas now rubber-band selects and, on release, hands the
canvas back to dragging: React Flow never sees a trusted Space keydown in this app,
so the gesture runs off the editor's own key state. And "Add credential" stopped
being a no-op for an operator with no credential stored — that button did not exist.

### Fixed — Attributing an ai-agent block's turn

A workflow's `ai-agent` block bills its turn to a per-node nonce id, so the Tokens
board could neither name nor open that spend. The run's attribution is now threaded
into the nested turn; vision calls and context compaction inside the block ride
along.

## [0.6.5] - 2026-10-15

### Added — Where the tokens go

Model spend was invisible: nothing told you what a chat turn, a generated
workflow, or a nightly task cost. Every provider response is now read for usage
(`prompt_tokens` and `input_tokens` shapes alike, including cached-input counts)
and folded into a ledger that keeps a capped array of detail records for sub-day
buckets plus uncapped per-day rollups for long windows.

- **Tokens tab** under **More**: range chips (today / 7 days / 30 days / since
  first use), a smooth trend line or tables, one headline figure for the window,
  then a breakdown **by feature** — chat, workflow generation, workflow run, AI
  debugging, automatic repair, scheduled tasks, context compaction, vision,
  external API — and **by conversation, task or workflow**. Rows past the
  retention cap fold into an explicit "Other" instead of quietly vanishing. The
  panel is ~400px wide, so each row shows its share of the window as a gauge
  under its name rather than a sixth column.
- Aggregation happens in the service worker (`tokens.stats`), so the panel never
  receives every raw record to add up, and **Clear usage** empties both shapes
  behind a confirmation. Records flush per request rather than batched: an MV3
  worker can be evicted between any two events, and silently losing the spend of
  a turn that already cost the user money is the one failure this board must not
  have.
- **The Runner keeps its own ledger** — same observer hook, same pure
  aggregation functions, so a token counted headless and a token counted in the
  extension are counted identically — in `<dataDir>/token-usage.json`, exposed
  read-only as `GET /api/tokens/stats?range=today|7d|30d|all` (see
  `docs/server.md`). Headless spend stays out of the extension's panel by design.
- Context compaction gets its own consumer row rather than hiding inside "chat":
  it is a real cost the user pays to keep a long turn running.

### Added — One-shot and chained scheduled tasks

- **Run once at a date and time** (`{ kind: 'once', at }`). The alarm disarms
  itself immediately after firing, so "publish at the golden hour" no longer has
  to be faked as a daily task. Times are local; Chrome's 1-minute alarm floor
  means a moment less than a minute away fires about a minute late.
- **Task chains**: a task declares the `outputs` it hands off and which task it
  `followsTaskId`, then references `{{upstream.<key>}}` in its prompt or
  workflow variables. References resolve at the child's own **run** time against
  the parent's last successful output, so a follow-up can be created before its
  input exists (write the comment task while the note is still a draft).
  `chainId` only groups rows in the UI; it carries no engine behavior.
- **Run outputs are persisted** (`TaskRunLog.outputs`) as the cross-task
  handoff. `{{upstream.summary}}` is deliberately capped at 512 characters —
  bulk content belongs in a file artifact or a re-read of the page, because an
  oversized handoff is what used to lose whole run logs.

### Changed — Turn progress survives a closed panel

Minimizing or closing the side panel disconnects its port while the worker keeps
the turn running. The reopened panel sat on a frozen snapshot until the round
ended — and a confirm / ask-user / plan raised while it was away had no listener
left, so the turn hung on a card the user never saw.

- A turn writes to a per-conversation **channel** whose sink is whichever port is
  currently watching, swapped when a panel resumes the conversation; the
  interactive request resolvers live on the channel too.
- Display events emitted since the last transcript change are buffered and
  replayed on reattach, and the reattach notice is a transient phase line rather
  than a permanent entry that split the reply in two.
- **Stop** now names a conversation: a panel can be watching turns from several,
  and Stop must only ever mean the one on screen.

### Changed — The task list is live, and editing is a dialog

- Tasks created from the chat appear immediately. Every tab stays mounted (the
  chat holds a live port and streaming transcript that must survive editing a
  skill mid-answer), so the list used to load exactly once per panel document;
  it now subscribes to storage changes on its own key. The write path already
  notifies, so there is no new broadcast message type and no polling timer, and
  the last-run badge refreshes the same way.
- **Edit** opens a dialog on the shared form-dialog shell instead of pushing an
  inline editor above the list, matching the skill and agent editors.
- Each skill row exports that one skill as JSON that Import reads back
  unchanged; the redundant _Use in chat_ button is gone — pinning a skill happens
  in the chat composer.

### Fixed

- **A malformed skill or agent YAML entry could take down the worker.** A list
  item that is not `key: value` (a bare `- plain text`) made the parser re-read
  the same line forever and grow the array until the isolate ran out of heap —
  and every skills and agents read funnels through it. An unmappable item is now
  skipped, and each item advances at least one line.
- **A stopped full-auto turn used to poison the whole conversation.** Stop
  mid-tool-round persists an assistant `tool_calls` turn with missing results,
  a shape providers reject outright — and because the broken turn stays
  stored, every later message failed with the same 500. The pairing is repaired
  where request bodies are built (`toApiMessages`), so it holds for every host
  (extension, Runner, unattended, delegation) and an already-poisoned
  transcript heals on the next send.
- **Transcript trimming no longer deletes user messages.** The byte budget
  dropped whole turns from the oldest end regardless of role, so the earliest
  things the user typed quietly disappeared. User turns are now the
  transcript's spine: rounds (a `tool_calls` turn and its results) travel
  together, every user turn is kept, and a spine over budget is persisted over
  budget rather than trimmed further.
- **The native-first JS gate reads real evidence.** A step worded as a click
  whose native operator demonstrably ran and failed may use the JavaScript
  escape hatch; without a recorded failure the refusal stands, and it now
  states its own unlock condition.
- **Editor and block fixes**: box-select begins over a node instead of panning
  the canvas (Space pans); the `new-window` block actually re-points the run —
  and its active tab — at the window it opened, instead of reporting success
  while later steps kept driving the launching window.

### Added — Firefox 128+ support (a third install package)

The extension now builds for Firefox from the same sources. `pnpm build:firefox`
assembles `dist-firefox/`, and `pnpm package` ships it as
`browser-copilot-<version>-firefox.xpi` next to the two Chrome builds — the
extension-package form Firefox's install flows expect. The floor is Firefox
128: the user-JavaScript rung needs `scripting.executeScript({ world: 'MAIN' })`,
which landed there.

- **Event page, not service worker.** Firefox MV3 runs `background.scripts`
  with `type: module`; content scripts are classic scripts, so each one is
  bundled as a self-contained IIFE instead of an ES module.
- **No polyfill: `chrome` is aliased to `browser` at compile time** (esbuild
  `define`), because Firefox's `chrome.*` is callback-only while `browser.*`
  returns the promises this codebase already awaits. No call site changed,
  and `typeof chrome` guards read true on both browsers.
- **No `sidePanel`**: the toolbar click opens the Firefox **sidebar**
  (`sidebar_action`), and the in-page floating button's expand action does the
  same. **No `debugger` API**: AI takeover is Chrome-only. **No offscreen
  documents**: local OCR cannot run, so the Firefox package is OCR-free by
  construction, like the lite Chrome build.
- Small deltas: clipboard reads on the event page fall back to
  `navigator.clipboard` / `execCommand`, and `moz-extension://` pages are
  refused by the page reader alongside the other privileged schemes.
- **One shared manifest source**: `scripts/manifest-shared.ts` feeds both the
  Chrome and Firefox assemblers, and a lockstep test
  (`tests/firefox-manifest.spec.ts`) fails if the two drift.
- `web-ext lint` reports 0 errors; the remaining warnings name exactly the
  knowingly-unsupported APIs above. Design, build steps and the verification
  record live in `specs/2026-10-15-firefox-support-design.md` / `-plan.md`.

### Added — Mid-turn supplements

Typing while the model acts is no longer Stop-then-continue — a path that
silently lost the save-as-workflow card and left question cards pending on dead
request ids. A turn now owns a **supplement queue**: a note sent while it runs
is drained at the next round boundary (every tool call already paired with its
result) and recorded as a real `role:'user'` turn. A turn that reaches its
final answer with notes still queued keeps working inside the same task
instead of finishing; notes it never read come back to the composer flagged
rather than dropped. Question cards no longer stack (only the oldest confirm /
ask_user / plan is rendered), Stop announces the interactions it dismissed so
no card outlives its turn, and the generation popup gains a STOPPED state.

### Added — A window of its own for conflicting scheduled runs

Two alarms firing in the same minute both resolved to the newest plugin window
and its one automation tab, so the runs took turns acting on the same page. A
run now **leases a window before it works**: the shared plugin window when
free, otherwise a cascade-positioned unfocused window of its own, closed when
the run settles — and a FIFO queue with a nine-minute budget when every slot
is taken, failing loudly instead of silently skipping. `maxConcurrentRunWindows`
(1..6, default 3) is a Settings number, the Tasks board badges which window
each run drove, and window leases survive a worker eviction so orphaned
windows get reclaimed.

### Added — Generation recalls certified workflows as seeds

Generation now ranks saved, certified workflows by site match, intent overlap
and lexical coverage, and offers the top two to the model at the one seam
every generation path passes before its first page action
(`prepare_workflow_goal`) — advice, not automation: nothing appends a node,
and the model still has to execute every step it reuses. A failing recall
degrades to unseeded generation.

### Added — Feishu delivery for the notification block

The workflow notification block gains a send-to-Feishu checkbox that rides the
same webhook configuration scheduled tasks already use, on both hosts. A
missing webhook or a delivery error is surfaced as an error line in the run
log, never thrown — the desktop notification has already gone out, so the step
still counts as done.

## [0.6.4] - 2026-10-09

### Added — First-run success for generated workflows

Generated workflows used to fail their first manual run almost every time. The
root causes were replay-environment gaps the generation session never sees, and
they are now closed on both sides (see
`specs/2026-09-19-first-run-success-design.md`):

- **Read blocks wait for the element to render.** `get-text` / `attribute-value`
  / `read-page` were single-shot: one `querySelectorAll`, and an empty result
  failed the step. A replay runs back-to-back, so a read right after a
  click-triggered navigation raced the page's own rendering. They now poll
  (120 ms interval, 5 s default window, per-node `waitSelectorTimeout`, explicit
  `waitForSelector: false` opts out); only empty results are retried.
- **Element resolution prefers an exact match.** The in-page kernel's `resolve`
  took the first candidate spec that matched ANY element — a positional CSS
  path that drifted into matching several elements clicked the wrong one in
  silence. A spec matching exactly ONE element now wins over an earlier
  multi-match, with the legacy first-visible behavior kept as the fallback.
- **Recorded selectors are verified against the live page.** Each operator call
  probes its CSS candidates in one injection and records the one matching
  exactly one element (stamped `selectorVerified`); a locator with no live CSS
  match records NO selector, so replay leans on the role/text rich locator
  instead of a misleading positional path. Saving from the generation card also
  hardens the whole graph in one batched pass — editor/import saves are never
  rewritten.
- **Element waits are persisted on the graph at save time** (`lib/workflow/
runnability`), idempotent and structure-preserving, so server/scheduler
  runners and the editor see the same waits the run path force-enables.
- **Missing page anchor is reported instead of failing silently.** A generated
  graph whose first element action has no `new-tab` before it can only replay
  on the page it was generated on; the run gate warns about it and the run log
  gains an origin-mismatch hint when the active tab is a different site.
  `settings.provenance` / `settings.generationOriginUrl` carry the provenance.
- **Opt-in verify run from the save card.** A new checkbox ("Verify run after
  save", default off — the run is real and costs a model call) hands the saved
  workflow to the existing AI-debug loop: real replay, AI repair of failed
  nodes, takeover-free re-verify, with the verdict landing back in the chat.

### Fixed — Provider configuration loss after the storage split

- **`ensureSchema` no longer fabricates defaults over an unreadable
  directory.** When a storage directory is configured but its handle is
  unavailable (extension reload / browser restart), absent config keys are
  left absent instead of being replaced with defaults, and missing
  collections are no longer seeded as empty arrays (a seeded `[]` reaching
  the directory via the outbox replay would clobber the real records on
  file). Browser mode keeps the seed-everything fresh-install behavior.
- **`getSettings` adopts the legacy file when the stored value carries no
  user data**: versions before the split migrated `settings` (the provider
  profiles) into the directory; if a bootstrap already wrote fabricated
  defaults into browser storage, the read path now recognizes the pristine
  default and restores the real settings from `settings.json` — writing the
  adopted value back so the repair sticks.
- Regression-tested in `tests/settings-legacy-adopt.spec.ts`.

### Fixed — Storage directory data loss

- **Config/data split**: with a storage directory configured, user content
  (chats, conversations, history, workflows, drafts, skills, agents,
  profiles, passwords, tasks, checkpoints) is written ONLY to that
  directory; extension configuration (`settings`, provider profiles,
  Feishu config, schema version) stays in browser storage permanently.
- **Outbox instead of a staging mirror**: writes made while the directory
  handle is unavailable (e.g. right after a browser restart, before the
  panel re-grants access) park in a durable outbox instead of being
  misdirected into `chrome.storage.local`. Reads overlay pending entries
  (and deletion tombstones), so a read-modify-write always starts from the
  full latest state — the missing property that let a stale browser copy
  overwrite whole workflow lists. Once access is restored the outbox
  drains into the directory automatically, per-entry guarded so an entry
  older than the file cannot regress it.
- **Read cache**: the last value that reached a file is served while the
  directory is unreachable, so the panel no longer renders empty lists
  that look like data loss. Size-capped (5 MB, conversations evicted
  first); cleared when file mode ends.
- **Per-key write locks** for every read-modify-write collection
  (workflows, settings/providers, skills, agents, conversations,
  profiles, passwords, history, drafts) — shared implementation in
  `lib/key-lock.ts`. Concurrent saves in the service worker no longer
  drop one another's entries.
- **Single writer**: the history tab now saves generated workflows through
  a worker command instead of writing the collection directly from the
  panel, removing the last cross-context race; a source-scan test keeps
  UI contexts from re-importing content-write functions.
- **Safe legacy migration**: pre-upgrade browser copies are merged into
  the files per record (newest `updatedAt` wins) instead of overwriting
  them; legacy config files are adopted back into browser storage on
  first read.
- Settings → storage shows how many changes are waiting to be written to
  the folder.

### Added — One pipeline from generation to repair to verification

The AI path used to be several disconnected surfaces (generate, debug, repair,
recover) with their own vocabulary. It is now one engine and one flow, mapped in
`docs/workflow-ai-architecture-audit.md` and specified across `specs/2026-09-*`
and `specs/2026-10-*`:

- **Workflow IR** (`lib/workflow/ir.ts`) and a trace compiler, so a graph can be
  analysed, rewritten and re-verified without string-parsing editor JSON.
- **A single failure taxonomy**: deterministic classification plus a stable
  failure signature, which is what makes retries, budgets and repair strategies
  comparable across runs.
- **Unified repair engine**: repair candidate contract / parser / apply,
  revisioned repair commits (a fix becomes a revision, not an in-place
  overwrite), a bounded strategy ladder (`lib/workflow/repair-policy.ts`), a
  dynamic repair budget, and goal-aware three-layer verification
  (`lib/workflow/repair-verification.ts`) that asks whether the GOAL landed
  rather than whether each call returned.
- **Autonomous orchestration**: a background repair orchestrator behind a runtime
  adapter, a recovery protocol with phases / resume envelopes, auto-trigger on run
  failure, and a workflow health summary.
- **One entry point in the UI**: the single-entry AI repair flow absorbed the
  secondary recovery dialogs; per-node AI fix can be applied or reverted; the
  proposal shows a diff and a risk preview.
- **Benchmarks as gates**: `pnpm bench:reliability`, `bench:workflow-generation`,
  `bench:workflow-repair`, `bench:debug` against a committed baseline, plus
  acceptance suites for generation, recovery, goals and file upload.

### Changed — A missing parameter no longer blocks the run

Clicking Run used to refuse the whole graph with a toast that vanished in
seconds: one under-filled node and twenty steps executed nothing, and the run log
had no entry for the attempt at all.

- `validateWorkflowForRun` now returns node-attributable findings
  (`WorkflowRunIssue`: severity / nodeId / blockId / nodeName / param / message);
  the `errors` / `warnings` string lists are derived projections of it.
- Findings are written into the run log — one line per graph-level problem, one
  line per blocked node — and the engine stops _before_ the blocked node without
  touching the page, so every step that can work still runs and a step with no
  locator cannot be mis-reported as "element not found" by a readiness poll.
- The editor red-flags the same nodes while you type (one shared rule function),
  and each blocked log row carries a Locate action that closes the panels,
  selects the node and centres it.
- Design, rejected options and the browser-verification steps that are still
  pending: `specs/2026-10-06-run-preflight-log-design.md`.

### Changed — Every operator was real-tested one by one

All 67 operators (63 catalog + 4 custom) were driven in a real browser against a
purpose-built fixture site through the Runner, with evidence shaped so that only
the feature under test could produce it: **148 cases, 142 PASS / 3 FAIL /
3 BLOCKED**, covering 62 operators (5 recorded untestable — cloud-only or needing
real Google credentials). Per-block verdicts, root causes and environment limits:
`specs/2026-10-06-operator-realtest-design.md`. Four questions the port cannot
answer (trusted key events on contenteditable, `await` statement bodies, iframe
scope, variable reads) were re-checked against the loaded extension.

Two user-visible defects came out of it:

- **Advertised options that were never read** now take effect.
- **Exclusive branch gates fell through to the unwired port.** With only the
  "exists" port wired, an absent element still ran that branch, because routing
  fell back to the first outgoing edge. `conditions` and `element-exists` now
  stop when the port the verdict took has no wiring
  (`tests/branch-fallthrough.spec.ts`).

### Added — Files, user input and goal inspection

- **`upload-file` block + file artifacts + a user file picker card**: a run can
  ask for a file at execution time instead of baking one in, and the block names
  the variable it fills rather than carrying the file.
- **Page-side workflow JS expressions and file upload** in the injected kernel;
  injected function bodies are now statically checked to be self-contained
  (`pnpm verify:injected`).
- **Node goal contracts, a goal inspector and a certification modal**, plus
  generation metrics and a recorded scored-locator chain per node — the chain
  that produced a match is now rotated into the node instead of discarded.
- **`ask_user` tool** with structured suggestions, dynamic agent tool groups, and
  loop-back edges in the editor graph.

### Fixed — Goal certification reads the page, not the plan

A long run of real-browser rounds (see `specs/`) turned "the steps ran" into
"the goal is provably true":

- The goal gate now reads the **pre-run** snapshot, so page furniture like a
  `草稿箱(100)` counter can no longer certify a goal by coincidence.
- Only goal rows the run actually made true are certified; a presence row is
  aimed at the words the page really shows, and a step's promise is graded on the
  page that step stood on.
- Replay observes the page and **degrades with evidence** instead of failing
  silently; `pnpm selftest` prints the words the steps really recorded when a goal
  fails.
- Misreads fixed: a popup dismissal is no longer read as a login, and a composer
  mode name is no longer read as a publish act.

### Fixed — Further user-visible repairs

- A `javascript` block now fails when the script returns a failure envelope
  instead of reporting success.
- A generated workflow keeps its identity through save; a draft save stays behind
  the opt-in that names it.
- An unattended replay always gets a directory it can write to.
- Operator parameters aligned across catalog, edit forms, guide and executors;
  operator failures are visible instead of swallowed, and files land where the
  settings say.
- Recovery-phase labels localized in the failure center; the save-card collapse
  button uses the minimize glyph.

### Changed — CI and repository hygiene

- **CI installs pnpm through corepack** instead of `pnpm/action-setup`, and the
  whole tracked tree was brought to the repo's Prettier config; `pnpm lint` /
  `pnpm format:check` are now blocking-green on `main`.
- `AGENTS.md` gained enforcement tags (`[机检]` / `[验收]` / `[纪律]`), reuse rules
  and an evidence-based closing checklist.

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

- **Workflow-kind scheduled tasks no longer "look unstarted"**: `executeWorkflow`
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

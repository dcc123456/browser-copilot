# Browser Copilot

**English** · [简体中文](README.zh-CN.md)

Your AI assistant that actually *uses* the web for you. Open the side panel,
ask in plain language, and Browser Copilot reads the page you're on and takes
action — clicking buttons, filling forms, scrolling, switching tabs, walking
through a whole checkout or setup flow — while you watch or stay hands-off.

- 🧠 **Works with the model you already use.** Any OpenAI-compatible endpoint:
  DeepSeek, 火山方舟 Ark, OpenAI, OpenRouter, Moonshot, DashScope, SiliconFlow,
  or a local Ollama/LM Studio. Bring your own key.
- 🎚️ **You choose how autonomous it is.** Four modes from plain chat to full
  auto; semi-auto shows every click for your approval first.
- 🧩 **Skills** turn repeatable know-how (review checklists, style guides,
  extraction formats) into one-tap instructions the model must follow.
- 🎬 **Workflows run whole procedures on their own.** Record yourself doing a
  task once, or assemble it on a visual canvas from 56 block types — clicking,
  filling, loops, condition branches, even an AI-agent step — then launch it by
  hand, on a schedule, at startup, with a keyboard shortcut, from a context
  menu, or when a matching page is opened.
- ⏰ **Runs on a schedule while you sleep.** Set recurring tasks — every few
  minutes, daily, or on weekdays — to run an unattended prompt or summarize
  your GitHub review queue, with a full run history.
- 💬 **Picks up work from Feishu/Lark.** Get notified in a group chat when a
  task finishes, or DM the bot a request from your phone and watch it execute
  in the browser on your machine and reply with the result.
- 🤝 **Your coding agent can drive it too.** Claude Code, Codex, Trae — any
  MCP client — gets a browser toolbox through a local adapter and operates
  your real Chrome (see [Agent integration](#agent-integration-mcp)).
- 🔒 **Private by construction.** No accounts, no telemetry, no cloud server.
  Your keys and data stay on your machine; passwords are filled locally and
  never shown to the model.
- 💾 **Own your data as files.** Pick a folder in Settings and everything —
  conversations, skills, workflows — is written to real files on your disk;
  the browser cache is kept as a read mirror.

It never acts on its own initiative — every action is either part of answering
something you just asked, a [scheduled task](#scheduled-tasks) you created, a
[workflow](#workflows) you built with an enabled trigger, a command you sent
from [Feishu/Lark](#feishu--lark-integration), or a tool call from a coding
agent you connected over [MCP](#agent-integration-mcp).

---

<video src="https://github.com/user-attachments/assets/17a30b54-608c-43a9-a5ee-770c1d809350" controls="controls" width="100%"></video>

## Contents

- [Quick start](#quick-start)
- [What it is good for](#what-it-is-good-for)
- [Agent modes](#agent-modes)
- [Models](#models)
- [Using it](#using-it)
- [Skills](#skills)
- [Workflows](#workflows)
- [Scheduled tasks](#scheduled-tasks)
- [Feishu / Lark integration](#feishu--lark-integration)
- [Agent integration (MCP)](#agent-integration-mcp)
- [Saved data and privacy](#saved-data-and-privacy)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Quick start

### 1. Install the extension

Requires **Chrome 116+** (or any Chromium browser that supports Manifest V3 side
panels).

**Option A — download a release (recommended):**

1. Go to the
   [**Releases**](https://github.com/dcc123456/browser-copilot/releases) page
   and download `browser-copilot-<version>.zip` from the latest release.
2. Unzip it into a folder you will keep — the extension loads from that folder,
   so don't delete it afterwards.
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder — the one directly
   containing `manifest.json`.
6. Click the extension's toolbar icon to open the side panel. Pin it for easy
   access.

**Option B — build from source:**

Requires **Node.js 20+** and `pnpm` (or `npm`).

```bash
git clone git@github.com:dcc123456/browser-copilot.git
cd browser-copilot
pnpm install
pnpm run build
```

Then in `chrome://extensions` (Developer mode on), click **Load unpacked** and
select the generated **`dist/`** folder. After pulling new changes, re-run
`pnpm run build` and press **Reload** on the extension card — a rebuild alone
does not refresh an already-loaded service worker.

### 2. Add a model

Open the side panel → **Settings → Add a provider**.

1. **Pick a preset** — the base URL and a suggested model are filled in (DeepSeek,
   Ark, OpenAI, OpenRouter, Moonshot, DashScope, SiliconFlow, Ollama, etc.). You
   can also choose **Custom** for any OpenAI-compatible endpoint.
2. **Paste your API key.** A local Ollama/LM Studio accepts any non-empty string.
3. **Set the model** — type its ID, or press **Fetch models** to list what the
   endpoint offers (typing always works even if the gateway lacks `/models`).
4. Press **Test connection** — it sends one real request and confirms that both
   the key and the model work.
5. **Save.** Add as many providers as you like and switch between them with
   **Use this**.

> The model must support **function calling** (tool use). Without it the
> assistant can chat but will never read or act on the page on its own. For
> autonomous use, reliable choices are `deepseek-chat`, `gpt-4o-mini`,
> `qwen-plus`; use a reasoning model for hard tasks and a local model for
> privacy.

### 3. Choose how autonomous it is

Use the dropdown at the bottom-left of the chat. The choice applies to the
**next action**, even mid-reply:

- 💬 **Chat** — pure conversation; no reading or acting on the page (cheapest).
- 🔒 **Read-only** — reads only; no click, type, navigation, or fill.
- 🛡 **Semi-auto** (default) — every page-changing action is shown to you first
  for approval.
- ⚡ **Full auto** — actions run without confirmation.

### 4. Ask away

Type and press **Enter** (Shift+Enter for a newline; with a Chinese/Japanese/
Korean IME, the first Enter confirms the candidate and the second sends).

- Tick **Attach selection** to send text you highlighted on the page (only the
  selection, not the whole page).
- Type **`/`** in the composer to pick a [skill](#skills).
- When a skill is selected, you can even send an empty message — it applies the
  skill to your input or selection.

Replies render as Markdown. You can close the panel at any time; the answer
keeps running in the background and reappears when you reopen it.

---

## What it is good for

Best when a task lives on one page and mixes reading with acting:

- **Fill forms** with a saved profile; passwords are filled straight into the
  field and the model never sees the value.
- **Walk through a multi-step flow** — add to cart, check out, apply settings —
  approving each click in semi-auto, or hands-off in full auto.
- **Review a PR or explain code/docs**; select the hunk first for a precise
  target instead of the whole page.
- **Summarize** long articles, docs, release notes, threads.
- **Analyze a page's data** — but note the model reasons over *text*, it does
  not compute; treat numbers over long tables as hypotheses to verify.
- **Apply a repeatable standard** (review rubric, style guide, checklist) via a
  [skill](#skills).

It cannot act in Chat or read-only mode, read `chrome://`/local-file/Web-Store
pages, solve CAPTCHAs or bypass 2FA, guarantee arithmetic over long tables, or
run a scheduled task when the browser is fully closed (alarms only fire while
Chrome is open).

---

## Agent modes

The dropdown applies to the **next action**, even mid-reply, so you can switch
while a task runs.

| Mode | Behavior | Best for |
| --- | --- | --- |
| 💬 **Chat** | Pure conversation. No page-reading or action tools are sent to the model, so it cannot touch the page and uses the fewest tokens. You can still attach a text selection. | Brainstorming, writing, Q&A, translation — anything where you don't want it acting on the page. |
| 🔒 **Read-only** | Reads only; no click, type, navigation, or fill. | Review, summary, translation — zero side effects. |
| 🛡 **Semi-auto** (default) | Every page-changing action is shown for approval first. | Everyday use; stay in control of each click. |
| ⚡ **Full auto** | Actions run without confirmation. | Repetitive, trusted flows. |

In semi-auto the confirmation card names the exact button/field/URL. In full
auto every action is still logged on the **Data** tab for audit.

---

## Models

Any endpoint speaking the OpenAI chat-completions protocol
(`POST {baseUrl}/chat/completions`, `Bearer` auth, SSE streaming). A provider is
configuration, not a code path — unlisted endpoints work too.

| Preset | Base URL | Example model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` |
| 火山方舟 Ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-code`, or `ep-…` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| 阿里云百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen3:8b` |
| LM Studio (local) | `http://localhost:1234/v1` | `local-model` |

**Choosing one:** function calling is required for autonomous read/act. Use a
cheap fast model (`deepseek-chat`, `gpt-4o-mini`, `qwen-plus`) for daily work, a
reasoning model for hard tasks, and a local model when text must stay on your
machine. Page text is capped at ~12,000 characters, so prefer a large context
window for long pages.

Add multiple providers and switch with **Use this**; keys are stored per profile.
**Max action steps per reply** (default 20, range 1–100) bounds a confused model;
send "continue" if it hits the cap. Keys live on this machine only (as files once
you pick a storage folder — not synced, not encrypted) — use a local model if
that's unacceptable.

---

## Using it

- **Window scope.** Everything the panel starts — reading and acting on pages,
  opening/switching/closing tabs, workflows run from the panel — happens in the
  **browser window the panel is attached to**; unattended runs (scheduled
  tasks, Feishu commands) stay inside that window too while it is open. Open
  another window without the panel and use it freely: it is never read, never
  acted on, and never triggers "run when a matching page opens" workflows.
  Only when NO panel is open anywhere do unattended runs fall back to the
  previous global behaviour; keyboard shortcuts and context-menu runs act in
  the window where you used them.
- **Reading the page.** Either tick **Attach selection** to send highlighted
  text up front, or let the assistant read it itself (which asks for
  confirmation in semi-auto unless you attached). The grant is scoped to that
  page (origin + path); switching tabs re-gates.
- **Attach selection** captures only `window.getSelection()`, so you control
  exactly what is sent.
- **Markdown.** Replies render headings, lists, tables, and code blocks (with a
  copy button); your own text stays as typed.
- **Language & theme.** Settings → Language (English / 简体中文 / Auto); the
  panel follows the OS light/dark theme live.
- **Storage location.** Settings → Storage location lets you choose a folder on
  your disk; everything is then stored as real files there (see
  [Saved data and privacy](#saved-data-and-privacy)). Until you pick one,
  data stays in browser storage.
- **History.** The clock icon opens past conversations — continue, preview,
  rename, or delete. Threads persist on this machine (newest 200 messages
  each) — as real files once a storage folder is set.

---

## Skills

A skill is a saved instruction pack: the stable part of a prompt. Create one
under **Skills → New skill** with a name, a one-line description of when it
applies, and its instructions. Then either type **`/`** in the composer and pick
it, or leave *Let the agent apply this automatically* on so it is used when your
message matches the description.

Once a skill is selected, it is forced onto that turn — the full instructions are
injected into the system prompt and the user's message is bound to apply them, so
the model cannot answer outside the skill. Only names/descriptions are shown
beforehand; full instructions load on demand.

**Skills are files, like general skills.** Each skill is stored as its own folder
named by its slug, holding a `SKILL.md` with YAML frontmatter (`name`,
`description`, `autoMatch`, …) and a Markdown body with the instructions. Once a
storage folder is set, they live at `skills/<slug>/SKILL.md` on your disk — you
can hand-edit them there and Browser Copilot picks up the changes. Without a
storage folder they fall back to browser storage.

---

## Workflows

The **Workflows** tab turns a repeatable browser procedure into a saved,
re-runnable automation — a node graph built on a visual canvas, modeled after
[Automa](https://github.com/AutomaApp/automa). Create a workflow there and
**Edit** opens the full flow editor in its own tab.

**Three ways to get one:**

- **Record it.** Press Record in the editor and do the task once. Clicks, form
  inputs (text, select, checkbox, radio), scrolling, tab switches, new tabs,
  full-page navigations and SPA route changes are captured as blocks —
  including the wait-for-element / wait-for-load pauses. Stop recording and
  the flow becomes a workflow on the canvas.
- **Convert a chat.** After a chat turn that actually acted on pages, save the
  executed actions as a workflow and reuse them without the model in the loop.
- **Draw it.** Drag blocks from the palette and connect them.

**What's in the palette.** 56 executable blocks ported from Automa: element
click/hover/scroll, form fill, get text, element exists, loops over data or
elements, while/repeat, condition branches, variables and `{{token}}`
interpolation, JavaScript code, cookies, webhook, clipboard, screenshot,
download handling, new/switch/reload/close tab, delay, and more. (Five Automa
*cloud* blocks — Google Sheets/Drive, block packages, cloud AI workflows — are
listed for compatibility but not executable.) Every block has a dedicated edit
form, can be disabled individually, and can carry its own error handling: retry
or fall back to another branch on failure.

**Precision targeting.** A built-in element picker generates a CSS or XPath
selector for any target — hover to highlight, click to lock, walk up or down
the DOM, switch between CSS and XPath. Targets inside *closed* shadow DOM are
reached by clicking through the Chrome DevTools Protocol. One click
auto-lays-out the graph; `Ctrl+S` saves, `Ctrl+Enter` runs from the editor.

**One special block: AI agent.** It hands that step to the same agent loop the
chat uses — in read-only mode it reads the page (or a specific element) and
answers without acting; in full-auto mode it may click and navigate. The
answer is stored in an output variable later blocks can interpolate.

**Launching.** A workflow runs when its trigger fires:

- **Manual** — the Run button in the editor or the Workflows tab;
- **Scheduled** — same schedule options as [scheduled tasks](#scheduled-tasks)
  (every N minutes, daily, or chosen weekdays);
- **At browser startup**, **keyboard shortcut** (per workflow, e.g.
  `Ctrl+Shift+E`), **context menu**, or **when a page whose URL matches a
  pattern is opened**.

**Watching runs.** The History tab's activity board shows running and finished
runs for workflows and tasks alike — live progress, per-block logs, debug
mode, and mid-run cancellation. The Workflows tab shows each workflow's
last-run status, and a failed run deep-links straight to its log.

**Failure retry.** Two levels:

- **Single block.** Every block's *On error* settings can retry itself N times
  with an interval, or route to its `fallback` handle. For one flaky click.
- **A group of steps.** Put the group inside a **Repeat task** block and detect
  the failure with an **Element exists** check — e.g. a login that re-enters
  the captcha on failure, up to 5 attempts:

  ```
  Repeat task (5)
   ├─ loop → click "refresh captcha" → OCR the captcha image (→ lastOcrText)
   │          → fill the captcha input with {{lastOcrText}} → click "sign in"
   │          → wait 2s → Element exists (error-message selector)
   │                         ├─ exists (failed)  → wire back to the Repeat task
   │                         │                     block = next retry
   │                         └─ not exists (ok)  → Set variable loginOk=true
   │                                              → Loop breakpoint
   └─ end  → Conditions (loginOk exists?) ─ true  → logged-in steps…
                                          └─ false → all 5 attempts failed
  ```

  The body is whatever hangs off the **loop** handle; wiring the last body
  block back to the loop block ends an iteration. **Loop breakpoint** breaks
  out early; execution resumes at the **end** handle — which also runs after
  all iterations finish, so tell the two endings apart with a variable plus
  **Conditions** (as above), e.g. notify or fail the run when login never
  succeeded. (A hand-drawn cycle of blocks counted by **Increase variable**
  and gated by **Conditions** also works, but the loop shape above is easier
  to read and maintain.)

**Portability.** Export a single workflow or all of them as JSON, and import
JSON back — including files exported from Automa itself. Older
Browser Copilot workflow formats migrate automatically on load.

---

## Scheduled tasks

The **Tasks** tab lets the agent run unattended on a schedule — no panel open, no
button pressed. Create a task, choose what it does and when, and it fires while
the browser is running.

**What it can do:**

- **Run an agent prompt** — a saved instruction the agent executes exactly as if
  you had sent it from the chat, including reading or acting on pages (subject to
  the mode you've set). Use it for recurring checks, daily digests, or
  fill-and-submit flows.
- **Count PRs waiting for your review on GitHub** — the built-in task.

**When it runs** (Chrome's `chrome.alarms`, 1-minute minimum):

- Every N minutes,
- Daily at a set time, or
- Weekdays (Mon–Fri) at a set time.

Each run is recorded in **Recent runs** with its start time, outcome, steps, and a
short summary — and can be terminated mid-flight. Tasks only fire while the
browser is open (the service worker is woken by the alarm); they don't run when
Chrome is closed. Turn on **Notify via Feishu when done** to push the result out.

---

## Feishu / Lark integration

Browser Copilot can talk to [Feishu/Lark](https://www.feishu.cn) in two
independent ways, configured on the **Tasks** tab:

- **Outgoing notifications (custom-bot webhook).** Paste a Feishu group custom-bot
  webhook URL (and optional signing secret) and any task can post its result to
  that group when it finishes. No app credentials required — this is the simplest
  path for "tell me when it's done".
- **Inbound remote control (self-built app, long connection).** Add a Feishu
  self-built app's App ID and App Secret and enable the bot. You can then DM the
  bot from Feishu and it runs your message as an agent task on your machine,
  replying with the result — a way to drive the browser remotely from your phone
  or another device.

The Feishu connection is kept alive by a watchdog alarm and auto-reconnects if it
drops. Without app credentials, notifications still work; inbound commands don't.

---

## Agent integration (MCP)

The side panel isn't the only way in. With **Local agent access** turned on,
Browser Copilot exposes a set of browser tools over
[MCP](https://modelcontextprotocol.io) to a coding agent running on the same
machine — Claude Code, Codex, Trae, or any MCP client. The agent can then open
URLs, read pages, click, fill forms, press keys, switch tabs, run JavaScript,
recognize CAPTCHA text, and save files — in your real Chrome — which turns
"change the code, then check it in the browser" into a single conversation.

```
Claude Code / Codex / Trae   (MCP client)
     │  stdio · JSON-RPC 2.0 — the agent spawns the adapter itself
     ▼
examples/local-agent/mcp-server.mjs   (zero-dependency Node adapter)
     │  WebSocket · ws://127.0.0.1:8765   (loopback only)
     ▼
Browser Copilot extension   (executes every call in your Chrome)
```

**Requirements.** Node.js ≥ 18 and the extension loaded in Chrome. The adapter
is one dependency-free file, `examples/local-agent/mcp-server.mjs`, from this
repository — if you installed from a release zip, download just that one file;
it does not need to sit inside the extension folder.

**Manual setup, three steps:**

1. Extension panel → **Settings → Local agent access** → turn the switch on.
   Keep the adapter address `ws://127.0.0.1:8765` and optionally set a shared
   token; the card shows **Connected** once the link is up.
2. Register one stdio MCP server named `browser-copilot` that runs Node with
   `mcp-server.mjs` — copy-ready snippets for Claude Code, Codex, and Trae are
   right on that settings card.
3. Start (or restart) your agent — it spawns the adapter over stdio and the
   extension dials in automatically. No daemon, no `npm install`, no Python.

> 🤖 **Let the AI wire it up.** Copy the prompt below and paste it to your
> coding agent (Claude Code / Codex / Trae all work) — the agent fetches the
> setup instructions itself and completes the whole integration; you never
> need to open a single file:
>
> ```text
> Please set up MCP access to the Browser Copilot Chrome extension for me.
> The full install guide lives in examples/local-agent/MCP-SETUP-PROMPT.md
> inside the Browser Copilot repository/plugin folder on this machine. Find
> that folder, read that file, then follow its setup instructions exactly:
> check the environment, ask me for the adapter path and an optional shared
> token, write the MCP config for your own client, walk me through the
> browser switch, and verify the whole chain with a live call before
> reporting back. If you cannot find the file, ask me where the Browser
> Copilot folder is (or fetch it from
> https://github.com/dcc123456/browser-copilot/blob/main/examples/local-agent/MCP-SETUP-PROMPT.md)
> instead of guessing paths.
> ```
>
> Curious what the AI will read? The full instructions are in
> [`examples/local-agent/MCP-SETUP-PROMPT.md`](examples/local-agent/MCP-SETUP-PROMPT.md).

Tools appear as `browser-copilot` MCP tools (`read_current_page`,
`snapshot_page`, `click`, `fill`, `open_url`, `run_javascript`,
`recognize_image`, `get_secret`, `use_skill`, …). Security: the adapter binds
loopback only; an optional shared token keeps other local processes out;
passwords are filled via `get_secret` without their values ever reaching the
model; tools you disabled in the extension stay refused even when asked for.
The full tool table, per-client config examples, and troubleshooting live in
[`examples/local-agent/README.md`](examples/local-agent/README.md), with a
detailed [Claude Code manual](examples/local-agent/CLAUDE-CODE.md).

---

## Saved data and privacy

The **Data** tab holds a fillable **profile** (name/email/phone/address),
**passwords** (filled via `get_secret`, never returned to the model), and an
**operation history** (every click/fill/scroll/navigation, with timestamp and
host). Everything stays on this machine — not synced, not sent to the model,
and passwords are not encrypted at rest.

**Storage location.** By default data lives in Chrome's `chrome.storage.local`.
Open **Settings → Storage location** and pick a folder to move it to real files
on your disk (via the File System Access API). From then on everything is
written under a `browser-copilot/` folder inside your chosen directory:

- `conversations/<id>.json` — chat transcripts;
- `skills/<slug>/SKILL.md` — [skills](#skills), one folder per skill;
- `<key>.json` — everything else: settings, providers, workflows, profile,
  credentials, and more.

`chrome.storage.local` becomes a read mirror used as a fallback whenever the
disk is unavailable — nothing is lost if a write fails, and corrupted files
fall back to the mirror automatically. Switch back to browser storage any time
from the same settings card; existing data migrates to the folder the first
time you pick it.

| Permission | Purpose |
| --- | --- |
| `storage` | Settings, providers, skills, conversations, workflows, profile, credentials. |
| `tabs` | Identify the active tab and open/switch/close tabs when asked (and for workflow tab blocks). |
| `scripting` | Inject the page kernel, workflow recorder, element picker, and shortcut listener to read or act on a tab. |
| `sidePanel` | Show the panel. |
| `alarms` | Wake the worker to run scheduled tasks and workflows and keep the Feishu bot connection alive. |
| `offscreen` | Run a hidden document so the workflow clipboard block can read/write the system clipboard. |
| `contextMenus` | Add the right-click item that launches workflows with a context-menu trigger. |
| `webNavigation` | Detect page navigations for visit-web workflow triggers and for recording. |
| `cookies` | The workflow Cookie block reads/sets/removes cookies. |
| `downloads` | The workflow download-handling block observes and manages downloads. |
| `clipboardRead` | Read the system clipboard for the workflow clipboard block. |
| `debugger` | Click elements inside closed shadow DOM via the Chrome DevTools Protocol. |
| `http(s)` host access | Interact with pages and call your model endpoint (and Feishu, if enabled). |

There is no always-on content script — nothing is injected into a page until a
turn, a scheduled task, or a workflow needs it. While you record a workflow,
use the element picker, or arm a keyboard-shortcut trigger, a small listener is
injected into the open tabs for exactly that purpose and goes away when you
stop. Alarms only run tasks and workflow triggers you created (plus a Feishu
keepalive watchdog when that integration is on). The `debugger` permission is
exercised only while a workflow clicks inside a closed shadow root. Only your
messages and the page text you attach/approve leave the machine, sent to
**your** configured endpoint; task results are only sent to Feishu if you turn
that on. There is no telemetry, analytics, or project server.

---

## Development

```bash
pnpm install
pnpm run dev         # rebuild on change
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest
pnpm run build       # production bundle into dist/
pnpm run package     # build + releases/browser-copilot-<version>.zip
```

Load `dist/` unpacked, then press **Reload** on the extension card after changes.
`npm` works as well as `pnpm`. Pushing a tag runs
`.github/workflows/release.yml`, which typechecks, tests, builds, and attaches
the loadable zip to the GitHub Release.

Key design notes: Markdown is parsed to a typed tree (never HTML, no
`dangerouslySetInnerHTML`); the in-page kernel is self-contained and injected
across frames; durable state is persisted to real files when a storage folder is
chosen (with `chrome.storage.local` as a mirror) so data survives MV3
service-worker eviction at idle; mode and step cap are read per action so
settings changes apply without a reload.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No model provider configured" | Settings → Add a provider. |
| 401 / 403 | Wrong/expired key, or key/vendor mismatch. |
| 404 when sending | Base URL missing its version segment, or unknown model; press **Test connection**. |
| "Cannot read this page" | `chrome://`, `file://`, Web Store, or extension page — not injectable. |
| Action still asks in full auto | Reload the extension; confirm the dropdown shows ⚡ Full auto. |
| "Stopped after N tool rounds" | Step cap reached; send "continue" or raise it in Settings. |
| Chats but never reads/acts | Model lacks function calling; attach the page or switch model. |
| Page text empty/partial | Content is in an iframe, lazy-loaded, or behind "Load more"; select the relevant section. |
| Nothing happens on toolbar click | Reload the extension; the worker may have failed to start. |

---

## Limitations

- One active tab at a time; broad reads see the rendered DOM (iframes targeted
  per-action).
- Panel-started actions are locked to the panel's window: if that window only
  shows `chrome://` (or other non-automatable) pages, the assistant reports
  "no actionable tab in the panel's window" instead of reaching into another
  window.
- Page text capped at ~12,000 characters; truncation is reported to the model.
- Tool calls stop after the configured cap (20 by default).
- Autonomous read/act requires a function-calling model.
- The endpoint must accept requests from a browser extension (public APIs do;
  strict internal gateways may not).
- Saved passwords are not encrypted at rest.

---

## License

This project is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE): use, modification, and
distribution are free for personal study, research, education, testing, and
non-profit organizations, provided license notices are passed along with
every copy. **Commercial use requires a separate license from the author** —
open an issue or reach out via the repository page. This is a source-available
license, not an OSI-approved open-source license. The software comes as is,
without warranty and without liability. Third-party dependencies remain under
their own licenses.

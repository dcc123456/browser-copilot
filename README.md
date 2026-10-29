# Browser Copilot

[![Version](https://img.shields.io/github/v/release/dcc123456/browser-copilot?label=version&color=5b8cff)](https://github.com/dcc123456/browser-copilot/releases)
[![Chrome](https://img.shields.io/badge/Chrome-116%2B-4285f4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop)
[![License](https://img.shields.io/badge/license-PolyForm--Noncommercial-6e40c9)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/dcc123456/browser-copilot/ci.yml?label=ci)](https://github.com/dcc123456/browser-copilot/actions)

**English** · [简体中文](README.zh-CN.md)

Your AI assistant that actually _uses_ the web for you. Open the side panel,
ask in plain language, and Browser Copilot reads the page you're on and takes
action — clicking buttons, filling forms, scrolling, switching tabs, walking
through a whole checkout or setup flow — while you watch or stay hands-off.

- 🧠 **Works with the model you already use.** Any OpenAI-compatible endpoint:
  DeepSeek, 火山方舟 Ark, OpenAI, OpenRouter, Moonshot, DashScope, SiliconFlow,
  or a local Ollama/LM Studio. Bring your own key.
- 🎚️ **You choose how autonomous it is.** Five modes from plain chat to full
  auto, plus a workflow-generate mode that turns a run into a reusable
  workflow; semi-auto shows every click for your approval first.
- 🧩 **Skills** turn repeatable know-how (review checklists, style guides,
  extraction formats) into one-tap instructions the model must follow.
- 🎬 **Workflows run whole procedures on their own.** Record yourself doing a
  task once, ask the assistant to generate one, or assemble it on a visual
  canvas from 56 block types — clicking, filling, loops, condition branches,
  even an AI-agent step — then launch it by hand, on a schedule, at startup,
  with a keyboard shortcut, from a context menu, or when a matching page is
  opened.
- 🛍️ **Share workflows through a marketplace.** Publish any workflow to the
  public marketplace or a private team repository as a pull request; browse,
  search and sort what others published; apply a listing with its triggers
  disabled; and get an update reminder when the publisher moves ahead.
- 🎯 **Point at an element instead of describing it.** The page element picker
  in Settings puts a crosshair on every page: one click copies the CSS
  selector, the visible text, or the HTML — or, in select-only mode, records
  the element so the assistant or a connected coding agent can read it.
- ✍️ **Report problems from the panel.** Settings ends with feedback: write a
  report, optionally attach version/build/browser diagnostics, and create a
  public GitHub issue without leaving the extension.
- ⏰ **Runs on a schedule while you sleep.** Set a task to fire once at a date
  and time, every few minutes, daily, or on weekdays — an unattended prompt or a
  saved workflow, with a full run history and outputs you can hand to the next
  task in a chain.
- 📊 **You see what it costs.** The **Tokens** board totals spend over today /
  7 days / 30 days / since first use, broken down by feature and by conversation,
  task or workflow.
- 🔄 **Mid-turn, the panel is not a pet.** Minimizing it used to leave the
  running turn streaming into a dead port: reopening showed a frozen snapshot
  until the round ended, and a confirmation asked for in the meantime had nobody
  to answer it. Output now goes through a per-conversation channel that a
  reopened panel reattaches to.
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
  conversations, skills, workflows — is written to real files on your disk and
  nowhere else; the browser's own storage is left empty.

It never acts on its own initiative — every action is either part of answering
something you just asked, a [scheduled task](#scheduled-tasks) you created, a
[workflow](#workflows) you built with an enabled trigger, a command you sent
from [Feishu/Lark](#feishu--lark-integration), or a tool call from a coding
agent you connected over [MCP](#agent-integration-mcp).

---

## Contents

- [Quick start](#quick-start)
- [What it is good for](#what-it-is-good-for)
- [Agent modes](#agent-modes)
- [Models](#models)
- [Using it](#using-it)
- [Skills](#skills)
- [Workflows](#workflows)
- [Workflow marketplace](#workflow-marketplace)
- [Scheduled tasks](#scheduled-tasks)
- [Feishu / Lark integration](#feishu--lark-integration)
- [Agent integration (MCP)](#agent-integration-mcp)
- [Saved data and privacy](#saved-data-and-privacy)
- [Development](#development)
- [Server runner](#server-runner)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

<video src="https://github.com/user-attachments/assets/42e454b3-c9e4-41d2-b40d-d733eb833072" controls="controls" width="100%"></video>

<img width="2497" height="2088" alt="image" src="https://github.com/user-attachments/assets/9544fad7-98f5-45ec-96ca-6272261b877b" />
<img width="2496" height="1518" alt="image" src="https://github.com/user-attachments/assets/d3541ef0-c310-4016-ae21-fc7e38278adf" />
<img width="2496" height="1518" alt="image" src="https://github.com/user-attachments/assets/57aec05d-b66c-4c24-b50c-6403f0661add" />
<img width="2496" height="1518" alt="image" src="https://github.com/user-attachments/assets/3b449200-5f6c-4b3d-a171-28e0a729b26d" />
<img width="2497" height="2088" alt="image" src="https://github.com/user-attachments/assets/c116a923-0519-4621-a7bf-ebc5e1e3dcc4" />
<img width="2497" height="2088" alt="image" src="https://github.com/user-attachments/assets/9de97b1d-aa3e-407b-9f27-c3f44ea3ae91" />

### Plugin Installation and Bulk Email Sending Workflow [Demo URL](https://www.bilibili.com/video/BV1gfHN69En9/?vd_source=cc5bd9029a9b181a2119b592e955672c)

## Quick start

### 1. Install the extension

Requires **Chrome 116+** (or any Chromium browser that supports Manifest V3 side
panels). Firefox 128+ is served by a separate `.xpi` build.

**Option A — download a release (recommended):**

1. Go to the
   [**Releases**](https://github.com/dcc123456/browser-copilot/releases) page.
   Every release ships **three builds** — pick one:
   - `browser-copilot-<version>-ocr.zip` — **full build** with local OCR
     (Tesseract.js): the workflow **OCR text recognition** operator and offline
     captcha reading work out of the box.
   - `browser-copilot-<version>-no-ocr.zip` — **lite build** (~35 MB smaller:
     no Tesseract.js engine or language models). Everything else is identical;
     the OCR operator is grayed out and disabled. Image text can still be read
     through a vision model (More → Model settings → image recognition model).
   - `browser-copilot-<version>-firefox.xpi` — **Firefox 128+ build**. It is not
     signed by Mozilla, so load it from `about:debugging#/runtime/this-firefox`
     with **Load Temporary Add-on** (temporary: Firefox drops it on restart), or
     use Developer Edition/ESR after turning off
     `xpinstall.signatures.required`. It does not self-update.
2. Unzip it into a folder you will keep — the extension loads from that folder,
   so don't delete it afterwards. (For the Firefox build, keep the `.xpi` file
   itself.)
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

#### Updating an existing install

Your data belongs to the extension ID, not to the version: settings, workflows,
chats, tasks and permission grants stay as long as the extension keeps the same
ID. Chrome derives an unpacked extension's ID from its **absolute folder path**
(this manifest has no fixed `key`), so replacing files **inside the folder you
already loaded** is safe, while loading the new zip from a **different folder**
creates a second, empty extension.

**On 0.6.8 and later — automatic:**

1. The extension checks GitHub Releases every 12 hours and heals a stale check
   when you open the panel. When a newer version exists, a banner appears in the
   side panel — click **Update** — or use **Settings → Updates → Check for
   updates**.
2. The first update asks for the folder you originally loaded (the one directly
   containing `manifest.json`) and for write permission once. Later updates
   reuse it and ask nothing.
3. It downloads the matching variant, verifies the release's SHA-256 digest,
   backs up the files it replaces into
   `browser-copilot-backup-<old-version>-<timestamp>/` inside the install folder
   (the backup's manifest is `manifest.json.bak`, so the folder cannot be loaded
   as a second extension), then writes the new build. Chrome keeps running the
   old version until you choose **Reload now**; **Later** leaves the files in
   place and the banner reminds you.
4. The backup is deleted automatically the next time the panel opens on the new
   version — that open is the proof the reload worked. (Deleting needs the
   folder permission granted in that browser session; otherwise it stays and is
   retried on a later open.) You can still delete the folder by hand sooner. The
   updater keeps your variant (ocr or no-ocr) and never touches stored data.

**From 0.6.7 or earlier — one manual swap, then automatic:** builds before
0.6.8 have no updater, so replace the files in place once:

1. Locate the folder the extension was loaded from — the folder you unzipped at
   install time, the one that directly contains `manifest.json`.
2. Download the release zip of the **same variant** and unzip it into a
   temporary folder.
3. Close the side panel. Replace the **contents** of the old folder with the new
   build's contents: delete the old files first, or copy over them choosing
   "replace". Keep the folder itself and its path — do not rename or move it.
4. Open `chrome://extensions` and press **Reload** on the Browser Copilot card.
   Do **not** press **Remove**: removing an extension deletes its stored data.
5. Open the side panel and confirm the version under **Settings → Updates**.
   From this point on the automatic updater handles later versions.

Never load the new zip from a new folder while the old one is installed, and
never move or rename the loaded folder: either changes the derived ID, so
Chrome treats it as a different extension and your old data stays hidden under
the old ID. If you configured a storage location (**Settings → Storage
location**), your workflows and chats are real files in that folder and are
unaffected either way; you may need to re-grant access to it after the swap.

To switch between the ocr and no-ocr variants, use the manual swap above — the
automatic updater only follows the variant you have installed. Firefox builds do
not self-update; repeat the install-from-file flow from the release notes.

### 2. Add a model

Open the side panel → **More → Model settings → Add a provider**.

1. **Pick a preset** — the base URL and a suggested model are filled in (DeepSeek,
   Ark, OpenAI, OpenRouter, Moonshot, DashScope, SiliconFlow, Ollama, etc.). You
   can also choose **Custom** for any OpenAI-compatible endpoint.
2. **Paste your API key.** A local Ollama/LM Studio accepts any non-empty string.
3. **Set the model** — type its ID, or press **Fetch models** to list what the
   endpoint offers (typing always works even if the gateway lacks `/models`).
4. Press **Test connection** — it sends one real request and confirms that both
   the key and the model work.
5. **Save.** Add as many providers as you like and switch between them with
   **Use this**, or from the model picker in the chat composer. Each profile can
   also set a **Thinking effort** (provider default, off, low, medium, high) for
   models that accept it.

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
- 🧩 **Workflow generate** — acts like full auto while it learns the task: every
  step that succeeds becomes a node in a workflow draft, which you save when
  the turn ends. It is **not a dry run** — operators really click, type and
  navigate, and JavaScript blocks really run.

### 4. Ask away

Type and press **Enter** (Shift+Enter for a newline; with a Chinese/Japanese/
Korean IME, the first Enter confirms the candidate and the second sends).

- Tick **Attach selection** to send text you highlighted on the page (only the
  selection, not the whole page).
- Type **`/`** in the composer to pick a [skill](#skills) or a command such as
  `/compact`, which compresses the conversation context on demand.
- Type **`@`** to attach a file (images ≤ 4 MB, text ≤ 200 KB; up to 4 files and
  8 MB per message).
- When a skill is selected, you can even send an empty message — it applies the
  skill to your input or selection.
- The model picker beside Send switches the active model for the next reply
  without opening Settings.

Replies render as Markdown. You can close the panel at any time; the answer
keeps running in the background, and reopening it catches you up — the steps run
while the panel was gone stream in, and a confirmation the agent asked for in the
meantime is still answerable.

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
- **Analyze a page's data** — but note the model reasons over _text_, it does
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

| Mode                      | Behavior                                                                                                                                                                               | Best for                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 💬 **Chat**               | Pure conversation. No page-reading or action tools are sent to the model, so it cannot touch the page and uses the fewest tokens. You can still attach a text selection.               | Brainstorming, writing, Q&A, translation — anything where you don't want it acting on the page. |
| 🔒 **Read-only**          | Reads only; no click, type, navigation, or fill.                                                                                                                                       | Review, summary, translation — zero side effects.                                               |
| 🛡 **Semi-auto** (default) | Every page-changing action is shown for approval first.                                                                                                                                | Everyday use; stay in control of each click.                                                    |
| ⚡ **Full auto**          | Actions run without confirmation.                                                                                                                                                      | Repetitive, trusted flows.                                                                      |
| 🧩 **Workflow generate**  | Drives the page exactly like full auto, but only a step that truly succeeded becomes a node in a workflow draft; no per-step approval. Saving the draft is offered when the turn ends. | Turning a task you can describe into a reusable workflow.                                       |

In semi-auto the confirmation card names the exact button/field/URL. In full
auto every action is still logged on the **Data** tab for audit. Workflow
generate is **not a dry run**: its operators really click, type and navigate,
and JavaScript-code blocks run arbitrary code in the page — use it only on
sites you trust and review the generated workflow before running it.

---

## Models

Any endpoint speaking the OpenAI chat-completions protocol
(`POST {baseUrl}/chat/completions`, `Bearer` auth, SSE streaming). A provider is
configuration, not a code path — unlisted endpoints work too.

| Preset               | Base URL                                            | Example model                        |
| -------------------- | --------------------------------------------------- | ------------------------------------ |
| DeepSeek             | `https://api.deepseek.com/v1`                       | `deepseek-chat`, `deepseek-reasoner` |
| 火山方舟 Ark         | `https://ark.cn-beijing.volces.com/api/v3`          | `doubao-seed-code`, or `ep-…`        |
| OpenAI               | `https://api.openai.com/v1`                         | `gpt-4o-mini`                        |
| OpenRouter           | `https://openrouter.ai/api/v1`                      | `deepseek/deepseek-chat`             |
| Moonshot / Kimi      | `https://api.moonshot.cn/v1`                        | `kimi-k2-0905-preview`               |
| 阿里云百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`                          |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1`                     | `deepseek-ai/DeepSeek-V3`            |
| Ollama (local)       | `http://localhost:11434/v1`                         | `qwen3:8b`                           |
| LM Studio (local)    | `http://localhost:1234/v1`                          | `local-model`                        |

**Choosing one:** function calling is required for autonomous read/act. Use a
cheap fast model (`deepseek-chat`, `gpt-4o-mini`, `qwen-plus`) for daily work, a
reasoning model for hard tasks, and a local model when text must stay on your
machine. Page text is capped at ~12,000 characters, so prefer a large context
window for long pages.

Add multiple providers and switch with **Use this**, or pick the active model
from the composer. Keys are stored per profile. **Max action steps per reply**
(default 20, range 1–100) is one batch, not a stop: a panel chat turn spends up
to ten batches (200 steps at the default) before the safety ceiling, re-arming
context compaction at each checkpoint. Scheduled tasks and AI-agent blocks stop
at their single limit. Keys live on this machine only (as files once you pick a
storage folder — not synced, not encrypted) — use a local model if that's
unacceptable.

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
- **Element picker.** Under **More → Settings → Element picker**, switch on a
  crosshair button that then sits in the bottom-right corner of every page.
  Click it, hover to highlight, click an element: the CSS selector, the visible
  text, or the HTML (children included) is copied to your clipboard and the
  element is recorded for the assistant. Turn on **Select without copying** to
  only record it — the assistant, or a local agent via
  `read_selected_element`, can then read the element's selector, tag, text and
  capped HTML; a pick made on a different URL comes back flagged as stale. The
  workflow editor's picker is a separate tool and keeps its card.
- **Long conversations.** When the next request approaches the model's context
  window, older turns (assistant answers and tool exchanges) are replaced by a
  summary; your own messages and the latest turns stay verbatim. Type
  **`/compact`** to do it on demand.
- **Token usage.** **More → Tokens** is the spend board: today / 7 days /
  30 days / since first use, a trend line or tables, and a breakdown by feature
  (chat, workflow generation, workflow run, AI debugging, automatic repair,
  scheduled tasks, context compaction, vision, external API) and by conversation,
  task or workflow. The Runner's own spend is not on this board — read it from
  its [HTTP API](docs/server.md).
- **Language & theme.** Settings → Language (English / 简体中文 / Auto); the
  panel follows the OS light/dark theme live.
- **Storage location.** Settings → Storage location lets you choose a folder on
  your disk; everything is then stored as real files there (see
  [Saved data and privacy](#saved-data-and-privacy)). Until you pick one,
  data stays in browser storage.
- **History.** The clock icon opens past conversations — continue, preview,
  rename, or delete. Threads persist on this machine (newest 200 messages
  each) — as real files once a storage folder is set.
- **Feedback.** **More → Settings** ends with **Feedback & suggestions**: write
  a report, optionally attach diagnostics (extension version, build, browser
  and UI language — no page URLs or credentials), and create a public GitHub
  issue. It uses the same classic GitHub token as the marketplace; without one
  the dialog connects it in place.

---

## Skills

A skill is a saved instruction pack: the stable part of a prompt. Create one
under **Skills → New skill** with a name, a one-line description of when it
applies, and its instructions. Then either type **`/`** in the composer and pick
it, or leave _Let the agent apply this automatically_ on so it is used when your
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

**Four ways to get one:**

- **Record it.** Press Record in the editor and do the task once. Clicks, form
  inputs (text, select, checkbox, radio), scrolling, tab switches, new tabs,
  full-page navigations and SPA route changes are captured as blocks —
  including the wait-for-element / wait-for-load pauses. Stop recording and
  the flow becomes a workflow on the canvas; recording while a canvas is open
  appends its steps after the terminal node instead of saving a second
  workflow.
- **Generate it.** Switch the chat to 🧩 **Workflow generate** and describe the
  task: every step that succeeds becomes a draft node, and the turn ends with
  a save-as-workflow card. A generated workflow can be verified by running it
  once, and **AI repair** proposes a fix for a failing step — saved only after
  an independent run passes.
- **Convert a chat.** After a chat turn that actually acted on pages, save the
  executed actions as a workflow and reuse them without the model in the loop.
- **Draw it.** Drag blocks from the palette and connect them.

**Groups.** Workflows can be filed into groups on the Workflows tab. A group
header's plus creates a workflow already inside it, selected workflows can be
batch-moved, and deleting a group deletes the workflows in it — the
confirmation names the group and counts them.

**What's in the palette.** 56 executable blocks ported from Automa: element
click/hover/scroll, form fill, get text, element exists, loops over data or
elements, while/repeat, condition branches, variables and `{{token}}`
interpolation, JavaScript code, cookies, webhook, clipboard, screenshot,
download handling, new/switch/reload/close tab, delay, and more. (Five Automa
_cloud_ blocks — Google Sheets/Drive, block packages, cloud AI workflows — are
listed for compatibility but not executable.) Every block has a dedicated edit
form, can be disabled individually, and can carry its own error handling: retry
or fall back to another branch on failure.

**Precision targeting.** A built-in element picker generates a CSS or XPath
selector for any target — hover to highlight, click to lock, walk up or down
the DOM, switch between CSS and XPath. Targets inside _closed_ shadow DOM are
reached by clicking through the Chrome DevTools Protocol. One click
auto-lays-out the graph; `Ctrl+S` saves, `Ctrl+Enter` runs from the editor.

**Working in the editor.** The Save button is marked while the graph differs
from what is on disk, a bottom bar offers undo / redo / auto-layout, and a
**Data table** tab lists every run-scoped variable's writers and readers with
jump-to-node links. The canvas also has an AI assistant that writes operators
from a prompt and shows its reasoning; a workflow can declare a goal, and a
verification run reports whether it was reached without AI takeover.

**One special block: AI agent.** It hands that step to the same agent loop the
chat uses — in read-only mode it reads the page (or a specific element) and
answers without acting; in full-auto mode it may click and navigate. The
answer is stored in an output variable later blocks can interpolate. Its form
has a **Skills & tools** fold-out: tools are on unless switched off, skills are
off unless switched on, and anything switched off is removed from the model
request. Nine state-changing tools — closing, pinning and unpinning tabs,
saving files, creating a skill, listing and creating scheduled tasks,
presenting a plan and delegating to a sub-agent — are never offered to an
AI-agent block.

**Launching.** A workflow runs when its trigger fires:

- **Manual** — the Run button in the editor or the Workflows tab;
- **Scheduled** — same schedule options as [scheduled tasks](#scheduled-tasks)
  (once, every N minutes, daily, weekdays, chosen weekdays, or a five-field
  cron expression);
- **At browser startup**, **keyboard shortcut** (per workflow, e.g.
  `Ctrl+Shift+E`), **context menu**, or **when a page whose URL matches a
  pattern is opened**.

**Watching runs.** The History tab's activity board shows running and finished
runs for workflows and tasks alike — live progress, per-block logs, debug
mode, and mid-run cancellation. The Workflows tab shows each workflow's
last-run status, and a failed run deep-links straight to its log.

**Failure retry.** Two levels:

- **Single block.** Every block's _On error_ settings can retry itself N times
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

**Sharing.** A workflow card's publish action opens a pull request to the
public marketplace or a connected team repository — see
[Workflow marketplace](#workflow-marketplace).

---

## Workflow marketplace

The **Marketplace** tab (under **More**) shares workflows through GitHub — no
extra server. There are two sources:

- **Public** — listings in the project's public repository. Applying a card
  first asks you to confirm the workflow can act on pages, then saves a local
  copy with **every trigger disabled**; nothing runs until you start it.
  Re-applying reuses that copy instead of stacking duplicates.
- **Team** — private repositories you connect in **More → Settings → Team
  sharing**, each with its own classic GitHub token that has the `repo` scope
  (teams often live under different GitHub accounts). The Team view reads every
  connected repository and merges the results, with a filter per repository; a
  repository that fails to load only drops its own cards and is named in a
  banner.

Browse with search, category filters and sorting (recently updated or most
liked). Likes and comments ride the pull request's reactions and thread, with a
GitHub link on every card.

**Publishing.** A workflow card's publish action opens a dialog for the title,
description, category, tags, an optional video link, up to three screenshots and
up to three attachments (200 KB each). Pick the public marketplace or any
connected repository as the target — the dialog reopens on the repository the
workflow was last published to, and drafts are kept per target and survive
closing the dialog. A workflow that calls other workflows publishes them as a
bundle; a workflow that uses stored credentials lists the credential and field
names and commits them with the listing. Publishing opens a pull request: your
own releases merge automatically when the token may write, while third-party
publishers keep a PR for review. Re-publishing updates the existing listing;
**Unpublish** opens a removal PR, and copies already applied keep working.

**Applying and updating.** A listing that bundles workflows creates a group
named after the parent and files the parent plus its sub-workflows there;
carried credentials are imported before anything is saved. An installed
workflow shows **Update available** when the publisher's listing moves ahead —
a newer version, or a changed content hash at the same version. Updating
replaces steps, trigger and settings while keeping the local id, group and
creation time.

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
- **Run a saved workflow** — the same replay the Workflows tab does, on a
  schedule, and it can hand its outputs to another task.
- **Count PRs waiting for your review on GitHub** — the built-in task.
- **Chain tasks.** A task can declare the outputs it hands off and which task it
  follows, then reference `{{upstream.<key>}}` in its prompt. The reference is
  resolved when the child runs, from the parent's last successful run — so the
  follow-up can be written before its input exists, like a comment task scheduled
  against a note that hasn't been published yet.

**When it runs** (Chrome's `chrome.alarms`, 1-minute minimum). A task can hold
**several trigger methods at once**; each entry arms its own alarm and adds
another scheduled run:

- Once at a specific date and time (the schedule disarms after it fires),
- Every N minutes,
- Daily at a set time,
- Weekdays (Mon–Fri) at a set time,
- Weekly on chosen days, or
- A five-field **cron** expression (`0 9 * * 1-5`), evaluated in local time;
  invalid text keeps the editor from saving, and a pattern that can never occur
  stays unarmed with a hint.

**There is one parameter surface: the task's `variables` bag.** The chat's agent writes it
(the `create_scheduled_task` tool), and a chained task can fill an entry from
`{{upstream.<key>}}`.

- **Workflow task** — the bag is handed to the engine as the run's variables, and it wins
  over the defaults the workflow's trigger node declares, so `{{name}}` references recorded
  on the canvas resolve against it.
- **Prompt task** — only the instruction text is interpolated, and the interpolation table
  holds `{{upstream.*}}` (the parent's last successful run). The task's own `variables` are
  not injected into the conversation.

The panel's task dialog has no parameter field: it neither lists nor edits `variables`. It
does save the whole task record, so what the agent wrote survives a rename or a schedule
change. A workflow launched by its own trigger rather than by a task gets only its declared
defaults — the schedule itself carries no parameters. The `create_scheduled_task`
agent tool accepts the same cadences, including `kind: "cron"`.

Each run is recorded in **Recent runs** with its start time, outcome, steps, and a
short summary — and can be terminated mid-flight. Tasks only fire while the
browser is open (the service worker is woken by the alarm); they don't run when
Chrome is closed. Turn on **Notify via Feishu when done** to push the result out.
A task created from the chat shows up in the list right away, and **Edit** opens
it in a dialog.

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
mcp-server.mjs   (zero-dependency Node adapter, bundled in the package, one-click export)
     │  WebSocket · ws://127.0.0.1:8765   (loopback only)
     ▼
Browser Copilot extension   (executes every call in your Chrome)
```

**Requirements.** Node.js ≥ 18 and the extension loaded in Chrome. The adapter
is one dependency-free file, `mcp-server.mjs`, **bundled inside the extension
package** — no source checkout or separate download needed: click
**Export adapter** once on the settings card and it is saved to
`browser-copilot/` under your Downloads folder, with the snippets below
auto-filled with that absolute path. Source builds can also use
`public/mcp-server.mjs` from the repository directly (it lands at the extension
root after build); the file does not need to sit inside the extension folder.

**Manual setup, three steps:**

1. Extension panel → **Settings → Local agent access** → turn the switch on.
   Keep the adapter address `ws://127.0.0.1:8765` and optionally set a shared
   token; the card shows **Connected** once the link is up.
2. On the same card, click **Export adapter**, then copy the ready-made
   Claude Code / Codex / Trae snippet — its absolute path is filled in
   automatically (re-export once after upgrading the extension).
3. Start (or restart) your agent — it spawns the adapter over stdio and the
   extension dials in automatically. No daemon, no `npm install`, no Python.

> 🤖 **Let the AI wire it up.** Copy the prompt below and paste it to your
> coding agent (Claude Code / Codex / Trae all work) — it guides you through
> the export and completes the whole integration:
>
> ```text
> Please set up MCP access to the Browser Copilot Chrome extension for me.
> First turn on "Local agent access" in the extension panel under Settings,
> and click "Export adapter" to save mcp-server.mjs to the browser-copilot/
> folder under Downloads. Check the Node.js environment, ask me for an
> optional shared token, write the MCP config for your client using the
> ABSOLUTE path of the exported file (copy-ready Claude Code/Codex/Trae
> snippets are on that settings card), and verify the whole chain with a
> live call before reporting back. The full guide lives in
> examples/local-agent/MCP-SETUP-PROMPT.md in the source repository
> (https://github.com/dcc123456/browser-copilot/blob/main/examples/local-agent/MCP-SETUP-PROMPT.md);
> do not guess paths.
> ```
>
> Curious what the AI will read? The full instructions are in
> [`examples/local-agent/MCP-SETUP-PROMPT.md`](examples/local-agent/MCP-SETUP-PROMPT.md).

Tools appear as `browser-copilot` MCP tools (`read_current_page`,
`snapshot_page`, `read_selected_element`, `click`, `fill`, `open_url`, `run_javascript`,
`recognize_image`, `get_secret`, `use_skill`, …). With the page element picker
in **Select without copying** mode, the element you picked is available to
`read_selected_element` — selector, tag, visible text and capped HTML, with a
`target` ready for `click` / `fill`, and a pick from another URL flagged as
stale. Security: the adapter binds loopback only; an optional shared token keeps
other local processes out; passwords are filled via `get_secret` without their
values ever reaching the model; tools you disabled in the extension stay
refused even when asked for.
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

Once a folder is chosen nothing is written to `chrome.storage.local` any more, so
its 10 MB quota stops being a ceiling. The one thing that can still land there is
a write made while the folder is momentarily unavailable — right after a browser
restart, before you have re-granted access; it is readable from there and pushed
into the folder the next time the panel opens. Switch back to browser storage any
time from the same settings card: the folder is copied back first, so nothing is
left behind. Existing data migrates to the folder the first time you pick it.

| Permission            | Purpose                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `storage`             | Settings, providers, skills, conversations, workflows, profile, credentials.                              |
| `unlimitedStorage`    | Lift `chrome.storage.local`'s 10 MB cap so long conversations and many workflows still save.              |
| `tabs`                | Identify the active tab and open/switch/close tabs when asked (and for workflow tab blocks).              |
| `scripting`           | Inject the page kernel, workflow recorder, element picker, and shortcut listener to read or act on a tab. |
| `sidePanel`           | Show the panel.                                                                                           |
| `alarms`              | Wake the worker to run scheduled tasks and workflows and keep the Feishu bot connection alive.            |
| `offscreen`           | Run a hidden document so the workflow clipboard block can read/write the system clipboard.                |
| `contextMenus`        | Add the right-click item that launches workflows with a context-menu trigger.                             |
| `webNavigation`       | Detect page navigations for visit-web workflow triggers and for recording.                                |
| `cookies`             | The workflow Cookie block reads/sets/removes cookies.                                                     |
| `downloads`           | The workflow download-handling block observes and manages downloads.                                      |
| `clipboardRead`       | Read the system clipboard for the workflow clipboard block.                                               |
| `debugger`            | Click elements inside closed shadow DOM via the Chrome DevTools Protocol.                                 |
| `http(s)` host access | Interact with pages and call your model endpoint (and Feishu, if enabled).                                |

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
pnpm run build:no-ocr  # lite bundle (no local OCR) into dist-no-ocr/
pnpm run build:firefox # Firefox bundle into dist-firefox/
pnpm run package     # build all variants → releases/browser-copilot-<version>-ocr.zip
                     #                    + releases/browser-copilot-<version>-no-ocr.zip
                     #                    + releases/browser-copilot-<version>-firefox.xpi
```

Load `dist/` unpacked, then press **Reload** on the extension card after changes.
`npm` works as well as `pnpm`. Pushing a tag runs
`.github/workflows/release.yml`, which typechecks, tests, builds, and attaches
all three loadable artifacts (full `-ocr`, lite `-no-ocr` and Firefox `.xpi`)
to the GitHub Release.

---

## Server runner

To run workflows unattended on a remote server (HTTP API / cron / webhooks /
Feishu triggers, nested sub-workflows with copy validation, persisted profiles,
a remote CDP browser and Docker deployment), see
**[docs/server.md](docs/server.md)**. The extension itself is unaffected.

After `pnpm --dir server build`, the runner also serves a **web console** at
`http://<server>:8787/`: configure the model, Feishu, tokens and browser
parameters, import and edit workflow JSON in the browser, manage schedules, run
workflows and watch step-by-step logs — the CLI stays available for everything.

Key design notes: Markdown is parsed to a typed tree (never HTML, no
`dangerouslySetInnerHTML`); the in-page kernel is self-contained and injected
across frames; durable state is persisted to real files when a storage folder is
chosen (with `chrome.storage.local` holding only writes that could not reach the
folder yet) so data survives MV3 service-worker eviction at idle; mode and step
cap are read per action so
settings changes apply without a reload.

---

## Troubleshooting

| Symptom                          | Fix                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| "No model provider configured"   | More → Model settings → Add a provider.                                                                                                         |
| 401 / 403                        | Wrong/expired key, or key/vendor mismatch.                                                                                                      |
| 404 when sending                 | Base URL missing its version segment, or unknown model; press **Test connection**.                                                              |
| "Cannot read this page"          | `chrome://`, `file://`, Web Store, or extension page — not injectable.                                                                          |
| Action still asks in full auto   | Reload the extension; confirm the dropdown shows ⚡ Full auto.                                                                                  |
| "Stopped after N tool rounds"    | The safety ceiling was reached (ten batches in chat; one in a task or AI-agent block). Send "continue" or raise **Max action steps per reply**. |
| Chats but never reads/acts       | Model lacks function calling; attach the page or switch model.                                                                                  |
| Page text empty/partial          | Content is in an iframe, lazy-loaded, or behind "Load more"; select the relevant section.                                                       |
| Nothing happens on toolbar click | Reload the extension; the worker may have failed to start.                                                                                      |

---

## Limitations

- One active tab at a time; broad reads see the rendered DOM (iframes targeted
  per-action).
- Panel-started actions are locked to the panel's window: if that window only
  shows `chrome://` (or other non-automatable) pages, the assistant reports
  "no actionable tab in the panel's window" instead of reaching into another
  window.
- Page text capped at ~12,000 characters; truncation is reported to the model.
- A panel chat turn runs ten batches of the configured cap (200 steps at the
  default), then stops; scheduled tasks and AI-agent blocks stop after one.
- The marketplace and update checks share GitHub's anonymous API quota; a
  blocked refresh shows the cached list and names the reason. Publishing and
  team sharing need a classic GitHub token.
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

# Browser Copilot

**English** · [简体中文](README.zh-CN.md)

A Chrome extension (Manifest V3) that puts an AI assistant in the browser side
panel. It can **read and act on the page you are looking at** — click, type,
scroll, switch tabs, and fill forms — and works with any OpenAI-compatible
model: DeepSeek, 火山方舟 Ark, OpenAI, a local Ollama, and more.

How much it does on its own is up to you. Three modes let you keep every click
in your hands, hand off whole tasks, or stay read-only. It does nothing on a
timer — every action is part of answering something you just asked.

---

## Contents

- [What it is good for](#what-it-is-good-for)
- [Agent modes](#agent-modes)
- [Install](#install)
- [Supported models](#supported-models)
- [Configuring a model](#configuring-a-model)
- [Using it](#using-it)
- [Saved profiles and passwords](#saved-profiles-and-passwords)
- [Conversation history](#conversation-history)
- [Skills](#skills)
- [Privacy and permissions](#privacy-and-permissions)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## What it is good for

It is at its best when a task lives on one page and needs a mix of reading and
acting. Each use case below carries an honest caveat — knowing where a tool
stops is what makes it usable.

### Filling forms and applying saved info

> Fill this registration form with my saved profile, and use the work email
> credential for the password field.

The assistant can type into fields, select dropdowns, tick checkboxes, and
submit. Your saved profile fills name/email/phone/address, and a saved password
is filled **directly into the field without the model ever seeing the value**.

### Walking through a multi-step task

> Add this item to the cart and check out with the saved address.

It can click buttons and links, wait for navigation, scroll to reveal more, and
open/switch tabs to follow a flow. In **full auto** it runs the sequence; in
**semi-auto** it shows each action for your approval first.

### Reviewing a pull request

Open the **Files changed** tab of a PR and ask for a review — logic errors,
missing edge cases, naming, whether the change matches its description.

> Review this diff. Focus on error handling and anything that could break
> existing callers.

**Select the specific hunk first.** Selected text is captured separately from
the page body, so highlighting one function gives the model a precise target
instead of the whole diff. GitHub collapses large diffs behind "Load diff"
buttons — the extension only sees what is actually rendered, and page text is
capped at ~12,000 characters.

### Summarizing a web page

Long articles, documentation, release notes, forum threads, research papers —
one page, one read, one answer. Works on any ordinary http(s) page.

> Summarize the key points in five bullets, then list anything the author
> asserts without evidence.

### Understanding unfamiliar code or docs

Open a file on GitHub, an API reference, or a spec, and ask for an explanation
at the level you need.

> Explain what this module does and why it might have been written this way.

### Analyzing data on a page

Dashboards, HTML tables, query results, log output, pricing pages.

> What is the trend across these quarters, and which row is the outlier?

**Read the caveat.** The model receives the table as *text* and reasons about it
— nothing is computed. Language models are unreliable at arithmetic over long
tables, so treat any number as a hypothesis to verify. Ask for the reasoning
("which rows led you to that?") rather than a bare total.

### Translating and rewriting, and comparing against a standard

Pair a repeatable task with a [skill](#skills) holding your team's checklist — a
code-review rubric, a security checklist, a writing style guide — and apply the
same standard to every page without retyping it.

### What it cannot do

| Not supported | Why |
| --- | --- |
| Act in **read-only** mode | The mode removes action tools and refuses any click/type/navigation; switch to semi or full. |
| Read `chrome://`, local files, the Web Store | Chrome forbids extension injection there. No permission changes this. |
| Defeat a bot wall or log in for you from nothing | It can fill credentials you saved, but cannot solve CAPTCHAs or bypass 2FA. |
| Guarantee correctness over long tables | It reasons over text; it does not compute. See the data caveat above. |
| Run on a schedule | There is no timer and no `alarms` permission. |

---

## Agent modes

Pick a mode from the dropdown at the bottom-left of the chat. The choice applies
to the **next action** — including actions within a reply already in progress, so
you can switch mid-task and have it take effect immediately.

| Mode | Behavior | Best for |
| --- | --- | --- |
| 🔒 **Read-only** | No clicking, typing, navigating, switching tabs, or filling. Reads only. | Reviewing, summarizing, translation; anything where you want zero side effects. |
| 🛡 **Semi-auto** (default) | Every action that changes the page is shown to you first; approve or decline. Reads of an attached page run without prompting. | Everyday use; stay in control of each click. |
| ⚡ **Full auto** | Actions run without confirmation, including reads and writes. A warning appears when you first switch to it. | Repetitive, well-understood flows you trust it to run. |

An info icon next to the dropdown explains the current mode. In semi-auto the
confirmation card shows exactly what the agent is about to do (which button,
which field, which URL). In full auto the same actions are still recorded in the
operation log on the **Data** tab, so a run is auditable afterwards.

---

## Install

Requires **Node.js 20+** and **Chrome 116+**.

```bash
git clone git@github.com:dcc123456/browser-copilot.git
cd browser-copilot
pnpm install
pnpm run build
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the generated **`dist/`** folder.
4. Click the extension's toolbar icon to open the side panel.

`npm install && npm run build` works too if you prefer npm.

There is no prebuilt archive to download: the bundle would be unsigned and
unreviewed, so building from source is the honest distribution path.

### Updating

```bash
git pull
pnpm install
pnpm run build
```

Then press **Reload** on the extension card in `chrome://extensions`. A rebuild
alone does not refresh an already-loaded service worker.

---

## Supported models

Any endpoint that speaks the OpenAI chat-completions protocol. There is no
vendor-specific code in this extension — a provider is configuration, not a code
path — so an endpoint not listed here still works, as long as it accepts
`POST {baseUrl}/chat/completions` with `Bearer` auth and SSE streaming.

These presets exist only to prefill base URLs. Every field stays editable.

| Preset | Base URL | Example model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` |
| 火山方舟 Volcengine Ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-code`, or an endpoint ID `ep-…` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| 阿里云百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen3:8b` |
| LM Studio (local) | `http://localhost:1234/v1` | `local-model` |
| Custom | — | anything OpenAI-compatible |

### Choosing a model

**Function calling is what matters.** The assistant reads and acts on a page by
calling tools, so a model without function-calling support will chat happily but
never read or act on its own. Attaching the page manually still works, which
keeps weaker models usable but less convenient.

- **General use** — `deepseek-chat`, `gpt-4o-mini`, `qwen-plus`: fast and cheap.
- **Code review and hard reasoning** — `deepseek-reasoner`, `doubao-seed-code`.
- **Long pages and long tasks** — prefer a large context window; page text is
  capped at ~12,000 characters, and a multi-step turn keeps its own history.
- **Local / private** — Ollama or LM Studio, so no page text leaves your machine.
  Choose a tool-calling model (a recent Qwen, for instance) and expect slower
  replies.

---

## Configuring a model

Open the side panel → **Settings** → **Add a provider**.

1. **Pick a preset.** The base URL and a suggested model are filled in.
2. **Paste your API key.** Get one from the vendor:
   [DeepSeek](https://platform.deepseek.com/api_keys) ·
   [Ark](https://console.volcengine.com/ark) ·
   [OpenAI](https://platform.openai.com/api-keys) ·
   [OpenRouter](https://openrouter.ai/keys) ·
   [Moonshot](https://platform.moonshot.cn/console/api-keys) ·
   [DashScope](https://bailian.console.aliyun.com/) ·
   [SiliconFlow](https://cloud.siliconflow.cn/account/ak).
   For a local Ollama or LM Studio, any non-empty string works.
3. **Set the model.** Type it, or press **Fetch models** to list what the
   endpoint offers. Not every gateway implements `/models`, so typing the name is
   always valid.
4. **Press Test connection.** This sends one real request and reports whether the
   key *and* the model both work.
5. **Save.**

### The fields

| Field | Notes |
| --- | --- |
| **Label** | Your own name for this profile, e.g. "Ark coding plan". |
| **Base URL** | Everything up to but **not** including `/chat/completions`. Keep the version segment (`/v1`, `/api/v3`) — vendors disagree about it. A pasted full endpoint is trimmed automatically. |
| **API key** | Sent as `Authorization: Bearer …`. |
| **Model** | A model ID, or on Ark a dedicated endpoint ID (`ep-…`). |
| **Temperature** | Optional. Left blank, the server default applies. |
| **Max tokens** | Optional response cap. Blank means the server decides. |
| **Extra headers** | Optional JSON, for gateways needing attribution or routing headers. |

### Several providers at once

Add as many as you like and switch with **Use this** — a strong model for
review, a cheap one for summaries, a local one for anything sensitive.
Credentials are kept per profile, so switching never means retyping a key.

### Max action steps per reply

Settings exposes a cap on how many actions (reads, clicks, scrolls, fills) the
agent may take in one turn before it stops to avoid a loop. The default is
**20**; set it from 1 to 100. A task that hits the cap is not lost — just send
"continue" to pick up where it stopped.

### Where the key is stored

In `chrome.storage.local`, on this machine only. Deliberately **not** in
`storage.sync`, which would copy your keys to every browser you are signed into.

It is **not encrypted**: anyone who can read your browser profile directory can
read it. That is the normal limit for an extension without a master password — if
that is unacceptable for a particular key, use a local model instead.

---

## Using it

### Chat

Type and press **Enter** (**Shift+Enter** for a newline). With an IME (Chinese,
Japanese, Korean), the first Enter confirms the in-place candidate and the second
sends, so composing is not interrupted.

The toolbar just below the tabs holds **Attach current page** (left) and the
**history** button (right). The input area can be resized by dragging its top
edge; the height is remembered.

When the conversation has content, a **＋ New chat** button appears next to
Send. Close the panel whenever you like: the turn keeps running in the
background, and reopening restores the transcript and rejoins a reply still in
progress.

Replies render as Markdown — headings, lists, tables, and code blocks with a copy
button. What *you* type stays exactly as typed. CJK punctuation keeps to its
clause (a trailing `？` or `。` is not stranded on its own line).

### Reading and acting on the page: two paths

- **You attach it.** Tick *Attach current page*. No prompt — you already said
  which page, and when. The assistant can re-read that page without asking for
  the rest of the turn.
- **The assistant asks.** A model-initiated action on a page you did not attach
  — a read in semi-auto, or any click/type — shows a confirmation first (unless
  you are in full auto).

The active tab might be webmail, an internal dashboard, or a bank statement. A
deliberate attach is consent; a model deciding on its own is not, which is why
semi-auto confirms each step. The attach waiver is scoped to **that page**,
compared by origin and path (the query string and `#fragment` are ignored).
Switch tabs mid-reply and the new page is gated again.

**Settings → Page access → Check active tab** tells you whether the current tab
can be read at all, before you rely on it.

### Language

**Settings → Language**: English, 简体中文, or *Automatic* to follow the browser.
The panel's language is independent of Chrome's own UI language.

### Appearance

The panel follows your **operating system** theme — light or dark — and switches
live when you change it, with no reload. Both themes are checked against WCAG AA
contrast (4.5:1) by the test suite.

---

## Saved profiles and passwords

The **Data** tab holds what the agent is allowed to fill for you.

- **Profile** — name, email, phone, address, and any custom fields. When a form
  asks, call `get_my_profile` to see what is available, then fill each field.
- **Passwords** — entries stored by label, URL, and username. The agent lists
  them by label only; to use one it calls `get_secret`, which **fills the
  password directly into the target field** and never returns the value to the
  model. Each use updates a usage count; entries can be renamed or deleted.
- **Operation history** — every action (click, fill, scroll, navigation, tab
  switch) is recorded with a timestamp and host, marked by whether it was
  approved, auto-run, or declined. Entries can be deleted individually or
  cleared wholesale.

Saved values live in `chrome.storage.local` on this machine; they are not
synced and never sent to the model. Passwords are not encrypted at rest — see
[key storage](#where-the-key-is-stored).

---

## Conversation history

The clock icon in the chat toolbar opens a left-hand drawer listing past
conversations. Each row shows its title (the first user message), relative time,
and message count. From there you can:

- **Continue** a conversation — click the row; the full transcript (including
  action chips) is restored and the model has the prior context.
- **Preview** it in place with the eye icon.
- **Rename** it inline.
- **Delete** it.

Conversations are persisted in `chrome.storage.local` (durable across browser
restarts, trimmed to the newest 200 messages per thread). The **＋ New chat**
button in the drawer or next to Send starts a fresh thread.

---

## Skills

A skill is a saved instruction pack — the stable part of a prompt without the part
that changes.

**Skills → New skill**, give it a name, a one-line description of when it
applies, and the instructions. Then either:

- type **`/`** in the composer and pick it, or
- leave *Let the agent apply this automatically* on, and it will be used when
  your message matches the description.

Useful for a code-review checklist, a summary format you always want, a
translation glossary, or an extraction schema.

Only names and descriptions are shown to the model up front; full instructions
load on demand, so ten skills do not cost ten instruction bodies per request.

---

## Privacy and permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save settings, providers, skills, conversations, profile, and credentials. |
| `tabs` | Know which tab is active and read its title/URL; open, switch, and close tabs when you ask. |
| `scripting` | Inject the page kernel to read or act on the active tab. |
| `sidePanel` | Show the panel. |
| `host_permissions` for `http(s)` | Read and interact with pages, and call your model endpoint. |

Notably **absent**: `alarms` (nothing runs on a timer), and any always-on content
script — nothing is injected into a page until a turn needs it.

**What leaves your machine:** your messages, and page text you attached or
approved, sent to the model endpoint you configured. Saved passwords are filled
locally and are **never** included in a request. There is no telemetry, no
analytics, and no server belonging to this project.

**Conversation transcripts** are persisted in `chrome.storage.local` so you can
continue them later; each thread keeps its newest 200 messages. Clear any thread
from the history drawer, or wipe the whole extension's storage from
`chrome://extensions` if you want a clean slate.

---

## Development

```bash
pnpm run dev         # rebuild on change
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest
pnpm run build       # production bundle into dist/
pnpm run icons       # regenerate public/icons
```

After changing the service worker, press **Reload** in `chrome://extensions`.

```
src/
  background/
    index.ts      Service worker: command channel + streaming agent port
    agent.ts      Tool schemas, tool-call loop, mode and confirmation gating
    driver.ts     Tab/frame execution driver, navigation and tab management
    page.ts       Reads the active tab via one-off script injection
    keepalive.ts  Reference-counted keepalive for in-flight turns
  inpage/
    kernel.ts     Self-contained in-page op runner (click, fill, scroll, snapshot)
  lib/
    llm.ts        OpenAI-compatible streaming client + SSE accumulator
    providers.ts  Provider profiles, presets, validation
    storage.ts    chrome.storage access, settings, skills, conversations, data
    ops.ts        Op/Target/PageSnapshot types shared across driver and kernel
    messages.ts   Panel ↔ worker wire protocol
    pages.ts      Which URLs may be read at all, and same-page comparison
    extract.ts    Whitespace collapsing and budget truncation
    skills.ts     Skill validation and prompt composition
    slash.ts      Slash-command parsing for the composer
    markdown.ts   Markdown parser producing a typed tree (no HTML)
    i18n.ts       Message dictionaries
  sidepanel/      React UI: Chat, Skills, Data, Settings
```

Design notes worth knowing before changing things:

**Markdown is parsed to a tree, never to HTML.** Assistant text is untrusted —
the model may have just read an attacker-controlled page — and this panel is
privileged, since script here could reach `chrome.storage` where the keys live.
So no HTML string is ever built and `dangerouslySetInnerHTML` appears nowhere.
Link targets are checked against a scheme **allowlist**.

**The in-page kernel is self-contained.** It is serialized with
`chrome.scripting.executeScript({ func, args })`, so it cannot reference
module-scope state; all helpers live inside the function. The driver injects
across all frames, ranks results, and recovers from navigation context loss.

**Everything durable is in `chrome.storage`.** An MV3 service worker is evicted
after ~30 seconds idle, taking every module-level variable with it. A turn also
holds a reference-counted keepalive, because closing the panel destroys the port
that was keeping the worker awake — and closing the panel mid-answer is
supported. The agent reads the autonomy mode and step cap per turn (and per
action), so a setting change applies without a reload.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "No model provider configured" | Settings → Add a provider. |
| 401 / 403 | Wrong or expired key, or a key belonging to a different vendor than the base URL. |
| 404 when sending | Base URL missing its version segment (`/v1`, `/api/v3`), or an unknown model name. Press **Test connection** to localize it. |
| "Cannot read this page" | A `chrome://`, `file://`, Web Store, or extension page. No permission can fix this. |
| An action still asks in full auto | Reload the extension in `chrome://extensions`; then confirm the dropdown shows ⚡ Full auto. The mode is read before every action. |
| "Stopped after N tool rounds" | The step cap was reached. Send "continue", or raise **Max action steps per reply** in Settings. |
| Page text looks empty or partial | Content is in an iframe, rendered after the read, or behind a "Load more". Reload and retry; select the part you care about. |
| Assistant chats but never reads or acts | The model does not support function calling. Attach the page manually, or switch model. |
| A long page seems truncated | It is: ~12,000 characters. Select the relevant section first. |
| Nothing happens on the toolbar click | Reload the extension; the worker may have failed to start. |
| A local model refuses the request | Confirm the server is running and its base URL ends in `/v1`. |

---

## Limitations

- One tab at a time. Frames are addressed when an action targets them, but
  broad page reads still see the rendered DOM.
- Page text is capped at ~12,000 characters; truncation is reported to the model
  so it can say so rather than inventing the rest.
- Tool calls stop after the configured cap (20 by default) to bound a confused
  model.
- Autonomous reads and actions need a function-calling model.
- The endpoint must accept requests from a browser extension. Public APIs do; a
  strict internal gateway may not.
- Saved passwords are not encrypted at rest; use a local model if a key or secret
  cannot live in the browser profile.

---

## License

[MIT](LICENSE)

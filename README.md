# Browser Copilot

**English** · [简体中文](README.zh-CN.md)

A Chrome extension (Manifest V3) that puts an AI assistant in the browser side
panel, able to read the page you are looking at. Works with any
OpenAI-compatible model — DeepSeek, 火山方舟 Ark, OpenAI, a local Ollama, and
more.

It reads and advises; it never clicks, types, or navigates. And it does nothing
on a timer — every action answers something you just did.

---

## Contents

- [What it is good for](#what-it-is-good-for)
- [Install](#install)
- [Supported models](#supported-models)
- [Configuring a model](#configuring-a-model)
- [Using it](#using-it)
- [Skills](#skills)
- [Privacy and permissions](#privacy-and-permissions)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## What it is good for

The pattern is always the same: open a page, ask a question about it. Below are
the cases it handles well — each with the honest caveat, because knowing where a
tool stops is what makes it usable.

### Reviewing a pull request

Open the **Files changed** tab of a PR and ask for a review — logic errors,
missing edge cases, naming, whether the change matches its description.

> Review this diff. Focus on error handling and anything that could break
> existing callers.

**Works best when you select the specific hunk first.** Selected text is
captured separately from the page body, so highlighting one function gives the
model a precise target instead of the whole diff. This matters because GitHub
collapses large diffs behind "Load diff" buttons — the extension only sees what
is actually rendered, and page text is capped at ~12,000 characters (roughly
3,000–4,000 English words). For a big PR, review it a few files at a time rather
than expecting one pass over everything.

It cannot navigate between files or post a comment for you. It reads the tab you
are on; you act.

### Summarizing a web page

Long articles, documentation, release notes, forum threads, research papers.

> Summarize the key points in five bullets, then list anything the author
> asserts without evidence.

This is the strongest use case: one page, one read, one answer. Works on any
ordinary http(s) page.

### Understanding unfamiliar code or docs

Open a file on GitHub, an API reference, or a spec, and ask for an explanation
at the level you need.

> Explain what this module does and why it might have been written this way.

> What is the minimal request that satisfies this API?

### Analyzing data on a page

Dashboards, HTML tables, query results, log output, pricing pages.

> What is the trend across these quarters, and which row is the outlier?

**Read the caveat.** The model receives the table as *text* and reasons about it
— nothing is computed. Language models are unreliable at arithmetic over long
tables, so treat any number as a hypothesis to verify, not a calculation. Ask for
the reasoning ("which rows led you to that?") rather than a bare total.

### Translating and rewriting

> Translate this page into Chinese, keeping technical terms in English.

> Rewrite this paragraph so a non-specialist understands it.

### Comparing against a standard

Pair this with a [skill](#skills) holding your team's checklist — a code-review
rubric, a security checklist, a writing style guide — and apply the same
standard to every page without retyping it.

### What it cannot do

| Not supported | Why |
| --- | --- |
| Fill forms, click buttons, navigate | Read-only by design: it observes, you act. |
| Read several tabs at once | It reads the tab you are looking at, one read at a time. |
| Read `chrome://`, local files, the Web Store | Chrome forbids extension injection there. No permission changes this. |
| See content inside iframes | Only the top frame is read (embedded players, some comment widgets). |
| Run code or compute | It reasons over text. See the data caveat above. |
| Work on a schedule | There is no timer and no `alarms` permission. |

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

**Function calling is what matters.** The assistant reads a page by calling a
tool, so a model without function-calling support will chat happily but never
read anything on its own. Attaching the page manually still works, which keeps
weaker models usable but less convenient.

- **General use** — `deepseek-chat`, `gpt-4o-mini`, `qwen-plus`: fast and cheap.
- **Code review and hard reasoning** — `deepseek-reasoner`, `doubao-seed-code`.
- **Long pages** — prefer a large context window; page text is capped at ~12,000
  characters, but the conversation grows on top of that.
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
   key *and* the model both work — better than discovering a typo mid-answer.
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

### Where the key is stored

In `chrome.storage.local`, on this machine only. Deliberately **not** in
`storage.sync`, which would copy your keys to every browser you are signed into.

It is **not encrypted**: anyone who can read your browser profile directory can
read it. That is the normal limit for an extension without a master password — if
that is unacceptable for a particular key, use a local model instead.

---

## Using it

### Chat

Type and press **Enter** (**Shift+Enter** for a newline).

Tick **Attach current page** to send the page you are on along with your message.

Close the panel whenever you like: the turn keeps running in the background, and
reopening restores the transcript and rejoins a reply still in progress.

Replies render as Markdown — headings, lists, tables, and code blocks with a copy
button. What *you* type stays exactly as typed.

### Reading the page: two paths

- **You attach it.** Tick *Attach current page*. No prompt — you already said
  which page, and when. For the rest of that message the assistant can also
  re-read the page without asking, since consent is already given.
- **The assistant asks.** A model-initiated read of a page you did not attach
  shows a confirmation first.

The asymmetry is deliberate. The active tab might be webmail, an internal
dashboard, or a bank statement, and reading it sends that text to a third-party
model. A deliberate attach is consent; a model deciding on its own is not.

The waiver from an attach is scoped to **that page**, compared by origin and path
(the query string and `#fragment` are ignored, so a single-page app rewriting its
URL does not re-prompt). Switch tabs mid-reply and the new page is gated again —
consent covered one page, not every page from then on. Anything that cannot be
proven identical, including a tab whose URL is unknown, re-prompts.

**Settings → Page access → Check active tab** tells you whether the current tab
can be read at all, before you rely on it.

### Language

**Settings → Language**: English, 简体中文, or *Automatic* to follow the browser.
The panel's language is independent of Chrome's own UI language, since people
routinely run an English Chrome while wanting a Chinese panel.

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
| `storage` | Save settings, providers, and skills. |
| `tabs` | Know which tab is active and read its title/URL. |
| `scripting` | Inject the one-off read-only scraper when you ask for a page read. |
| `sidePanel` | Show the panel. |
| `host_permissions` for `http(s)` | Read page text, and call your model endpoint. |

Notably **absent**: `alarms` (nothing runs on a timer), and any always-on content
script — nothing is injected into a page until you ask for a read.

**What leaves your machine:** your messages, and page text you attached or
approved, sent to the model endpoint you configured. Nothing else, nowhere else.
There is no telemetry, no analytics, and no server belonging to this project.

**Conversation transcripts** live in `chrome.storage.session` — memory-backed and
cleared when the browser closes, so scraped page text never lands on disk. Only
the most recent 200 messages are kept.

---

## Development

```bash
pnpm run dev         # rebuild on change
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest — 184 tests
pnpm run build       # production bundle into dist/
pnpm run icons       # regenerate public/icons
```

After changing the service worker, press **Reload** in `chrome://extensions`.

```
src/
  background/
    index.ts      Service worker: command channel + streaming agent port
    agent.ts      Tool schemas, tool-call loop, confirmation gating
    page.ts       Reads the active tab via one-off script injection
    keepalive.ts  Reference-counted keepalive for in-flight turns
  lib/
    llm.ts        OpenAI-compatible streaming client + SSE accumulator
    providers.ts  Provider profiles, presets, validation
    storage.ts    chrome.storage access, settings, skills, transcripts
    messages.ts   Panel ↔ worker wire protocol
    pages.ts      Which URLs may be read at all, and same-page comparison
    extract.ts    Whitespace collapsing and budget truncation
    skills.ts     Skill validation and prompt composition
    slash.ts      Slash-command parsing for the composer
    markdown.ts   Markdown parser producing a typed tree (no HTML)
    i18n.ts       Message dictionaries
  sidepanel/      React UI: Chat, Skills, Settings
```

Two design notes worth knowing before changing things:

**Markdown is parsed to a tree, never to HTML.** Assistant text is untrusted —
the model may have just read an attacker-controlled page — and this panel is
privileged, since script here could reach `chrome.storage` where the keys live.
So no HTML string is ever built and `dangerouslySetInnerHTML` appears nowhere,
which makes injection structurally impossible rather than dependent on sanitizing
correctly. Link targets are checked against a scheme **allowlist**.

**Everything durable is in `chrome.storage`.** An MV3 service worker is evicted
after ~30 seconds idle, taking every module-level variable with it. A turn also
holds a reference-counted keepalive, because closing the panel destroys the port
that was keeping the worker awake — and closing the panel mid-answer is
supported.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "No model provider configured" | Settings → Add a provider. |
| 401 / 403 | Wrong or expired key, or a key belonging to a different vendor than the base URL. |
| 404 when sending | Base URL missing its version segment (`/v1`, `/api/v3`), or an unknown model name. Press **Test connection** to localize it. |
| "Cannot read this page" | A `chrome://`, `file://`, Web Store, or extension page. No permission can fix this. |
| Page text looks empty or partial | Content is in an iframe, rendered after the read, or behind a "Load more". Reload and retry; select the part you care about. |
| Assistant chats but never reads the page | The model does not support function calling. Attach the page manually, or switch model. |
| A long page seems truncated | It is: ~12,000 characters. Select the relevant section first. |
| Nothing happens on the toolbar click | Reload the extension in `chrome://extensions`; the worker may have failed to start. |
| A local model refuses the request | Confirm the server is running and its base URL ends in `/v1`. |

---

## Limitations

- Read-only: no clicking, typing, navigation, or form submission.
- One tab at a time, top frame only.
- Page text is capped at ~12,000 characters; truncation is reported to the model
  so it can say so rather than inventing the rest.
- Tool calls stop after 5 rounds per turn, to bound a confused model.
- Autonomous page reads need a function-calling model.
- The endpoint must accept requests from a browser extension. Public APIs do; a
  strict internal gateway may not.
- Transcripts clear when the browser closes, by design.

---

## License

[MIT](LICENSE)

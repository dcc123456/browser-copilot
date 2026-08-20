# Browser Copilot

A Chrome extension (Manifest V3) that puts an LLM assistant in the browser side
panel and lets it read the page you are looking at.

1. **A side-panel chat** — backed by **any OpenAI-compatible endpoint**
   (DeepSeek, 火山方舟 Volcengine Ark, OpenAI, OpenRouter, a local Ollama).
2. **Page reading** — pull the current tab's title, URL, selection, and body
   text into the conversation, either by attaching it yourself or by letting the
   agent ask.
3. **Skills** — reusable instruction packs, applied explicitly with `/` or
   matched automatically by description.

The UI is available in **English or 简体中文**.

---

## What this extension does and does not do

It is an **observer**, not an operator. It can read the page you are on; it
cannot click, type, navigate, or submit anything. That boundary is the design,
not a missing feature: an assistant that reads and advises fails safely, while
one that acts can fail destructively on a page you were not watching.

It also does **nothing on a timer**. There is no `alarms` permission and no
background schedule — every action is a direct response to something you just
did in the panel. If the panel is closed and you are not asking it anything, the
extension is doing nothing at all.

---

## Reading a page: how it actually works

Page text is obtained by injecting a one-off, read-only script into the tab with
`chrome.scripting.executeScript`, in the default **isolated world**. The script
clones the body, strips `script`/`style`/`svg`/`iframe` and similar noise,
and returns `innerText`; whitespace collapsing and truncation happen back in the
service worker where they are unit-testable
([`src/background/page.ts`](src/background/page.ts),
[`src/lib/extract.ts`](src/lib/extract.ts)).

Two consequences follow, and both are visible in the UI rather than hidden:

| Constraint | Why |
| --- | --- |
| Only **ordinary http(s) pages** | No extension may inject into `chrome://`, `about:`, `file://`, the Web Store, or another extension's pages. No permission changes this. |
| Only the **top frame** | Subframe text is mostly ads and chrome; merging frames yields context you cannot locate on the page in front of you. |

The rule is a single predicate in [`src/lib/pages.ts`](src/lib/pages.ts), so
every part of the extension agrees on what is readable. **Settings → Page access
→ Check active tab** reports the answer for the current tab before you rely on
it.

### Two paths, one of them gated

- **You attach the page.** Tick *Attach current page* in the composer and the
  page is scraped and prefixed to your message. No prompt: you already said
  which page, and when.
- **The agent asks for it.** A model-initiated `read_current_page` call requires
  explicit approval, showing the arguments first.

The asymmetry is deliberate. The active tab might be webmail, an internal
dashboard, or a bank statement, and reading it ships that text to a third-party
model endpoint. A deliberate attach is consent; a model deciding on its own is
not.

---

## Install

Requires Node.js 20+ and Chrome 116+ (the side panel needs 114+).

```bash
pnpm install
pnpm run build
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the generated `dist/` folder.
4. Click the extension icon to open the side panel.

For iterative work, `pnpm run dev` rebuilds on change; the extension still has
to be reloaded from `chrome://extensions` after changes to the service worker.

---

## Setup

Open **Settings → Add a provider**, pick a preset, paste your key, and press
**Test connection**. You can configure several providers and switch with **Use
this** — a coding-plan endpoint, a cheap fallback, a local model — without
retyping credentials.

Presets exist only to prefill base URLs; every field stays editable.

| Preset | Base URL | Model examples |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` |
| 火山方舟 Ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-code`, or an endpoint ID `ep-…` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| Ollama (local) | `http://localhost:11434/v1` | whatever you have pulled |

**Base URL** is everything up to but *not* including `/chat/completions`; a
pasted full endpoint is trimmed automatically. **Fetch models** queries
`/models` when the gateway offers it — not all do, and you can always type the
model name.

There is no vendor-specific code anywhere in the client. Every one of these
speaks the same contract — `POST {baseUrl}/chat/completions`, `Bearer` auth, SSE
frames of `chat.completion.chunk`, `tools` function calling, `[DONE]` to
terminate — so a provider is configuration, not a code path
([`src/lib/llm.ts`](src/lib/llm.ts)).

### Where your key lives

In `chrome.storage.local`, on this machine only. It is **not** encrypted and
**not** synced: anyone who can read your browser profile can read it. That is a
deliberate trade — `storage.sync` would copy keys to every signed-in browser.

---

## Using it

### Chat

Type and press **Enter** (Shift+Enter for a newline). Tick **Attach current
page** to include the page you are on.

The panel can be closed mid-answer. The turn keeps running in the service
worker, and reopening the panel restores the transcript and rejoins a run still
in progress.

Assistant replies are rendered as Markdown — headings, **bold**, lists, tables,
blockquotes, links, and fenced code blocks with a copy button. Code blocks
scroll horizontally rather than wrapping, because a broken command line reads as
two commands.

What *you* type is shown exactly as typed. Asking about `**` or pasting a code
fence must not make your own question change shape.

### Skills

A skill is a saved instruction pack: the stable part of a prompt ("summarise as
five bullets", "extract these fields as JSON") without the part that changes.

- **Skills → New skill** to create one.
- In Chat, type `/` to pick one for the conversation, or **Use in chat** from
  the Skills tab.
- Leave *Let the agent apply this automatically* on and the agent may select the
  skill itself when your message matches its description.

Only names and descriptions are offered to the model up front; the full
instructions are loaded on demand via a `use_skill` call, so ten skills do not
cost ten instruction bodies per request
([`src/lib/skills.ts`](src/lib/skills.ts)).

### Language

**Settings → Language**, or *Automatic* to follow the browser.

`chrome.i18n` is deliberately unused: it resolves from the browser's UI language
with no runtime override, and people routinely run an English Chrome while
wanting a Chinese panel. The dictionary lives in
[`src/lib/i18n.ts`](src/lib/i18n.ts) as a closed type, so a key added to one
locale and forgotten in the other fails `tsc` instead of rendering a blank
label.

---

## Tools the agent can call

| Tool | Confirmation | What it does |
| --- | --- | --- |
| `read_current_page` | **required** | Title, URL, selection, and visible text of the active tab. |
| `use_skill` | no | Loads a saved skill's instructions by name. Read-only, and the text is your own. |

---

## Architecture

```
src/
  background/
    index.ts      Service worker: command channel + streaming agent port
    agent.ts      Tool schemas, tool-call loop, confirmation gating
    page.ts       Reads the active tab via one-off script injection
    keepalive.ts  Reference-counted worker keepalive for in-flight turns
  lib/
    llm.ts        OpenAI-compatible streaming client + SSE accumulator
    providers.ts  Provider profiles, presets, validation
    storage.ts    chrome.storage access, settings, skills, transcripts
    messages.ts   Panel ↔ worker wire protocol
    pages.ts      Which URLs may be read at all
    extract.ts    Whitespace collapsing and budget truncation
    skills.ts     Skill validation and prompt composition
    slash.ts      Slash-command parsing for the composer
    markdown.ts   Markdown parser producing a typed tree (no HTML)
    i18n.ts       Message dictionaries
  sidepanel/      React UI: Chat, Skills, Settings
    Markdown.tsx  Renders the Markdown tree as React elements
```

### Choices worth knowing about

**Markdown is parsed to a tree, never to HTML.** Assistant text is untrusted —
the model may have just read an attacker-controlled page — and this panel is
privileged, since script running here can reach `chrome.storage` where the API
keys live. So `src/lib/markdown.ts` emits a typed tree and `Markdown.tsx` turns
it into React elements. There is no HTML string and no
`dangerouslySetInnerHTML` anywhere, which makes injection structurally
impossible rather than dependent on sanitizing correctly. Raw HTML in a reply
renders as literal characters, and link targets are checked against a scheme
**allowlist** (`https`, `http`, `mailto`, `tel`) — a `javascript:` denylist
loses to `JaVaScRiPt:` and `java&#9;script:`, while an allowlist fails closed.
The parser is hand-written for the same reason: a Markdown library would add
dozens of transitive dependencies to a security-sensitive surface, for
constructs this panel should refuse anyway.

**Everything durable is in `chrome.storage`.** An MV3 service worker is evicted
after roughly 30 seconds of inactivity, taking every module-level variable with
it. Settings and skills go to `storage.local`; conversation transcripts go to
`storage.session`, which is memory-backed and cleared when the browser closes —
the right lifetime for a chat, and it keeps scraped page text off disk.


**Streaming runs in the worker, not the panel.** Extension pages have no page
origin to satisfy CORS from, and a panel can be closed mid-turn. The panel holds
a long-lived port for tokens; an open port also keeps the worker alive, which
`sendMessage` would not.

**The port heartbeat is not enough on its own.** Closing the panel destroys the
port, removing exactly the protection that kept the worker awake — and closing
the panel while work continues is a supported action. So a turn also takes a
reference-counted keepalive, released in a `finally`
([`src/background/keepalive.ts`](src/background/keepalive.ts)).

**A dropped port does not abort a turn.** The panel disconnects both when the
user closes it and when the worker is recycled; in both cases the right
behaviour is to finish and persist, so the answer is waiting in the transcript.
Pending confirmations are the exception — nobody can answer them once the panel
is gone, so they resolve as declined.

---

## Development

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest
pnpm run build       # production bundle into dist/
pnpm run icons       # regenerate public/icons from scripts/generate-icons.mjs
```

Tests cover the logic that is worth testing without a browser: SSE frame
accumulation (split reads, CRLF, multi-fragment tool arguments), transcript
trimming, provider and settings normalization, the injectable-page predicate,
skill validation and prompt composition, slash-command parsing, text extraction,
keepalive reference counting, and dictionary parity between locales.

Markdown is covered twice over. `tests/markdown.spec.ts` asserts on the parsed
tree; `tests/markdown-render.spec.tsx` renders components through
`react-dom/server` and asserts on the HTML that actually reaches the DOM —
because a correct tree rendered carelessly could still inject markup, so the
guarantee is checked where it is finally observable. Both suites feed every
prefix of a rich document through the parser, since the renderer runs on each
streamed token and a prefix that throws would blank the panel mid-answer.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "No model provider configured" | Settings → Add a provider. |
| 401 / 403 | Wrong or expired key, or the key belongs to a different vendor than the base URL. |
| 404 on send | Base URL missing its version segment (`/v1`, `/api/v3`), or an unknown model name. |
| "Cannot read this page" | A `chrome://`, `file://`, Web Store, or extension page. No permission can fix this. |
| Page text is empty | The tab renders its content in a subframe, or after the read. Reload and try again. |
| The agent chats but never reads the page | The model does not support function calling. |
| Nothing happens on the toolbar click | Reload the extension in `chrome://extensions`; the service worker may have failed to start. |

---

## Known limitations

- Read-only: no clicking, typing, navigation, or form submission.
- Only the top frame of ordinary http(s) tabs can be read.
- Page text is truncated to a character budget, so very long pages arrive
  partially; the truncation is reported in the context handed to the model.
- The agent needs a model that supports **function calling**. Models without it
  will chat but never read a page on their own — attaching it manually still
  works.
- Providers must accept requests from a browser extension. Public APIs do; an
  internal gateway with strict origin checks may not.
- Transcripts are cleared when the browser closes, by design.

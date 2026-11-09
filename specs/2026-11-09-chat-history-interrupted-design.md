# Interrupted chat turns must stay openable in history

Date: 2026-11-09
Area: sidepanel history / background chat turn / storage

## Problem

Start a chat turn, let it run halfway, and kill the extension (crash, OOM
kill, extension reload). The conversation is listed in chat history, but
opening it shows nothing from the interrupted turn — and a conversation whose
_first_ turn was interrupted opens completely empty, which the user reads as
"the conversation cannot be opened".

## Root cause

A panel chat turn mutates an in-memory `WireMessage[]` (`history` in
`src/background/index.ts`) and writes it to durable storage exactly once, in
the turn's `finally`:

```ts
try { ... runAgentTurn(history, ...) } finally { await saveConversation(...) }
```

That is correct for ordinary failures (the catch/finally always runs) but
useless for the ways this extension actually dies: the service worker is
killed by the OS, the renderer OOMs, or the extension is reloaded. None of
those run `finally`, so:

- `conv:<id>` keeps the last **completed** turn; the crash turn's user
  message, partial answer and tool rounds are only in memory and vanish;
- for a conversation created by that turn, `touchConversation` already wrote
  its metadata (it runs before `runAgentTurn`), so the history list shows an
  entry whose transcript file does not exist → the detail view is empty;
- `chrome.storage.session` keeps `turn:<id> = { running: true }` from turn
  start. Nothing ever retires it, so every later open claims a turn that no
  worker owns.

## Chosen fix

1. **Throttled progress checkpoint** (`src/lib/progress-checkpoint.ts`).
   While a turn runs, offer the live transcript to a throttled writer
   (5 s minimum between writes, pending snapshot superseded). The first
   snapshot is scheduled right after the user turn and its metadata are
   added, so the message the user typed is durable even if the model never
   answers. Writes are serialized and the turn's `finally` calls `flush()`
   before its own authoritative save, so a late checkpoint can never land
   after (and regress) the final transcript. Checkpoint failures are
   swallowed — the final save still reports a real storage problem.
2. **Retire a stale running mark** in the port's `resume` handler: if
   `turn:<id>.running` is true but no live turn channel exists, no turn can
   actually be running (a live channel is the registry of running turns), so
   the state is rewritten with `running: false`.
3. **Tell the panel** the turn was interrupted (`restore.interrupted`), and
   render a bilingual status line in the chat log. Without it the recovered
   transcript just stops mid-thought with no explanation.

## Rejected alternatives

- **Save on every streamed delta.** The transcript is up to 1.5 MB and is
  rewritten whole per save; a delta-frequency write is a disk/CPU storm and
  re-creates the memory-pressure problem fixed in
  `specs/2026-11-09-workflow-memory-pressure-design.md`.
- **Rely on `chrome.runtime.onSuspend`.** It is best-effort and only fires
  for an orderly worker shutdown — not for an OOM kill or renderer crash,
  which are the failures observed here.
- **Mirror the in-flight transcript in `chrome.storage.session`.** It is
  cleared when the browser exits (the common "abnormal exit"), and it would
  be a second transcript store with its own quota and merge rules.
- **Only checkpoint at tool boundaries.** A long answer streamed without
  tool calls would not be persisted at all until the turn ends.
- **Change `saveConversation` to append incrementally.** It owns trimming,
  payload shedding and the byte budget over one key; appending would need a
  second write path that has to re-implement all three.

## Tests

- `tests/progress-checkpoint.spec.ts`: one write per window for a burst of
  schedules, latest snapshot wins, writes serialize, `flush` cancels a
  pending timer and waits for the in-flight write, empty snapshots never
  write, a failed checkpoint does not poison later ones.
- `tests/chat-interrupted-turn.spec.tsx`: a `restore` with `interrupted:
true` renders the recovered transcript plus the bilingual interrupted
  status; `interrupted: false` adds nothing.

## Boundaries

- Only the panel chat turn gets checkpoints. Unattended workflow/task runs
  already persist checkpoints through their own engine store.
- The interrupted mark is cleared on the next resume; a conversation that is
  continued normally never sees the status line.
- This does not attempt to _resume_ the dead turn's work — it makes the
  conversation readable and continuable, which is the reported failure.

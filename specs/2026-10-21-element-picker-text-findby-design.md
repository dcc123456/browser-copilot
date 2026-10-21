# Element picker: Text as a find-by dialect

Date: 2026-10-21
Area: `inpage/element-picker`, `workflow-editor/blocks/shared`, `background/picker-bridge`

## Problem

The click-element form already offers `Text` in its find-by dropdown, and the
engine already resolves it: `targetFrom()` turns `findBy: 'text'` into the
kernel's `text` strategy, which picks the tightest element whose visible text
equals the value (falling back to "includes" only when nothing equals it). But
the picker only understood CSS and XPath:

- pressing the pick button in Text mode opened a picker that built a CSS
  selector, so the field (which the engine reads as literal text) ended up
  holding a selector;
- the pick/verify actions were hidden entirely in Text mode, leaving the
  operator to type the text by hand.

## Decision

Add `text` as a third dialect end to end:

1. The picker card's find-by select gains `Text` / `文本`. In this mode the
   selector field holds the aimed element's **visible text**, and the match
   count is computed with the same strategy the click will replay.
2. The picker's text matcher mirrors the kernel's rules verbatim: whitespace is
   collapsed with `[\s\u00a0]+`, `innerText` is preferred over a
   script/style-free `textContent` clone, only the tightest holder of the text
   counts (an element with a deeper element that also holds it is excluded),
   and the "includes" pass runs only when the exact pass found nothing. The
   count the operator sees is therefore the count the kernel resolves.
3. No pinning / match stepper in text mode: text has no positional form. When
   several elements share the text, the count line says so
   (`Matches N elements`) and the operator can add context by hovering a more
   specific element.
4. `picker:result` carries `findBy: 'text'`. The editor's pick action writes
   both the value and the dialect back to the block, so the field and
   `data.findBy` cannot disagree even if the operator switched dialect inside
   the picker card.
5. Verify works in text mode too: `picker:verify` accepts the text and outlines
   its matches with the same matcher.
6. The operator chat dock's hand-picked element prompt labels text picks
   (`Text: ...`) and tells the model to set `findBy` to `text`.

## Scope note

The upload-file form still ignores `findBy` at execution time (it reads only
`selector` as CSS), so its dropdown keeps coercing to CSS/XPath; exposing Text
there is a separate change to that executor, not a picker gap.

## Rejected alternatives

- **Convert the existing CSS selector to text when the dropdown changes.**
  Requires re-injecting into the page from the editor to read the element's
  text, and would silently replace a working locator. Picking with Text mode
  selected is the direct path.
- **Keep the action buttons hidden and require typing.** The point of the
  request is that picking fills the text; typing stays as an override.
- **Pin repeated text to an Nth match.** The kernel's text strategy has no
  positional spec; claiming one would send parameters the replay ignores.

## UX copy (en + zh-CN)

Picker `STRINGS` table: `Text` / `文本` (select option), `(no visible text)` /
`（无可读文本）` (field placeholder when the aimed element renders none).

## Tests

`tests/element-picker.spec.ts`: text mode fills the field with the aimed
element's text, counts repeated text, commits `findBy: 'text'`; switching the
card dialect from CSS to Text rewrites the field; verify in text mode outlines
and counts through the tightest-holder rule (container excluded).

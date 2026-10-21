# Element picker: outline the matches while verifying

Date: 2026-10-21
Area: `inpage/element-picker`

## Problem

The editor's "Verify selector" action injects the picker in `verify` mode, which
counts the matches, replies immediately and removes itself. The operator gets
`Verified: N element(s) match` in the editor but never sees _which_ elements
matched — and the reply itself is what raises the editor window over the page
(`focusEditorWindow` in `blocks/shared/element-pick.ts`), so an instantaneous
answer hides the page even before a highlight could be noticed.

## Decision

`verify` mode outlines every match on the page and holds that view for a fixed
beat before answering:

1. Count through the existing `matchesOf` root walk, so CSS and XPath agree.
2. Draw a fixed-position emerald outline over each match (capped at 50 boxes —
   the count in the reply is always the full count). Emerald distinguishes the
   verified set from the select-mode indigo target highlight.
3. Show a page toast with the count (`N elements match` / `匹配到 N 个元素`) and
   the Escape hint; a miss shows the red `Element not found` toast instead.
4. Answer `picker:result` after ~3 s, or immediately when the operator presses
   Escape. The reply keeps the existing shape (`count`, `verified: true`), so
   the editor side needs no protocol change.
5. The hold stays far below the editor's 15 s verify timeout; it is a fixed
   local constant because the injected function must be self-contained.

## Rejected alternatives

- **Reply immediately and keep the overlay until dismissed.** The reply raises
  the editor window, hiding the very page the overlay lives on; a second
  dismiss protocol would also have to fit inside the editor timeout.
- **Scroll the first match into view.** Verify would then mutate the page
  (scroll position); outlining is enough for the operator to locate the match.
- **Reuse the select-mode highlight.** There is exactly one highlight box and
  it tracks the aimed element; verify needs one box per match.

## UX copy (en + zh-CN)

Registered in the picker's in-page `STRINGS` table:

- `{N} elements match` / `匹配到 {N} 个元素`
- `Element not found` / `未找到匹配元素`
- `Press Esc to close` / `按 Esc 关闭`

## Tests

`tests/element-picker.spec.ts` (fake timers): verify outlines all three repeated
buttons and stays silent during the hold, then replies with `count: 3` and
removes itself; Escape answers early; a miss draws no boxes, shows the error
toast and replies `count: 0`; XPath is counted through the same path.

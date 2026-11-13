# Multi-element picker plan

## Goal

In the existing select-only element picker, let Ctrl+click (Cmd+click on macOS) add or remove several distinct elements. `read_selected_element` must return the whole ordered selection to built-in and external local agents.

## Current path and constraints

The injected picker reports `picker:selection`; the worker stores one `PickedElement` per tab in `chrome.storage.session`; both agent hosts read it through the same `read_selected_element` tool. The workflow picker's existing `multiple` option means one broad selector matching many nodes and is unrelated.

No new browser capability or dependency is needed. The picker remains self-contained for `chrome.scripting.executeScript({func})`; selection records remain bounded at the worker trust boundary.

## Design

- Select-only mode keeps an ordered element array and one soft highlight per element.
- Ordinary first click replaces the selection with one element. Ctrl/Cmd+click toggles the pressed element and reports the complete array after every change. A later ordinary click or Escape dismisses without changing the last reported selection.
- Copy-and-close mode and workflow picker behavior stay unchanged.
- A batch message carries `selections`; the worker also accepts the existing single `selection` message. Each tab stores at most 10 elements, matching the picker limit, and existing per-field caps remain enforced.
- The tool returns `elements` and aligned `targets`, plus the first element's existing fields and `target` for compatibility. `stale` is true when the current tab URL differs from any selected element's URL.
- Settings copy explains the shortcut in English and Chinese.

## Verification

1. Unit-test Ctrl and Meta toggling, full-batch messages, multiple highlights, page-event suppression, store replacement/migration/caps, and multi-element tool results.
2. Run `pnpm verify:injected`, typecheck, tests, lint/format checks on changed files, and `pnpm build`.
3. Load the built extension in real Chrome, select multiple elements with Ctrl+click, and call `read_selected_element` through the local MCP bridge. Record the observed result or mark browser evidence BLOCKED.
4. Commit only this feature and push to `main` after all available gates pass.

## Browser evidence

Chrome for Testing loaded the final `dist` build and drove the actual launcher. Three Ctrl+click selections produced three highlights and stored `#buy`, `#cart`, `#sell` in order; Ctrl+clicking `#cart` again left `#buy`, `#sell`, and Escape preserved that pair. The first run exposed macOS Ctrl+click's native `contextmenu` path, which is now handled and covered by both the unit test and the successful real-Chrome rerun. Evidence: `tmp/multi-element-picker-report.json` and `tmp/multi-element-picker.png` (not committed).

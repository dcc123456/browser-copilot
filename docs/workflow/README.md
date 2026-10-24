# Workflow documentation

Browser Copilot workflows turn repeated browser work into a graph you can run, debug, and reuse. You wire operators together on a canvas; each operator performs one step, and variables carry data from one step to the next.

This reference covers every operator that appears in the workflow palette, plus the behavior that is specific to Browser Copilot: variable interpolation, the data table, loops, error handling, downloads, secrets, and the AI features built into the editor.

New here? Read [Getting started](getting-started.md) for a tour of the editor and a complete first workflow, then keep [Workflow concepts](concepts.md) open while you build.

## What this reference covers

The palette contains **63 operators**:

| Category page                               | Operators | Includes                                         |
| ------------------------------------------- | --------- | ------------------------------------------------ |
| [Web interaction](operators-interaction.md) | 14        | Clicking, reading, filling, scrolling, scripts   |
| [Browser](operators-browser.md)             | 18        | Tabs, history, screenshots, downloads, OCR       |
| [General](operators-general.md)             | 13        | Triggers, sub-workflows, HTTP, notes, AI agent   |
| [Data](operators-data.md)                   | 11        | Variables, regex, sorting, secrets, spreadsheets |
| [Control flow](operators-conditions.md)     | 7         | Branches, element checks, loops, breakpoints     |

The 63 are 58 operators shared with the Automa catalog plus 5 Browser Copilot-only operators: `ai-agent`, `ocr`, `set-variable`, `get-secret`, and `parse-excel`.

Two other pages explain the platform rather than individual operators: [Getting started](getting-started.md) and [Workflow concepts](concepts.md).

## Where the field reference comes from

The block inspector in the editor is the authoritative reference for a node's settings. Each operator page below describes the same fields in the same order, with the defaults this release ships, plus the runtime behavior that is not visible in the form.

- English operator names and headings match the palette.
- Setting names match the English inspector labels. When a field is stored under a different key, the page mentions the key only where a workflow JSON is involved.
- The workflow-level settings shared by every node — disable, timeout, error handling, goal contract, breakpoints — are explained once in [Workflow concepts](concepts.md#errors-retries-and-reliability) instead of being repeated on every page.

If an operator page and the inspector disagree, trust the inspector and please report the difference.

## Status legend

Most operators work in a normal run and carry no badge. Five are exceptions:

| Badge              | Meaning                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Unavailable in MV3 | The operator needs an API that Manifest V3 extensions cannot use. It stays on the canvas for imported workflows but cannot run. |
| Not implemented    | The operator exists in the catalog but this build has no executor for it.                                                       |
| Placeholder        | The operator can be placed and connected, but performs no work in this build.                                                   |
| Full build only    | The operator works only in the full build. The lite `no-ocr` build strips its engine.                                           |

The five affected operators are `proxy`, `save-assets`, `browser-event`, `switch-to`, and `ocr`.

## Operator index

<!-- operator-index -->

## Cloud operators that are not available

The catalog also knows five cloud operators. They are hidden from the palette and have no local executor, so they are intentionally not documented as usable operators:

- `ai-workflow` — runs a workflow in Automa's hosted cloud.
- `google-sheets` — appends rows to a Google Sheet through an OAuth connection.
- `google-sheets-drive` — reads a spreadsheet from Google Drive.
- `google-drive` — uploads a file to Google Drive.
- `block-package` — installs a community block package.

A workflow imported with one of these nodes keeps the node on the canvas for reference but cannot run it.

## Upstream attribution

Browser Copilot keeps workflow JSON compatible with Automa, so operator names, field names, and much of the general behavior come from the Automa project. Every shared operator links to its Automa reference page under **Resources**.

The prose on these pages is written for Browser Copilot and verified against this repository; it is not copied from the Automa documentation. Where Browser Copilot behaves differently, the operator page says so under **Browser Copilot notes**.

Four catalog operators have no upstream documentation page and are marked accordingly: `note`, `forward-page`, `save-local`, and `read-page`. The five Browser Copilot-only operators are labelled as such and never claim an upstream page.

## Version note

These pages describe Browser Copilot 0.6.8. New operators and fields are added with the feature; when a saved workflow was created by an older version, the inspector shows the fields that version understood, and the runtime keeps the legacy shape working.

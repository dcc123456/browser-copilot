# Workflow concepts

These are the ideas that apply across operators. Read them once and the individual operator pages will make more sense.

## Workflow anatomy

A workflow is a directed graph:

- **Trigger** — the entry point. It holds the workflow name, one or more launch configurations, declared inputs, and run settings.
- **Steps** — operators placed on the canvas. Each step reads variables and page state, performs one action, and usually writes a result.
- **Edges** — connections that tell the engine which step runs next. Named ports express branches, fallbacks, and loop returns.

A run starts at the trigger, follows edges, and stops when no outgoing connection applies or a step ends the graph. Every run owns a fresh **variable bag**. Declared inputs are seeded first, then each step adds or replaces variables as it executes. Later steps see everything earlier steps produced.

The inspector has two scopes:

- Select the **Trigger** block to edit workflow name, description, triggers, and run settings such as log saving and notifications.
- Select any other block to edit that operator's settings, output variable, error policy, and goal contract.

## Variables and interpolation

Variables are the only channel between steps.

- A step that produces a result has an **output variable** field. Name it for the data it holds.
- Any text field that supports templates can read a variable with `{{name}}`.
- A step can overwrite a variable; downstream steps see the newest value.

### Reference syntax

| Form               | Reads                                                          |
| ------------------ | -------------------------------------------------------------- |
| `{{headline}}`     | A top-level variable.                                          |
| `{{user.email}}`   | A property of an object.                                       |
| `{{rows[0].name}}` | An array index, then a property.                               |
| `{{map["key"]}}`   | A property whose name contains characters like dots or spaces. |
| `{{rows[0]}}`      | The whole object at that position.                             |

References are whitespace-tolerant. A malformed expression is left untouched, exactly like a reference to a variable that does not exist.

### Objects stored as text

Model output and some page reads arrive as strings. When a reference uses a property or index on such a string — `{{article.title}}` where `article` holds `{"title": "…"}` — the engine parses the string as JSON first, including a surrounding ` ```json ` fence. That means a single AI answer can be read as a whole (`{{article}}`) or field by field (`{{article.title}}`) without changing how it was stored.

### Where interpolation runs

Every string in a block's parameter bag is interpolated, including nested objects and arrays: a condition's comparison value, a nested element target, a selector built from a loop variable, a file name. The `code` parameter of **JavaScript code** is additionally escaped for the JavaScript string literal it lands in, so a value containing quotes or newlines cannot break the script.

Non-text settings are not interpolated: dropdown choices, checkboxes, numeric bounds, and output variable names themselves. Point those at data through the operator's own fields.

### Missing and empty values

- If a token resolves to nothing, it is **left in the text** rather than replaced with an empty string.
- The engine records the surviving tokens for the run. Page-action steps that must not type literal `{{name}}` into a page fail the step with an unresolved-input error instead.
- If a token resolves to an empty string, the step still sees an empty value. Blocks that would otherwise clear a form field or overwrite data with nothing treat that case specially and refuse or report it.

This distinction is deliberate: `{{missing}}` is a broken workflow, while `{{optionalNote}}` resolving to `""` is a valid empty value.

### Runtime variables

Some variables are supplied by the engine instead of by a block:

| Variable              | Available in              | Value                                                |
| --------------------- | ------------------------- | ---------------------------------------------------- |
| `loopIndex`           | Loop bodies               | Zero-based iteration number.                         |
| `loopItem`            | Data loops                | The current array item.                              |
| `loopElementSelector` | Element loops             | A selector that targets the current matched element. |
| `dataTable`           | Whole run                 | The run's array of row objects.                      |
| `lastExport`          | After **Export data**     | The text that was exported.                          |
| `lastExportPath`      | After a successful export | The file name that was written.                      |

Operator pages list any additional output or fallback variable names.

## The data table

`dataTable` is a run-scoped array of row objects — the workflow's spreadsheet. It is the only thing **Export data** reads when exporting **Table**.

- Reading operators such as [Get text](operators-interaction.md#operator-get-text) and [Read page](operators-browser.md#operator-read-page) can save what they read into the table. Enable **Save to data table**, set a **data column**, and every match becomes a cell in that column.
- Inside a loop, one iteration writes the row at `loopIndex`. Outside a loop, multiple matches create one row per match.
- Writing the same column again replaces the cell, so two reads can build a two-column table instead of doubling the rows.
- Data operators such as [Insert data](operators-data.md#operator-insert-data), [Delete data](operators-data.md#operator-delete-data), and [Sort data](operators-data.md#operator-sort-data) edit the same table.
- The table accepts up to 100,000 rows; further writes are ignored and reported.

An empty table cannot be exported: **Export data** fails with an explanation instead of writing an empty file. If you only need one value, export **Variable** instead.

## Ports, branches, and loops

Most operators have one output and continue to the next connected step. Extra ports let a single node choose between paths:

- **[Conditions](operators-conditions.md#operator-conditions)** — ordered paths, each with its own output. The run follows the first path whose conditions all match. The **fallback** output is always present and is used when nothing matches.
- **[Element exists](operators-conditions.md#operator-element-exists)** — one output when the element exists, another when it does not.
- **Error fallback** — when a step's **On error** policy is “execute the fallback branch”, the extra fallback handle is used for the failure path.
- **Loops** — the loop body leaves the loop node, returns to it through the loop-back handle, and repeats.

Loops expose the runtime variables listed above:

- **[Repeat task](operators-conditions.md#operator-repeat-task)** repeats a body a fixed number of times.
- **[While loop](operators-conditions.md#operator-while-loop)** repeats while its condition holds, up to 1,000 iterations.
- **[Loop data](operators-conditions.md#operator-loop-data)** iterates a JSON array (`loopItem`, `loopIndex`).
- **[Loop elements](operators-conditions.md#operator-loop-elements)** iterates page elements (`loopElementSelector`, `loopIndex`).
- **[Loop breakpoint](operators-conditions.md#operator-loop-breakpoint)** stops the current loop and continues after it.

A branch drawn back to an earlier block repeats that block. The editor warns when a connection creates this loop-back shape; make sure the condition eventually changes, or the run stops at the iteration limit.

## Errors, retries, and reliability

A step that throws normally fails the run. The inspector gives each block these controls:

| Setting                 | Effect                                                                         |
| ----------------------- | ------------------------------------------------------------------------------ |
| **Disable block**       | The step is skipped, including its side effects, without deleting it.          |
| **Block timeout**       | Fails the step when it runs longer than the limit. `0` removes the limit.      |
| **On error → Retry**    | Retries the action the given number of times, waiting the configured interval. |
| **On error → Throw**    | Fails the run with the given message.                                          |
| **On error → Continue** | Marks the step as failed and continues to the next step.                       |
| **On error → Fallback** | Continues on the node's fallback connection.                                   |

Run-level behavior:

- Before starting, the engine checks required parameters. Missing values appear in the run log, and the run stops at the first block that cannot work instead of failing halfway through with no context.
- A failed run keeps its log. Select a log row to locate the block on the canvas.
- **Debug mode** pauses before blocks marked with a breakpoint, shows the variables captured at that point, and can resume, step, or stop.
- **Run workflow from here** starts a run at the selected node instead of the trigger, using the current page state.
- **Resume** on a failed workflow card re-runs from the step after the last clean checkpoint, so an already-completed login or submit is not repeated.
- **Save execution logs** keeps run transcripts in history; **Notify when finished** posts a notification when a run settles.

### Goals and verification

A workflow can carry a **workflow goal**: a summary plus success conditions checked after the last step. Generated workflows also give individual steps a goal contract — what the step should achieve and which observable facts prove it.

These contracts are used by:

- **Certification** — verification levels that check execution, per-step contracts, and the workflow goal. Editing a contract or the graph drops the workflow back to unverified until it is checked again.
- **AI repair** — when a run fails, the repair agent works from the goal contract and the failure, proposes node changes, and reports whether the workflow then succeeds without AI assistance.
- **AI takeover** — optionally completes a failed step on the live page once, then leaves its fixes as pending for your confirmation.

Goal contracts are optional for hand-built workflows. They are what make “success” a checkable fact rather than “the run did not throw”.

### AI seed recall

When generating a workflow, certified workflows that previously solved a similar goal can be offered to the generator as step evidence. Seeding only proposes steps; the generated graph still has to be saved and executed like any other workflow.

## Files, downloads, and uploads

### Where files go

The extension resolves a destination in this order:

1. **The configured download folder** — set it in Settings → Download folder. Files are written silently.
2. **A save dialog** — when no folder is configured and the side panel is open, you choose the location.
3. **The extension's internal folder** — for unattended runs with nobody to answer a dialog, files land in `browser-copilot-downloads/` inside the extension's storage, and the run log names the file.

Blocks that produce a file use this chain: **Export data**, **Take screenshot** when saving to a file, **Save local**, and others. **Handle download** waits for a browser download and can save it through the same path.

When a block accepts a file path, it is **relative** to the download folder, not an absolute host path. Subfolders are allowed (`reports/sales.xlsx`), and `{{variables}}` in the path are interpolated at run time.

### Upload sources

[Upload file](operators-interaction.md#operator-upload-file) supports four sources:

| Source                    | Use when                                                              |
| ------------------------- | --------------------------------------------------------------------- |
| User picks files          | Someone is present to choose files during the run.                    |
| File from an earlier step | A variable already holds a data URL, artifact, or array of artifacts. |
| Latest download file      | Upload the newest file matching a name pattern and type filter.       |
| Specific file path        | Upload one named file from the download folder.                       |

### Spreadsheets

[Parse Excel](operators-data.md#operator-parse-excel) reads `.xlsx` or `.csv` from a user-picked file, a variable held by an earlier step, or a relative path in the download folder. With a header row it produces objects keyed by column name plus the raw two-dimensional array.

## Secrets

[Get secret](operators-data.md#operator-get-secret) fetches stored credential fields into variables at run time. The values live in the extension's credential store (Data → Passwords & identities), never in the workflow JSON, and are resolved fresh on every run.

Use it for values that must stay secret: passwords, API keys, tokens. A username or a search keyword does not need this block — put it in the form value or a trigger input, where it stays visible and editable.

Credential fields are read by reference, so rotating a password in the Data tab takes effect on the next run without editing the workflow.

## AI features

Browser Copilot uses AI in several places. They are independent; none of them is required to run a workflow.

| Feature           | Where it appears                        | What it does                                                                                                        |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **AI agent**      | Operator in the General category        | Reads a page or element, follows your prompt, optionally acts on the page, and stores a text answer.                |
| **AI takeover**   | Settings, and a failed run when enabled | Lets an agent complete a failed step on the live page. Fixes are proposed for confirmation, never applied silently. |
| **AI repair**     | Run result and workflow toolbar         | Diagnoses a failure from the run log and the goal contract, edits the graph, and verifies the result.               |
| **Goal contract** | Trigger and per-block inspector         | Defines checkable success facts used by verification and repair.                                                    |
| **Seed recall**   | Workflow generation                     | Offers previously certified workflows as step evidence.                                                             |
| **OCR**           | OCR operator                            | Local text recognition with Tesseract.js; no network calls.                                                         |

AI features that call a model use the provider configured in Settings, and each has its own budget or round limit so a single step cannot loop forever. If a model call fails, the AI agent step reports the failure like any other step, and its **On error** policy decides what happens next.

## Triggers and scheduling

A workflow can have several triggers. The first is the **primary** trigger, mirrored onto the workflow record so lists and schedulers can show how the workflow starts. Disabling one trigger does not disable the others.

Trigger details:

- **Manual** workflows start from the editor, the Workflows tab, or a context-menu/shortcut trigger.
- **Time-based** triggers (interval, specific date, specific weekdays) are armed as browser alarms and fire while the browser is running.
- **Page-based** triggers (visit web, element change) are wired by the injected page observer and match on URL or selector.
- **Browser-based** triggers (on startup, keyboard shortcut, context menu) are registered by the extension itself.

**Scheduled tasks** are a separate surface: a task owns a schedule and can run a stored workflow with its own variable payload. Use a workflow trigger when the launch logic belongs to the workflow; use a scheduled task when several tasks share a schedule or when a task chains workflows.

## OCR build variants

Browser Copilot ships in two build variants:

- **Full build** — includes Tesseract.js and its language data. [OCR text recognition](operators-browser.md#operator-ocr) works offline.
- **Lite build** (`no-ocr`) — strips the OCR engine and language files. The OCR operator is shown as unavailable and refuses to run.

Everything else behaves the same in both builds. The OCR operator page carries the **Full build only** badge.

# General operators

This page covers the operators that start a workflow, connect runs, pause and export, and the utility blocks that sit around the main automation steps. Each section lists the settings the inspector exposes, the values the operator publishes, and the behavior that is specific to Browser Copilot. Shared inspector settings — **Description**, **Disable block**, **Block timeout**, and **On error** — are not repeated in every table; see [Workflow concepts](concepts.md) for variables, ports, errors, files, and trigger scheduling.

<!-- operator:trigger -->

## Trigger

The entry point of a workflow. It carries the workflow's name and run settings, one or more launch configurations, and the declared inputs that seed the run's variables. [Automa reference](https://www.goautoma.com/extension/docs/blocks/trigger.html)

### Settings

| Field                                      | Type         | Default       | Notes                                                                                                                                                                                                  |
| ------------------------------------------ | ------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trigger workflow                           | Select       | `manual`      | `manual`, `interval`, `date`, `specific-day`, `visit-web`, `keyboard-shortcut`, `context-menu`, `on-startup`, or `element-change`. Changing the kind starts that trigger from the new kind's defaults. |
| Interval (minutes)                         | Number       | `60`          | Interval triggers only; 1 to 360.                                                                                                                                                                      |
| Delay (minutes)                            | Number       | `5`           | Interval triggers only; 0 to 20.                                                                                                                                                                       |
| Date                                       | Date         | Empty         | Date triggers only.                                                                                                                                                                                    |
| Time                                       | Time         | `00:00`       | Date and weekday triggers.                                                                                                                                                                             |
| Select day                                 | Checkbox set | None          | Weekday triggers; Sunday is stored as `0`, Saturday as `6`.                                                                                                                                            |
| URL or Regex                               | Text         | Empty         | Visit-web triggers; a URL match pattern or a regular expression.                                                                                                                                       |
| Use regex                                  | Checkbox     | Off           | Treats **URL or Regex** as a regular expression instead of a match pattern.                                                                                                                            |
| Shortcut                                   | Text         | Empty         | Keyboard trigger; record the combination with the button next to the field.                                                                                                                            |
| Active while in input                      | Checkbox     | Off           | Let the shortcut fire while the focus is inside an input element.                                                                                                                                      |
| Workflow name in the context menu          | Text         | Empty         | Context-menu trigger; the label shown in the browser menu.                                                                                                                                             |
| Will appear in                             | Checkbox set | None          | Context-menu trigger; `audio`, `editable`, `image`, `link`, `page`, `password`, `selection`, and `video`.                                                                                              |
| Match pattern                              | Text         | Empty         | Element-change trigger; limits observation to matching pages.                                                                                                                                          |
| Element selector                           | Text         | Empty         | Element-change trigger; the element to observe, with pick and verify controls.                                                                                                                         |
| Target element options                     | Checkbox set | Child list on | MutationObserver flags: subtree, child list, attributes, character data, plus an attribute filter.                                                                                                     |
| Base element (optional)                    | Text         | Empty         | Element-change trigger; a change to this element restarts observation of the target.                                                                                                                   |
| Base element options                       | Checkbox set | Child list on | Same observer flags, applied to the base element.                                                                                                                                                      |
| Parameters                                 | List         | Empty         | Workflow-level inputs; each entry has a name, a required flag, and an optional default.                                                                                                                |
| Prefer asking parameters in the active tab | Checkbox     | Off           | Ask for the declared inputs in the active tab rather than the side panel.                                                                                                                              |

### Outputs

No variables. One output port; the run starts here and follows that connection.

### Browser Copilot notes

- A workflow can hold several triggers. The **Workflow triggers** dialog adds, selects, and removes them; the first one is primary and is mirrored onto the workflow record. The last remaining trigger cannot be removed.
- Trigger matching is performed by the extension, not by this block: interval, date, and weekday triggers are browser alarms, page triggers are injected observers, and startup, shortcut, and context-menu triggers are browser registrations. See [Workflow concepts](concepts.md).
- The trigger executor itself is a no-op. Its out-edge is what starts the graph.
- Element change observes the target with a MutationObserver. The optional base element controls when observation restarts, and the attribute filter accepts comma-separated names.
- Parameters declared here are the workflow's inputs. They seed the variable bag before the first step, and **Parameter prompt** resolves against the same declarations.

<!-- operator:execute-workflow -->

## Execute workflow

Runs another saved workflow as a nested run, then continues on the main output. [Automa reference](https://www.goautoma.com/extension/docs/blocks/execute-workflow.html)

### Settings

| Field                               | Type     | Default | Notes                                                                                                                          |
| ----------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Workflow to execute                 | Select   | Empty   | Saved workflows, loaded when the form opens; the workflow being edited is excluded. Use the reload button to refresh the list. |
| Execute Id (optional)               | Text     | Empty   | Stored with the node; the graph engine does not read it.                                                                       |
| Global data (JSON)                  | JSON     | Empty   | Edited in a popup. Stored with the node; not applied by the nested-run path.                                                   |
| Use all current workflow globalData | Checkbox | Off     | Stored with the node; not applied by the nested-run path.                                                                      |
| Use all current workflow variables  | Checkbox | Off     | Stored with the node; not applied by the nested-run path.                                                                      |
| Insert current workflow variables   | Text     | Empty   | Comma-separated names; shown when the previous option is off. Stored but not applied.                                          |

### Outputs

No output variable. One main output port. The child starts at its own trigger and, in this build, shares the parent's variable bag, so values written by child steps remain visible to later parent steps.

### Browser Copilot notes

- Only **Workflow to execute** changes execution. The global-data and variable-insert settings are persisted for round-tripping but are not read by the nested-run path; variables already flow because the two runs share the same bag.
- A stored workflow id that no longer resolves stays selectable instead of being silently rewritten, so opening and saving the form never drops the reference.
- A missing child and a self-referencing child are both reported in the run log, and the parent continues on its main output. A failing child does not fail the parent step by itself.
- Breakpoints inside the child pause the parent run, and loop progress and checkpoints are shared between parent and child.

<!-- operator:delay -->

## Delay

Pauses the run for a fixed time before the next step. [Automa reference](https://www.goautoma.com/extension/docs/blocks/delay.html)

### Settings

| Field                    | Type | Default | Notes                                                                                           |
| ------------------------ | ---- | ------- | ----------------------------------------------------------------------------------------------- |
| Delay time (millisecond) | Text | `500`   | Free text so it can hold a template. `{{variables}}` are interpolated before the value is read. |

### Outputs

No variables. One main output port.

### Browser Copilot notes

- A non-numeric or missing value falls back to 500 ms instead of failing the step.
- The wait is abortable: stopping the run interrupts the delay immediately.
- The legacy `ms` key is still read when `time` is absent, so older graphs keep working.

<!-- operator:export-data -->

## Export data

Writes the run's data table or one variable to a downloaded file. [Automa reference](https://www.goautoma.com/extension/docs/blocks/export-data.html)

### Settings

| Field          | Type     | Default        | Notes                                                                                                                                     |
| -------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Data to export | Select   | `data-columns` | `data-columns` exports the data table; `variable` exports one named variable.                                                             |
| Variable name  | Text     | Empty          | Shown for **Variable**; the variable must already hold a value.                                                                           |
| File name      | Text     | Empty          | Relative file name; `{{variables}}` are interpolated. When empty, the fallback name `export.json`, `export.csv`, or `export.txt` is used. |
| On conflict    | Select   | `uniquify`     | `uniquify`, `overwrite`, or `prompt`. Stored but not read by the executor.                                                                |
| Export as      | Select   | `json`         | `json`, `csv`, or `plain-text`.                                                                                                           |
| Add UTF-8 BOM  | Checkbox | On             | CSV only; makes Excel read non-ASCII cells correctly.                                                                                     |
| Delimiter      | Text     | `,`            | CSV and plain-text exports.                                                                                                               |

### Outputs

- `lastExport` — the exact text written, regardless of whether the file save succeeded.
- `lastExportPath` — the file name, set only after a successful save.
- One main output port.

### Browser Copilot notes

- **Table** reads `dataTable`; an empty table fails the step instead of writing an empty file, and the error names the usual causes: no read step, no column, or a read that matched nothing.
- **Variable** fails when the name is empty or the variable has no value. JSON export serializes the value; other formats convert it to text.
- The file is saved through the normal download destination chain described in [Workflow concepts](concepts.md). A canceled save dialog is not an error, but it does not set `lastExportPath`.
- **On conflict** is persisted but ignored by this build: the executor passes the chosen file name straight to the save path.
- For CSV and plain text, `addBOMHeader` is honored only for CSV; plain text uses the delimiter but no header row and no quoting.

<!-- operator:blocks-group -->

## Blocks group

Bundles a set of steps into one node so a long canvas stays readable. The group runs its children in their stored order and then leaves through its own output. [Automa reference](https://www.goautoma.com/extension/docs/blocks/blocks-group.html)

### Settings

| Field      | Type | Default | Notes                                                                                                 |
| ---------- | ---- | ------- | ----------------------------------------------------------------------------------------------------- |
| Group name | Text | Empty   | Inline name on the group node; `Group` is shown when empty.                                           |
| Steps      | List | Empty   | Child blocks stored under `data.blocks`; children can be reordered, edited, or removed from the node. |

### Outputs

No variables. One main output port. An empty group is a pass-through.

### Browser Copilot notes

- This block has no separate inspector. Its name and children are edited directly on the canvas node.
- Children are not graph nodes. They are registered as transient steps while the group runs, appear individually in the run log, and are excluded from the completed-node ledger used by checkpoints.
- Packing selected steps requires at least two steps that form one continuous chain with no connections leaving the selection. Some block types cannot be children. **Ungroup** returns the children to the canvas.
- A malformed child is reported and fails the run instead of being skipped silently.

<!-- operator:clipboard -->

## Clipboard

Reads the system clipboard, or the current page selection, into a variable; or writes workflow text into the clipboard. [Automa reference](https://www.goautoma.com/extension/docs/blocks/clipboard.html)

### Settings

| Field                          | Type            | Default | Notes                                                                                                           |
| ------------------------------ | --------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| Action                         | Select          | `get`   | `get` reads; `insert` writes.                                                                                   |
| Text                           | Multi-line text | Empty   | Insert mode only; supports `{{variables}}`. Hidden when **Copy the selected text on page** is on.               |
| Copy the selected text on page | Checkbox        | Off     | In get mode, read the page selection instead of the system clipboard. In insert mode, hides the **Text** field. |
| Assign to variable             | Checkbox        | Off     | Shows the variable-name field for a get. The read is always stored.                                             |
| Variable name                  | Text            | Empty   | Defaults to `lastClipboard` when empty.                                                                         |

### Outputs

- Get: the read text under `{{<variable name>}}`, or `{{lastClipboard}}` when the name is empty.
- Insert: no variable. The result line confirms that the clipboard was written.
- One main output port.

### Browser Copilot notes

- The read always writes a variable; **Assign to variable** only controls whether the name field is shown. An empty name is not an error because `lastClipboard` is the fallback.
- The stored schema also carries `saveData` and `dataColumn`, but this form neither shows nor applies them; the clipboard block does not write the data table.
- The **Copy the selected text on page** flag is applied in get mode. In insert mode the executor still writes the **Text** value, so leave the flag off when the text must be predictable.
- Clipboard access depends on browser focus and permission. A refusal fails the step with the underlying reason.

<!-- operator:wait-connections -->

## Wait connections

Pauses briefly so a navigation started by the previous step can settle, then waits for the tab being driven to report that it has loaded. In this build it waits on the tab, not on other incoming graph branches. [Automa reference](https://www.goautoma.com/extension/docs/blocks/wait-connections.html)

### Settings

| Field                         | Type     | Default | Notes                                                                       |
| ----------------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| Timeout (milliseconds)        | Number   | `10000` | Upper bound for the tab-load wait; values below 1000 are raised to 1000.    |
| Only continue a specific flow | Checkbox | Off     | Stored with the node; not applied.                                          |
| Select flow (block id)        | Text     | Empty   | Shown when the previous option is on; stored with the node and not applied. |

### Outputs

No variables. One main output port. The result line reports that the page has loaded.

### Browser Copilot notes

- The step always waits 300 ms before listening, because a tab can still report `complete` for the page that is being navigated away from.
- **Only continue a specific flow** and its block id are persisted for imported workflows but are ignored by this executor; there is no flow-level wait in this build.
- With no resolvable tab the step returns immediately. Waiting is best effort: when the timeout expires, the step still continues and reports the page as loaded.

<!-- operator:notification -->

## Notification

Shows a desktop notification, and can forward the same text to a Feishu bot. [Automa reference](https://www.goautoma.com/extension/docs/blocks/notification.html)

### Settings

| Field                | Type            | Default        | Notes                                            |
| -------------------- | --------------- | -------------- | ------------------------------------------------ |
| Title                | Text            | `Hello world!` | Supports `{{variables}}`.                        |
| Message              | Multi-line text | Empty          | Supports `{{variables}}`.                        |
| Send to Feishu       | Checkbox        | Off            | Uses the Feishu webhook configured in Settings.  |
| Icon URL (optional)  | Text            | Empty          | Stored with the node; not applied by this build. |
| Image URL (optional) | Text            | Empty          | Stored with the node; not applied by this build. |

### Outputs

No variables. One main output port; the result line confirms that the notification was sent.

### Browser Copilot notes

- Title and message are interpolated before the notification is created.
- This build always uses the extension's own icon (`icons/icon-48.png`). **Icon URL** and **Image URL** are kept for round-tripping but do not change the notification.
- Feishu delivery uses the webhook from Settings. A missing webhook or a failed delivery is logged, but the step still succeeds because the desktop notification already went out.
- When the notifications API is unavailable, the step records an informational message and continues.

<!-- operator:note -->

## Note

A free-form annotation placed on the canvas. It documents the workflow and has no effect on execution. No upstream Automa page exists for this operator.

### Settings

| Field       | Type            | Default | Notes                                                                    |
| ----------- | --------------- | ------- | ------------------------------------------------------------------------ |
| Description | Multi-line text | Empty   | The note body, stored as `note`; edited on the canvas or in the sidebar. |

### Outputs

No variables. One pass-through output port.

### Browser Copilot notes

- Width, height, color, font size, and the drawing flag are presentation fields stored with the note; they only affect how the annotation looks on the canvas.
- The note text stays on the canvas in this build: the executor reads a legacy `text` key while the editor writes `note`, so nothing is printed to the run log.
- A note can be connected like any other node without changing the path, which makes it safe to leave in a chain while documenting it.

<!-- operator:workflow-state -->

## Workflow State

Asks the run to stop itself, another workflow, or a named set of workflows. In this build a block cannot reach the scheduler, so every stop action ends the step with an error instead. [Automa reference](https://www.goautoma.com/extension/docs/blocks/workflow-state.html)

### Settings

| Field                           | Type     | Default        | Notes                                                                               |
| ------------------------------- | -------- | -------------- | ----------------------------------------------------------------------------------- |
| Action                          | Select   | `stop-current` | `stop-all`, `stop-current`, or `stop-specific`.                                     |
| Except for the current workflow | Checkbox | Off            | Stop-all only; stored but not applied.                                              |
| Workflow IDs (comma separated)  | Text     | Empty          | Stop-specific only; stored but not applied.                                         |
| Throw error                     | Checkbox | Off            | Stop-current only in the form; when on, **Error message** becomes the failure text. |
| Error message                   | Text     | Empty          | Shown when **Throw error** is on; supports `{{variables}}`.                         |

### Outputs

No variables. One main output port, which a stop action never reaches because the step throws.

### Browser Copilot notes

- Stopping a run belongs to the scheduler, and no block-reachable hook exists in this build. `stop-all`, `stop-current`, and `stop-specific` all fail the step rather than pretending the workflow stopped.
- With **Throw error** on, the step throws **Error message** (or a generic message when it is empty). With it off, it throws a generic error that names the requested action.
- **Except for the current workflow** and **Workflow IDs** are saved for imported workflows but are not read on this path.
- For tool-schema nodes the executor also understands `get` and `set` for a variable named `state`; `get` publishes `lastState`. The inspector does not offer those actions.

<!-- operator:parameter-prompt -->

## Parameter prompt

Resolves the workflow's declared inputs before the following steps run. This build shows no interactive dialog: values come from the run scope, and defaults fill the gaps. [Automa reference](https://www.goautoma.com/extension/docs/blocks/parameter-prompt.html)

### Settings

| Field                                | Type   | Default | Notes                                                                             |
| ------------------------------------ | ------ | ------- | --------------------------------------------------------------------------------- |
| Timeout (millisecond) (0 to disable) | Number | `60000` | Stored with the node; not applied because no prompt is displayed.                 |
| Parameters                           | List   | Empty   | Declared inputs; each entry has a name, a required flag, and an optional default. |

### Outputs

- One variable per parameter, using the parameter's name.
- The result line lists the resolved pairs as `name=value`, separated by `·`.
- One main output port.

### Browser Copilot notes

- A value already present in the run scope wins; a default is written only when the variable is undefined, so a trigger payload or an earlier step is never overwritten.
- Defaults are interpolated before they are stored.
- A missing required parameter fails the step and names every missing input, instead of driving later steps with a blank value.
- With no parameters declared, the step records an informational message and continues.
- The timeout and any prompt or placeholder text are persisted but have no effect while no prompt is shown.

<!-- operator:webhook -->

## HTTP Request

Sends an HTTP request to a remote endpoint and decodes the response into variables or the data table. [Automa reference](https://www.goautoma.com/extension/docs/blocks/webhook.html)

### Settings

| Field                         | Type     | Default | Notes                                                                                            |
| ----------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| Request method                | Select   | `POST`  | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `HEAD`.                                              |
| Request URL *                 | Text     | Empty   | Supports `{{variables}}`.                                                                        |
| Content type                  | Select   | `json`  | `text/plain`, `application/json`, `multipart/form-data`, or `application/x-www-form-urlencoded`. |
| Timeout (ms) (0 to disable)   | Number   | `10000` | Applies to the request itself.                                                                   |
| Headers                       | List     | Empty   | Rows of header name and value; each value can use `{{variables}}`.                               |
| Request body                  | JSON     | `{}`    | Hidden for `GET` and `HEAD`.                                                                     |
| Response type                 | Select   | `json`  | `json`, `text`, or `base64`.                                                                     |
| Data path                     | Text     | Empty   | JSON responses only; narrows the response before it is stored.                                   |
| Assign response to a variable | Checkbox | Off     | Store the decoded, data-path-narrowed value under **Variable name**.                             |
| Variable name                 | Text     | Empty   | When set, the decoded response is stored here instead of `lastHttpResponse`.                     |
| Save response to a table      | Checkbox | Off     | Append response rows to the data table.                                                          |
| Column name                   | Text     | Empty   | Required for a table write.                                                                      |

### Outputs

- The decoded response is stored under **Variable name** when that field is set, otherwise under `lastHttpResponse`.
- With **Assign response to a variable** on, the same variable receives the value after **Data path** is applied.
- With **Save response to a table** on, rows are appended to **Column name**; an empty column logs an informational message and skips the write.
- Two output ports: the main port for a successful response, and the fallback port for a transport error or a non-2xx status when that port is connected.

### Browser Copilot notes

- Only request failures use the fallback port. A configuration error — an unreadable URL, header, or body — fails the step even when a fallback edge exists.
- `GET` and `HEAD` send no body. Other methods encode the body according to the selected content type.
- **Data path** is applied only to JSON responses. Text and base64 responses are stored as they arrive.
- A timeout of `0` removes the request limit. Aborting the run aborts the request.
- A non-2xx response without a fallback edge fails the step with the method, status, and URL.

<!-- operator:ai-agent -->

## AI agent

Reads an optional target element and hands it, together with your prompt, to a tool-calling AI agent. The agent returns a text answer and, when allowed, can act on the page. Browser Copilot-only operator.

### Settings

| Field                                                      | Type            | Default       | Notes                                                                                               |
| ---------------------------------------------------------- | --------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| Find by                                                    | Select          | `cssSelector` | `cssSelector`, `xpath`, or `text` for the optional target element.                                  |
| Target element (optional)                                  | Text            | Empty         | The matched element's text is read at run time. Leave it empty and the agent reads the page itself. |
| Prompt *                                                   | Multi-line text | Empty         | The instruction for the agent; supports `{{variables}}`.                                            |
| Allow the agent to act on the page (click, fill, navigate) | Checkbox        | Off           | Off is read-only analysis; on lets the agent click, type, and navigate autonomously.                |
| Max tool rounds                                            | Number          | `20`          | Per-node cap on model and tool round trips, 1 to 50.                                                |
| Output variable name                                       | Text            | `lastAIAgent` | Receives the agent's final text answer.                                                             |
| Take a page snapshot before acting                         | Checkbox        | On            | Lets the agent list buttons, links, and fields so it can locate elements itself.                    |

### Outputs

- The agent's final answer as text, under **Output variable name** (default `{{lastAIAgent}}`).
- One main output port. The block does not write the data table.

### Browser Copilot notes

- With no target element, the agent reads the page through its tools; with a target, that element's text is read first and included in the task.
- In read-only mode the agent can inspect the page and answer but cannot click, type, or navigate. In full-auto mode every action is written to the run log; there is no per-step confirmation.
- **Max tool rounds** bounds this node independently of the global setting, so one step cannot loop forever.
- The model provider comes from Settings. A failed model call fails the step and follows the node's **On error** policy.
- The prompt is interpolated before the agent starts, so a prior step can supply the instruction or part of it.

# Getting started

This page walks through the workflow editor and builds a complete workflow you can run: open a page, read its headline, put the text into a variable, and write it to a file.

## Open the workflow editor

1. Open the Browser Copilot side panel and select the **Workflows** tab.
2. Select **New** to create a workflow, or **Edit** on an existing one to open the canvas.
3. The editor opens with the graph on the left and the block inspector on the right. **Add blocks** toggles the palette; **Workflow** and **Logs** switch the right-hand panel between the selected block, the trigger and run settings, and the run history.

The toolbar holds **Save** and **Run** (Ctrl+Enter). Running saves the workflow first, so the graph the background executes is always the graph you are looking at. **Debug mode** enables breakpoints and step-by-step execution for the next run.

You can also record a session instead of building it by hand: **Record workflow** captures the actions you perform on a page and opens the result as a graph.

## Meet the canvas

- Every workflow starts from a **Trigger** block. Workflow name, description, launch triggers, and run settings live on it.
- The palette groups operators by category. Search by name to narrow the list.
- Select a block to edit it in the inspector. Drag the node header to move it, or use **Auto-layout** to tidy the graph.
- Connections run from a block's output on the right to the next block's input on the left. Branches, fallbacks, and loop returns use additional named ports; see [Ports, branches, and loops](concepts.md#ports-branches-and-loops).
- Canvas edits are undoable. Deleting an edge or node does not touch the saved workflow until you save.

## Configure the trigger

The Trigger block is where a workflow starts. Select it and add one or more triggers with **Add trigger**; the first one is the primary trigger, whose type is shown on the workflow card. Each trigger can be enabled or disabled independently.

The supported kinds are:

| Kind                    | Fires when                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| Manually                | You run the workflow from the editor or the Workflows tab.               |
| Interval                | A fixed number of minutes passes between runs.                           |
| On a specific date      | A one-off date and time arrives.                                         |
| On a specific day       | The selected weekdays arrive at the configured local time.               |
| When visiting a website | A tab opens a URL that matches the pattern (glob or regular expression). |
| Keyboard shortcut       | You press the configured shortcut, optionally only outside input fields. |
| Context menu            | You choose the workflow from the browser's right-click menu.             |
| On browser startup      | The browser starts.                                                      |
| On element change       | An element matching a CSS selector is inserted or mutated on a page.     |

Triggers that need a parameter show a field for it. An incomplete trigger is saved but will not fire; the run preflight warns you.

A trigger can also declare **inputs** (parameters with a name, type, and default). Declared inputs are seeded into the run's variables, so `{{keyword}}` resolves even when the caller passed nothing. This is how a generated workflow stays runnable while still being editable.

## Add and connect operators

1. Select **Add blocks** and find the operator you need.
2. Click or drag it onto the canvas. A new node appears with its default settings.
3. Connect the previous block's output handle to the new block's input handle.
4. Select the node and fill in its settings in the inspector.

Most operators have one input and one output. Some add extra ports:

- **Conditions** creates one output per configured path plus a **fallback** output.
- **Element exists** exposes true and false outputs.
- Loop and error-handling blocks add return or fallback ports.

Ports are described on each operator page and in [Workflow concepts](concepts.md#ports-branches-and-loops).

## Configure a block

The inspector follows the operator's form. Common sections appear near the bottom on most nodes:

- **Output variable** — where the step publishes its result. Name it after the data, not the operator (`headline`, not `text2`).
- **Disable block** — skip this node without deleting it.
- **Timeout** — fail the step when it runs longer than the limit; `0` disables the limit.
- **On error** — retry, fail, continue, or route to the fallback branch.
- **Goal & success criteria** — optional checkable facts used by generation, verification, and AI repair.
- **Breakpoint** — pause before this node in Debug mode.

Any text field that accepts `{{...}}` can reference a workflow variable, including selectors, URLs, file names, and JSON values. The rules and limits are in [Variables and interpolation](concepts.md#variables-and-interpolation).

## Run, debug, and read logs

Select **Run** (Ctrl+Enter) to execute the workflow against the current browser. The first run may ask you to confirm the page context if the workflow was generated elsewhere.

- The **Logs** panel lists the run and one row per block. Select a row to locate that block on the canvas.
- A step that throws stops the run unless its **On error** policy says otherwise.
- If required parameters are missing, the run stops before the first such block; the log names each one.

Turn on **Debug mode** to pause before every block with a breakpoint. The debug bar offers **Resume**, **Next**, and **Stop**, and the **Variables** panel shows the variable values captured at the paused block. Use **Run workflow from here** on a node to start in the middle of the graph.

Optional run settings on the Trigger block:

- **Save execution logs** keeps the transcript in run history.
- **Notify when finished** posts a browser notification when the run settles.
- **Workflow goal** records success conditions checked after the final step.

## Save, export, and import

**Save** stores the workflow. The Workflows tab offers **Export** for a single workflow, the current selection, or a group; each produces a JSON file. **Import** accepts those files, including group exports, and restores workflows (and the group) without overwriting unrelated ones.

A workflow that contains a cloud operator or an operator unavailable in this build is imported intact but cannot run it; see the [status legend](README.md#status-legend).

## Your first workflow

Goal: open a page, read its headline into a variable, compose a one-line report, and write it to a text file.

1. Create a workflow in the Workflows tab and open it in the editor.
2. Leave the Trigger block on **Manual**.
3. Add **New tab**, connect Trigger → New tab, and set the URL to `https://example.com`.
4. Add **Get text**, connect New tab → Get text, set the selector to `h1`, and set **Output variable** to `headline`.
5. Add **Set variable**, connect Get text → Set variable. Add a row with name `report` and value `Headline: {{headline}}`.
6. Add **Export data**, connect Set variable → Export data:
   - **Data to export**: Variable.
   - **Variable name**: `report`.
   - **Export as**: Plain text.
   - File name: `headline.txt`.
7. Select **Run**. The first export opens a save dialog unless you configured a download folder in Settings → Download folder; with a folder configured, the file is written there without prompting.
8. Open `headline.txt` and check that it contains `Headline: ` followed by the page's `h1` text.

If the text is empty, open the log for the Get text block. It fails rather than silently exporting nothing when the selector matches no element.

## Next steps

- [Workflow concepts](concepts.md) — variables, the data table, loops, errors, files, secrets, and AI features.
- [Web interaction operators](operators-interaction.md) — clicking, reading, filling, and scripts.
- [Browser operators](operators-browser.md) — tabs, downloads, cookies, and OCR.
- [Control flow operators](operators-conditions.md) — branches and loops.

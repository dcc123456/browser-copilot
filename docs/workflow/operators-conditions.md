# Control flow operators

This page covers the operators that decide where a run goes or how often it repeats: **Conditions**, **Element exists**, the four loops, and the block that ends a loop early. Each section lists the operator's settings, its outputs, and the behavior that is specific to Browser Copilot. Branch ports and the loop-back edge are explained once in [Workflow concepts](concepts.md#ports-branches-and-loops), and failed steps follow [Errors, retries, and reliability](concepts.md#errors-retries-and-reliability); the common **Description**, **Disable block**, **Block timeout**, and **On error** settings apply to every node and are not repeated in the tables. Locators accept a CSS selector or an XPath expression, and data fields accept `{{variables}}`.

<!-- operator:repeat-task -->

## Repeat task

Runs the attached branch a fixed number of times, then continues from the **end** output. [Automa reference](https://www.goautoma.com/extension/docs/blocks/repeat-task.html)

### Settings

| Field        | Type   | Default | Notes                                                                                   |
| ------------ | ------ | ------- | --------------------------------------------------------------------------------------- |
| Repeat count | Number | `1`     | How many times the branch runs. `0` skips the body and continues straight from **end**. |

### Outputs

- `loopIndex` — zero-based repetition number, written before each repetition and left at the last value afterwards.
- `loop` (`output-1`) starts the body; `end` (`output-2`) is the continuation after the last repetition.

### Browser Copilot notes

- The body closes by routing its last step back to this node. Reaching the loop node again ends one repetition; see [ports, branches, and loops](concepts.md#ports-branches-and-loops).
- With `0` the body never runs, but the **end** path still does.
- No `loopItem` is published — the repetition number is the only loop context here.
- A failing body step stops the loop and the run; the **end** path is not followed. See [errors and reliability](concepts.md#errors-retries-and-reliability).

<!-- operator:conditions -->

## Conditions

Evaluates its named output paths from top to bottom and continues on the first path whose conditions all hold, or on **fallback** when none do. [Automa reference](https://www.goautoma.com/extension/docs/blocks/conditions.html)

### Settings

| Field                          | Type           | Default  | Notes                                                                                                                                     |
| ------------------------------ | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Output paths                   | List           | None     | Ordered branches. Each entry owns one output port and its own condition tree. Up to 20 paths; **Add path** is disabled at the limit.      |
| Path name                      | Text           | `Path N` | Label shown on that path's port and in the run log. Renaming keeps the path id, so existing connections survive it.                       |
| Path conditions                | Condition tree | Empty    | OR groups of AND rows. Every row in a group must hold, and one group must hold, for the path to match. A path with no rows never matches. |
| Retry if no conditions are met | Checkbox       | Off      | Saved with the operator; this build does not re-evaluate (see the notes).                                                                 |
| Times                          | Number         | `10`     | Shown only while **Retry if no conditions are met** is on.                                                                                |
| Timeout (ms)                   | Number         | `1000`   | Shown only while **Retry if no conditions are met** is on.                                                                                |

### Outputs

- One port per configured path, keyed `output-<pathId>` and labelled with the path name, plus an always-present **fallback** port (`output-none`).
- No variable is published; the run log names the path that matched, or reports that none did.

### Browser Copilot notes

- Only the first match runs. Change the evaluation order with the path's move-up / move-down buttons instead of duplicating conditions.
- An empty path is skipped rather than treated as always true, so a half-configured branch cannot swallow the run.
- Ports are exclusive: when a path matches but its port has no connection, the run ends there instead of falling through to another path. See [ports, branches, and loops](concepts.md#ports-branches-and-loops).
- Imported workflows may carry a legacy `code` expression; it wins over `paths` and the node then uses `output-1` (true) and `output-2` (false). The editor writes `paths`, which is authoritative whenever the key exists — including an empty list, which routes every run to **fallback**.
- **Retry if no conditions are met** and its two numbers are stored for round-tripping but are not applied by the engine in this build. A **Delay** step before the node, or a **While loop** driven by the page, is the working alternative.
- A condition row compares two values with an operator (`Equals`, `Contains`, numeric comparisons, a regex, …) or stands alone: element exists / not exists / visible, data exists, or a code snippet. Element checks run against the current page after interpolation.

<!-- operator:element-exists -->

## Element exists

Takes the **exists** port when the locator matches at least one element and the **not exists** port when it matches none. [Automa reference](https://www.goautoma.com/extension/docs/blocks/element-exists.html)

### Settings

| Field                           | Type     | Default       | Notes                                                                                       |
| ------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------- |
| Find by                         | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`. XPath is recognised from the value itself.               |
| Selector                        | Text     | —             | Locator to probe. Accepts `{{variables}}`.                                                  |
| Select multiple elements        | Checkbox | Off           | Shared locator option; the check already means "one or more", so this changes nothing here. |
| Wait for selector               | Checkbox | Off           | Saved by the shared locator options; this build probes once (see the notes).                |
| Selector timeout (ms)           | Number   | `5000`        | Shown only while **Wait for selector** is on.                                               |
| Try for                         | Number   | `1`           | Number of attempts the form records for the check.                                          |
| Timeout (milliseconds)          | Number   | `500`         | Pause between the recorded attempts.                                                        |
| Throw an error if doesn't exist | Checkbox | Off           | Recorded intent: fail the step instead of taking **not exists**.                            |

### Outputs

- `exists` (`output-1`) and `not exists` (`output-2`). Both are exclusive branches; an unwired port ends the run.
- No variable is written — the match count only appears in the run log.

### Browser Copilot notes

- The engine performs one probe. **Try for**, **Timeout (milliseconds)**, **Wait for selector**, and **Throw an error if doesn't exist** travel with the block but are not consumed here, so a late element lands on **not exists** even with the throw option on. Add a **Delay** before this node, or wait on the step that actually needs the element.
- Existence is "count greater than zero": hidden elements still count, and the locator does not need to be unique.
- **Find by → Text** is stored but not turned into a text search; the value is queried as a selector. Use a CSS or XPath locator here, or an **Element text** row inside **Conditions**.
- Wire both ports when the run should continue either way; leaving one unconnected ends the run on that verdict.

<!-- operator:while-loop -->

## While loop

Repeats the attached branch while its condition holds, testing the condition before every iteration. [Automa reference](https://www.goautoma.com/extension/docs/blocks/while-loop.html)

### Settings

| Field                | Type           | Default | Notes                                                                                            |
| -------------------- | -------------- | ------- | ------------------------------------------------------------------------------------------------ |
| While loop condition | Condition tree | Unset   | OR groups of AND rows, built the same way as in **Conditions**. Evaluated before each iteration. |

### Outputs

- `loopIndex` — zero-based iteration number inside the body.
- `loop` (`output-1`) runs the body; `end` (`output-2`) is the continuation once the condition is false.

### Browser Copilot notes

- A false first check means zero iterations and the run continues on **end**.
- The loop is capped at 1,000 iterations. After the 1,001st iteration the run fails with an iteration-limit error instead of spinning; the node is reported as failed and **end** is not followed.
- A node with no saved condition logs an error and runs zero iterations. The editor opens with one OR group of two empty rows, but they are only written to the node once you edit the tree — and empty compared with empty holds, so an unchanged default tree would loop until the cap. Fill in real operands.
- **Stop loop** leaves through **end**. A loop breakpoint that only skips the current item still consumes one iteration against the cap, so a body that always skips cannot bypass the guard.
- A failing body step ends the loop and the run without following **end**; see [errors and reliability](concepts.md#errors-retries-and-reliability).
- Imported workflows may carry a `code` expression instead of the tree. A saved tree wins; the expression is used only when no tree is configured.

<!-- operator:loop-data -->

## Loop data

Iterates a data table, number range, variable, JSON array, or page element list, publishing each item as `loopItem` and its position as `loopIndex`. [Automa reference](https://www.goautoma.com/extension/docs/blocks/loop-data.html)

### Settings

| Field                           | Type     | Default        | Notes                                                                                              |
| ------------------------------- | -------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Loop ID                         | Text     | Auto (6 chars) | Names this loop for **Loop breakpoint** and for resume progress.                                   |
| Loop through                    | Select   | `data-columns` | `data-columns` (Table), `numbers`, `google-sheets`, `variable`, `custom-data`, or `elements`.      |
| Reference key                   | Text     | —              | Google Sheets source only. Not usable in this build; see the notes.                                |
| Variable name                   | Text     | —              | Variable source only. Dotted paths such as `order.items` read the same way `{{order.items}}` does. |
| Element selector                | Text     | —              | Element source only. CSS or XPath; every match is iterated.                                        |
| Wait for selector               | Checkbox | Off            | Element source only: poll until at least one match appears.                                        |
| Selector timeout (ms)           | Number   | `5000`         | Element source only; shown while **Wait for selector** is on.                                      |
| Custom data (JSON array)        | Text     | `[]`           | JSON source. **Import file** also accepts `.json`, `.csv`, and `.xlsx` up to 1 MB.                 |
| First row is the header         | Checkbox | On             | Import only; applies to spreadsheet files, so imported rows become objects keyed by column.        |
| From number                     | Number   | `1`            | Numbers source: first value of the range.                                                          |
| To number                       | Number   | `10`           | Numbers source: last value, inclusive; the range counts down when **From number** is larger.       |
| Max data to loop (0 to disable) | Number   | `0`            | Cap on iterations; `0` visits every item.                                                          |
| Start from index                | Number   | `0`            | Skips that many items first. Hidden while **Resume last workflow** is on.                          |
| Resume last workflow            | Checkbox | Off            | Continue from the index saved before the last unfinished item.                                     |
| Reverse loop order              | Checkbox | Off            | Iterates the source backwards, before the start index and the cap apply.                           |

### Outputs

- `loopIndex` — absolute position in the source, so the first item after skipping three is `3`.
- `loopItem` — the current item: an object for table rows and JSON items, a number for a number range. Element loops set it to `null`.
- One output port: the body. This loop has no `end` port; the after-loop continuation is described in the notes.

### Browser Copilot notes

- **After-loop path**: with a single output, the run continues after the loop from the outgoing edge of the **Loop breakpoint** inside the body. A body without one leaves the run with nowhere to go when the loop finishes. Graphs imported with a legacy `end` port still use that edge as a fallback.
- Source behavior:
  - **Table** reads `dataTable`; an empty table logs an info line and iterates zero times.
  - **Numbers** builds an inclusive range and ignores the start index, the cap, reverse order, and resume.
  - **Variable** iterates an array as-is; JSON text is parsed first; a plain string iterates its characters; a number iterates `1..N`.
  - **Custom data** must be a JSON array; empty or malformed data fails the run with a named reason.
  - **Element source** counts matches once at loop start and publishes `loopElementSelector` for each one.
  - **Google Sheets** is refused in this build (it needs OAuth credentials); import the sheet as custom data instead.
- Preparation order is reverse first, then **Start from index**, then **Max data to loop**. The source is snapshotted at loop start, so rows the body appends are not visited by this loop.
- **Resume last workflow** records the current index before each item's body runs, so an interrupted run replays the unfinished item. Normal completion and **Stop loop** clear the entry.
- A failing body step stops the loop and the run without following the after-loop path.
- Invalid number bounds, a non-iterable variable, or an unknown source fail the run with a message that names the loop; see [errors and reliability](concepts.md#errors-retries-and-reliability).

<!-- operator:loop-elements -->

## Loop elements

Iterates every element that matches the locator and publishes a selector for the current element as `loopElementSelector`. [Automa reference](https://www.goautoma.com/extension/docs/blocks/loop-elements.html)

### Settings

| Field                                                     | Type     | Default        | Notes                                                                                                |
| --------------------------------------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Loop ID                                                   | Text     | Auto (6 chars) | Identifies this loop for **Loop breakpoint**.                                                        |
| Find by                                                   | Select   | `cssSelector`  | `cssSelector`, `xpath`, or `text`.                                                                   |
| Selector                                                  | Text     | —              | Locator for the set to iterate; every match is used. Accepts `{{variables}}`.                        |
| Wait for selector                                         | Checkbox | Off            | Saved by the shared locator options; matches are counted once when the loop starts, with no polling. |
| Selector timeout (ms)                                     | Number   | `5000`         | Shown while **Wait for selector** is on.                                                             |
| Max data to loop (0 to disable)                           | Number   | `0`            | Cap on iterations; `0` visits every match.                                                           |
| Reverse loop order                                        | Checkbox | Off            | Saved with the operator; this build iterates in document order.                                      |
| Load more elements: Action                                | Select   | `none`         | `none`, click-element, click-link, scroll down, or scroll up. Saved only; see the notes.             |
| Load more elements: Element selector                      | Text     | —              | Shown for the two click actions.                                                                     |
| Load more elements: Max seconds wait for more elements    | Number   | `5`            | Shown for click-element and both scroll actions.                                                     |
| Load more elements: Scroll to bottom / top                | Checkbox | On             | Shown for the scroll actions; the label follows the direction.                                       |
| Load more elements: Max seconds wait for the page to load | Number   | `10`           | Shown for click-link.                                                                                |

### Outputs

- `loopIndex` — zero-based position in the matched set.
- `loopElementSelector` — a selector that targets the current element, meant to be spliced into the body's own locators.
- `loopItem` is not published by element loops.
- One output port: the body. The after-loop continuation leaves from the **Loop breakpoint** inside the body, exactly as for **Loop data**.

### Browser Copilot notes

- Use the published selector inside the body: `{{loopElementSelector}} .price`, or as the locator of a click/read step.
- Matches are counted once when the loop starts; elements added later are not visited. Start a second loop for content that loads during the body.
- When a unique selector cannot be produced for an iteration, the loop logs an error line and leaves `loopElementSelector` empty. The body then fails on the unresolved token instead of silently repeating the first element.
- The **Load more elements** section and **Reverse loop order** round-trip through Automa but are not executed by this build. Load more content with a **Scroll element** or a click step at the end of the body.
- A failing body step stops the loop and the run without following the after-loop path; see [errors and reliability](concepts.md#errors-retries-and-reliability).

<!-- operator:loop-breakpoint -->

## Loop breakpoint

Ends the current iteration, or the whole loop, from anywhere inside a loop body. [Automa reference](https://www.goautoma.com/extension/docs/blocks/loop-breakpoint.html)

### Settings

| Field     | Type     | Default | Notes                                                                                             |
| --------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| Loop ID   | Text     | —       | Loop to break: the loop's **Loop ID** or its node id. Empty targets the innermost enclosing loop. |
| Stop loop | Checkbox | Off     | Off skips the rest of the current item and moves to the next. On leaves the loop entirely.        |

### Outputs

- One output port. For **Loop data** and **Loop elements** it is the loop's after-loop path, because those loops have no `end` port of their own.
- No variable is written.

### Browser Copilot notes

- In **Loop data** and **Loop elements**, the run continues after the loop on this node's outgoing edge. A skip moves on to the next item and remembers that edge for when the loop ends; **Stop loop** jumps to it immediately.
- In **While loop** and **Repeat task**, leaving the loop goes through the loop's **end** port, not through this node's edge. A skip still consumes one iteration against the while-loop cap.
- An empty **Loop ID** breaks the innermost loop. Naming an outer loop's ID unwinds the inner loops too and is handled by that outer loop.
- Outside any loop, or with an ID that matches no enclosing loop, the block is ignored with an info line and the run still succeeds.
- The block is never retried, never fails, and never takes the error fallback: its sentinel bypasses **On error** and is caught by the loop. See [errors and reliability](concepts.md#errors-retries-and-reliability).
- This is not the debugger marker. A debug pause comes from a `$breakpoint` flag in block data, toggled from the block menu; it pauses a testing run before that block and never ends a loop. Checkpoints are written as each step settles, so a resume continues from the step after the last checkpointed node.

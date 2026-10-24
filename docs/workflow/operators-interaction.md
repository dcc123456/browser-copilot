# Interaction operators

This page covers the operators that act on the page itself: clicking, reading, typing, scrolling, and dispatching events. Each section lists the operator's settings, its outputs, and the behavior that is specific to Browser Copilot.

Locators accept a CSS selector, an XPath expression, or visible text, and every data field accepts `{{variables}}`. Steps run on the tab the workflow is driving, not necessarily the tab that is visible. A reference that cannot be resolved is left in place and named in the run log. The common **Description**, **Disable block**, **Timeout**, and **On error** settings are not repeated in every table; they apply to the whole node.

<!-- operator:event-click -->

## Click element

Clicks the first element matched by the locator. [Automa reference](https://www.goautoma.com/extension/docs/blocks/event-click.html)

### Settings

| Field                         | Type     | Default       | Notes                                                                                                              |
| ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Find by                       | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`. With `text`, the Selector field holds the exact visible text of a leaf element. |
| Selector                      | Text     | —             | Locator for the target. Accepts `{{variables}}`.                                                                   |
| Select multiple elements      | Checkbox | Off           | Shared locator option; clicking still acts on the first match.                                                     |
| Wait for selector             | Checkbox | Off           | Poll for the element before clicking.                                                                              |
| Selector timeout (ms)         | Number   | `5000`        | Poll window used when **Wait for selector** is on.                                                                 |
| Mark the element on execution | Checkbox | Off           | Highlights the target during the run as an editor aid.                                                             |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The click is refused when the target is disabled or covered by another element; the run log names the blocker instead of clicking through it.
- The step returns after the click is dispatched. If the click navigates, follow it with a read or a wait before depending on the new page.
- Use **Link** for anchors when you want the destination handled, and this operator for buttons and other controls.

<!-- operator:get-text -->

## Get text

Reads rendered text from one or more elements and publishes it to a variable and, optionally, the data table. [Automa reference](https://www.goautoma.com/extension/docs/blocks/get-text.html)

### Settings

| Field                         | Type         | Default       | Notes                                                                        |
| ----------------------------- | ------------ | ------------- | ---------------------------------------------------------------------------- |
| Find by                       | Select       | `cssSelector` | `cssSelector`, `xpath`, or `text`.                                           |
| Selector                      | Text         | —             | Locator for the element to read. Accepts `{{variables}}`.                    |
| Select multiple elements      | Checkbox     | Off           | Read every match as an array instead of the first match only.                |
| Wait for selector             | Checkbox     | Off           | Poll for the element before reading.                                         |
| Selector timeout (ms)         | Number       | `5000`        | Poll window used when **Wait for selector** is on.                           |
| Mark the element on execution | Checkbox     | Off           | Highlights the target during the run.                                        |
| Regex                         | Text         | —             | Stored with the operator; see the notes.                                     |
| Expression flags              | Multi-select | None          | `g`, `i`, and `m`; stored with the regex.                                    |
| Text prefix                   | Text         | —             | Keeps the text that follows this marker.                                     |
| Text suffix                   | Text         | —             | Keeps the text that precedes this marker.                                    |
| Include HTML tags             | Checkbox     | Off           | Return the element's `innerHTML` instead of its text.                        |
| Use textContent               | Checkbox     | Off           | Read `textContent`, including hidden nodes, instead of rendered `innerText`. |
| Insert to table               | Checkbox     | On            | Write the read value into the data table.                                    |
| Select column                 | Text         | —             | Column that receives the value. Required for a table write.                  |
| Add extra row                 | Checkbox     | Off           | Stored with the operator; see the notes.                                     |
| Value of the extra row        | Text         | —             | Only shown when **Add extra row** is on.                                     |
| Extra row column              | Text         | —             | Only shown when **Add extra row** is on.                                     |
| Assign to variable            | Checkbox     | Off           | Publish the value under a custom variable name.                              |
| Variable name                 | Text         | —             | Custom output name. Ignored when **Assign to variable** is off.              |

### Outputs

- `{{lastText}}` when **Variable name** is empty, otherwise `{{<name>}}`. `lastText` is updated in both cases.
- With **Select multiple elements**, the value is an array of strings.
- With **Insert to table**, one value is written per run, or one per loop iteration. Writing the same column again replaces the cell.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- A read that matches nothing, or returns only blank text, fails the step instead of publishing an empty value. Use **Element exists** when a read is optional.
- **Regex** and **Expression flags** are persisted for imported workflows but are not applied by this build. **RegEx variable** or **JavaScript code** can filter the value instead.
- **Add extra row** and its two fields are also persisted without being written.
- **Text prefix** and **Text suffix** keep the substring after the prefix and before the suffix when those markers are present.
- With **Insert to table** on but no column name, the operator records an informational message and skips the table write.

<!-- operator:element-scroll -->

## Scroll element

Scrolls the page or an element to an offset, or brings an element into view. [Automa reference](https://www.goautoma.com/extension/docs/blocks/element-scroll.html)

### Settings

| Field                         | Type     | Default       | Notes                                                                        |
| ----------------------------- | -------- | ------------- | ---------------------------------------------------------------------------- |
| Find by                       | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                                           |
| Selector                      | Text     | `html`        | `html` or `window` scrolls the page; any other locator scrolls that element. |
| Select multiple elements      | Checkbox | Off           | Shared locator option; only the first match is scrolled.                     |
| Wait for selector             | Checkbox | Off           | Poll for the element before scrolling.                                       |
| Selector timeout (ms)         | Number   | `5000`        | Poll window used when **Wait for selector** is on.                           |
| Mark the element on execution | Checkbox | Off           | Highlights the target during the run.                                        |
| Scroll horizontal             | Number   | `0`           | Horizontal target in pixels.                                                 |
| Scroll vertical               | Number   | `0`           | Vertical target in pixels.                                                   |
| Scroll into view              | Checkbox | Off           | Ignore the offsets and bring the element into view.                          |
| Smooth scroll                 | Checkbox | Off           | Animate the scroll instead of jumping.                                       |
| Increment horizontal scroll   | Checkbox | Off           | Treat **Scroll horizontal** as a delta from the current position.            |
| Increment vertical scroll     | Checkbox | Off           | Treat **Scroll vertical** as a delta from the current position.              |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- With the default `html` selector the operator scrolls the document; with `window` it also scrolls the page. Use a concrete element selector only when a scroll container should move.
- Without the increment checkboxes, the numbers are targets passed to `scrollTo`, so a value smaller than the current offset scrolls back up.
- **Scroll into view** takes priority over the offsets and ignores the increment options.

<!-- operator:link -->

## Link

Follows a link element and can open its destination in a new tab. [Automa reference](https://www.goautoma.com/extension/docs/blocks/link.html)

### Settings

| Field                         | Type     | Default       | Notes                                                                     |
| ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- |
| Find by                       | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                                        |
| Selector                      | Text     | —             | Locator for the anchor. Accepts `{{variables}}`.                          |
| Wait for selector             | Checkbox | Off           | Poll for the anchor before clicking.                                      |
| Selector timeout (ms)         | Number   | `5000`        | Poll window used when **Wait for selector** is on.                        |
| Mark the element on execution | Checkbox | Off           | Highlights the target during the run.                                     |
| Open in new tab               | Checkbox | Off           | Open the destination in a new tab instead of following the link in place. |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The destination is read from the anchor before it is followed. A `_self` link with **Open in new tab** on is opened through a new tab instead of replacing the current page.
- The step waits for the destination tab to finish loading before it returns, with a roughly 15 second cap.
- Only the first matching anchor is followed; the multi-element option is hidden for this operator.

<!-- operator:attribute-value -->

## Attribute value

Reads an attribute into a variable, or writes a value to an attribute. [Automa reference](https://www.goautoma.com/extension/docs/blocks/attribute-value.html)

### Settings

| Field                         | Type     | Default       | Notes                                                           |
| ----------------------------- | -------- | ------------- | --------------------------------------------------------------- |
| Find by                       | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                              |
| Selector                      | Text     | —             | Locator for the element. Accepts `{{variables}}`.               |
| Select multiple elements      | Checkbox | Off           | Shared locator option; only the first match is read or written. |
| Wait for selector             | Checkbox | Off           | Poll for the element before acting.                             |
| Selector timeout (ms)         | Number   | `5000`        | Poll window used when **Wait for selector** is on.              |
| Mark the element on execution | Checkbox | Off           | Highlights the target during the run.                           |
| Action                        | Select   | `get`         | `get` reads the attribute; `set` writes it.                     |
| Attribute name                | Text     | —             | Attribute to read or write, for example `href`.                 |
| Attribute value               | Text     | —             | Value written by `set`. Accepts `{{variables}}`.                |
| Assign to variable            | Checkbox | Off           | Publish a read under a custom variable name.                    |
| Variable name                 | Text     | —             | Custom output name for `get`.                                   |
| Insert to table               | Checkbox | On            | Shown for `get`; see the notes.                                 |
| Select column                 | Text     | —             | Column shown when **Insert to table** is on.                    |
| Add extra row                 | Checkbox | Off           | Shown for `get`; see the notes.                                 |
| Value of the extra row        | Text     | —             | Only shown when **Add extra row** is on.                        |
| Extra row column              | Text     | —             | Only shown when **Add extra row** is on.                        |

### Outputs

- For `get`: `{{lastAttribute}}` when **Variable name** is empty, otherwise `{{<name>}}`.
- For `set`: no output.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- A read fails when the element does not match or the attribute is absent, instead of publishing an empty string.
- The **Insert to table** and **Add extra row** controls are present for `get` but are not written by this build; only the variable is set.
- Values read from boolean or numeric attributes are still strings, because they come from the DOM.

<!-- operator:forms -->

## Forms

Fills a text field, selects an option, toggles a checkbox or radio, or reads a control's current value. [Automa reference](https://www.goautoma.com/extension/docs/blocks/forms.html)

### Settings

| Field                                    | Type     | Default       | Notes                                                                    |
| ---------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------ |
| Find by                                  | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                                       |
| Selector                                 | Text     | —             | Locator for the form control. Accepts `{{variables}}`.                   |
| Select multiple elements                 | Checkbox | Off           | Shared locator option; only the first match is used.                     |
| Wait for selector                        | Checkbox | Off           | Poll for the control before acting.                                      |
| Selector timeout (ms)                    | Number   | `5000`        | Poll window used when **Wait for selector** is on.                       |
| Mark the element on execution            | Checkbox | Off           | Highlights the target during the run.                                    |
| Get form value                           | Checkbox | Off           | Read the control instead of writing to it.                               |
| Assign to variable                       | Checkbox | Off           | Publish a read under a custom variable name.                             |
| Variable name                            | Text     | —             | Required when **Get form value** is on.                                  |
| Form type                                | Select   | `text-field`  | `text-field`, `select`, `checkbox`, or `radio`.                          |
| Selected                                 | Checkbox | On            | Check or uncheck a checkbox or radio.                                    |
| Value                                    | Text     | —             | Text to type, or the option value for a select. Accepts `{{variables}}`. |
| Clear form value                         | Checkbox | On            | Clear the field before typing.                                           |
| Select an option by                      | Select   | `value`       | `value`, `first-option`, `last-option`, or `custom-position`.            |
| Option position                          | Number   | `1`           | One-based position used by `custom-position`.                            |
| Typing delay (millisecond)(0 to disable) | Number   | `0`           | Stored with the operator; see the notes.                                 |

### Outputs

- With **Get form value**: `{{<name>}}` receives the control's native value. The variable name is required.
- Otherwise: no output.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- A text fill whose value becomes empty because a reference resolved to nothing is refused, so the operator does not wipe a field by accident.
- **Typing delay** is stored but not applied; the text is inserted in one action.
- The read value keeps its native type: a string for text fields, a boolean for checkboxes and radios, and an array for a multi-select.
- `custom-position` counts options from 1; selecting an option by position does not require a value.

<!-- operator:javascript-code -->

## JavaScript code

Runs a JavaScript function body in the page and stores its return value. [Automa reference](https://www.goautoma.com/extension/docs/blocks/javascript-code.html)

### Settings

| Field                    | Type     | Default                                             | Notes                                                                   |
| ------------------------ | -------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Timeout (milliseconds)   | Number   | `20000`                                             | Maximum run time for the script.                                        |
| Execution context        | Select   | `website`                                           | `website` runs in the page; `background` is stored but not implemented. |
| JavaScript code          | Textarea | `console.log("Script started");\nautomaNextBlock()` | Function body. Use `return` to send a value.                            |
| Execute in every new tab | Checkbox | Off                                                 | Stored with the operator; see the notes.                                |
| Run before page loaded   | Checkbox | Off                                                 | Stored with the operator; see the notes.                                |
| Preload scripts          | List     | Empty                                               | URL and type (`script` or `style`) per entry.                           |
| Remove after execution   | Checkbox | Off                                                 | Per preload entry.                                                      |

### Outputs

- `{{lastResult}}` always receives the value returned by the script, or the value passed to `automaNextBlock()`.
- Variables written with `automaSetVariable()` or assignments on `variables` are merged into the run.
- Console output captured by the page harness is written to the run log.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The page harness provides `automaNextBlock()`, `automaSetVariable()`, `automaRefData()`, and `automaResetTimeout()`.
- The script runs as a function body with `return`, not as a free-standing program. `automaNextBlock()` ends the script early and overrides the return value.
- **Execution context**, **Execute in every new tab**, **Run before page loaded**, and **Preload scripts** are stored for compatibility but are not applied by this build; the script runs in the current page.
- An empty script is an error, and so is a script that throws. Retry or fallback behavior comes from the node's **On error** policy.

<!-- operator:trigger-event -->

## Trigger event

Dispatches a DOM event on the selected element. [Automa reference](https://www.goautoma.com/extension/docs/blocks/trigger-event.html)

### Settings

| Field                         | Type     | Default       | Notes                                                                            |
| ----------------------------- | -------- | ------------- | -------------------------------------------------------------------------------- |
| Find by                       | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                                               |
| Selector                      | Text     | `html`        | Element that receives the event. Accepts `{{variables}}`.                        |
| Select multiple elements      | Checkbox | Off           | Shared locator option; only the first match receives the event.                  |
| Wait for selector             | Checkbox | Off           | Poll for the element before dispatching.                                         |
| Selector timeout (ms)         | Number   | `5000`        | Poll window used when **Wait for selector** is on.                               |
| Mark the element on execution | Checkbox | Off           | Highlights the target during the run.                                            |
| Event                         | Select   | —             | One of 21 DOM events, such as `click`, `change`, `keydown`, `input`, or `wheel`. |
| Bubbles                       | Checkbox | On            | Stored with the operator; see the notes.                                         |
| Cancelable                    | Checkbox | Off           | Stored with the operator; see the notes.                                         |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The dispatch is a `CustomEvent` carrying the event name and a `detail` value. Events whose names contain `mouse` or `click` are dispatched without bubbling; other events bubble by default.
- The **Options** fold-out (modifier keys, mouse button, coordinates, wheel deltas, keyboard fields, and input data) is stored but not forwarded by this build. **Bubbles** and **Cancelable** therefore follow the dispatch rules above, not the checkboxes.
- Use **JavaScript code** when a page needs a precisely configured native event or a different target event object.

<!-- operator:switch-to status:placeholder -->

## Switch frame

Names the main window or an iframe as the context for later steps. [Automa reference](https://www.goautoma.com/extension/docs/blocks/switch-to.html)

### Settings

| Field            | Type   | Default       | Notes                                                                         |
| ---------------- | ------ | ------------- | ----------------------------------------------------------------------------- |
| Window type      | Select | `main-window` | `main-window` or `iframe`.                                                    |
| Element selector | Text   | —             | CSS selector or XPath for the iframe; shown when **Window type** is `iframe`. |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- This operator is a placeholder for context only. The executor records the selected frame in the run log but does not change the driver's frame context, and later steps still resolve elements through the page kernel.
- Do not rely on this operator to enter an iframe at run time; it neither focuses the frame nor restricts later locators to it.
- The **Find by** value from imported workflows is ignored because the form exposes a single selector field.

<!-- operator:upload-file -->

## Upload file

Attaches files to an upload control from a picker, a workflow variable, the newest download, or a specific path. [Automa reference](https://www.goautoma.com/extension/docs/blocks/upload-file.html)

### Settings

| Field                                      | Type     | Default       | Notes                                                                                         |
| ------------------------------------------ | -------- | ------------- | --------------------------------------------------------------------------------------------- |
| Upload source                              | Select   | `user-select` | `user-select`, `workflow-file`, `latest-download`, or `file-path`.                            |
| Accepted file types                        | Text     | —             | MIME types or extensions, for example `image/*,.pdf`.                                         |
| Variable holding the file                  | Text     | —             | Variable name for `workflow-file`; accepts a data URL, an artifact, or an array of artifacts. |
| File path in the download folder           | Text     | —             | Relative path for `file-path`. Accepts `{{variables}}`.                                       |
| File name pattern                          | Text     | —             | Glob used to pick the newest match for `latest-download`.                                     |
| Ask me to pick a file when nothing matches | Checkbox | Off           | Fall back to the picker when no download matches.                                             |
| Find by                                    | Select   | `cssSelector` | `cssSelector` or `xpath`.                                                                     |
| Selector                                   | Text     | —             | Locator for the upload control. Accepts `{{variables}}`.                                      |
| Allow multiple files                       | Checkbox | Off           | Hidden for `latest-download` and `file-path`.                                                 |
| Wait for selector before uploading         | Checkbox | Off           | Poll for the control before attaching.                                                        |
| Selector timeout (ms)                      | Number   | `10000`       | Poll window used when **Wait for selector before uploading** is on.                           |
| Verify files reached the upload control    | Checkbox | On            | Inspect the control after attaching and fail when the files are missing.                      |

### Outputs

- `{{lastUploadResult}}` always receives `{ nodeId, selector, sourceMode, count, files? }`, describing the control and the attached files.
- There is no custom output-variable field for this operator.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- `user-select` shows Browser Copilot's own file card during the run; `workflow-file` reads a file already produced by an earlier step; `latest-download` scans the configured download folders and their subfolders for the newest match; `file-path` names one file relative to those folders.
- **Verify files reached the upload control** is on by default. The step fails when the control reports fewer files than expected or a different MIME type.
- The target must be a file input, or a control the page kernel can associate with one; otherwise the step fails instead of silently doing nothing.
- The result object is always published under `lastUploadResult`; later steps reference it directly.

<!-- operator:hover-element -->

## Hover element

Moves the pointer over the first element matched by the locator. [Automa reference](https://www.goautoma.com/extension/docs/blocks/hover-element.html)

### Settings

| Field                         | Type     | Default       | Notes                                                   |
| ----------------------------- | -------- | ------------- | ------------------------------------------------------- |
| Find by                       | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                      |
| Selector                      | Text     | —             | Locator for the target. Accepts `{{variables}}`.        |
| Select multiple elements      | Checkbox | Off           | Shared locator option; only the first match is hovered. |
| Wait for selector             | Checkbox | Off           | Poll for the element before hovering.                   |
| Selector timeout (ms)         | Number   | `5000`        | Poll window used when **Wait for selector** is on.      |
| Mark the element on execution | Checkbox | Off           | Highlights the target during the run.                   |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The operator dispatches `pointerover`, `mouseover`, and `mousemove` inside the page. JavaScript hover handlers run, but browser-native tooltips and CSS `:hover` styling are not guaranteed to appear.
- A menu that opens only on native pointer movement may need a click or a **JavaScript code** step instead.

<!-- operator:save-assets status:not-implemented -->

## Save assets

Would download a media element or a direct URL, but the operator is not implemented. [Automa reference](https://www.goautoma.com/extension/docs/blocks/save-assets.html)

### Settings

| Field                    | Type     | Default       | Notes                                                 |
| ------------------------ | -------- | ------------- | ----------------------------------------------------- |
| Type                     | Select   | `element`     | `element` uses the locator; `url` uses the URL field. |
| Find by                  | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`, for `element`.     |
| Selector                 | Text     | —             | Locator for the media element.                        |
| URL                      | Text     | —             | Direct asset URL for `url`.                           |
| Filename (optional)      | Text     | —             | Suggested file name.                                  |
| On conflict              | Select   | `uniquify`    | `uniquify`, `overwrite`, or `prompt`.                 |
| Save items' download IDs | Checkbox | Off           | Would publish download IDs; see the notes.            |
| Assign to variable       | Checkbox | Off           | Shown when download IDs are on.                       |
| Variable name            | Text     | —             | Shown when download IDs are on.                       |

### Outputs

No output. The executor returns without writing a variable, a data column, or a file.

### Browser Copilot notes

- **Not implemented.** The executor emits an informational notice and continues; nothing is downloaded, and the filename, conflict policy, and download-ID options have no effect.
- Use **Save to local** to write text or bytes to a file, **Export data** to write a table, or a download flow plus **Handle download** when the page itself produces the file.
- Do not generate or rely on this operator for downloads until it is implemented.

<!-- operator:press-key -->

## Press key

Sends a key or a key combination to the focused control or to a chosen element. [Automa reference](https://www.goautoma.com/extension/docs/blocks/press-key.html)

### Settings

| Field                     | Type     | Default     | Notes                                                                                |
| ------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------ |
| Target element (Optional) | Text     | —           | CSS selector or XPath for the element to focus first.                                |
| Action                    | Select   | `press-key` | `press-key` types one key or combination; `multiple-keys` shows the free-text field. |
| Key                       | Text     | —           | Key or combination, for example `Enter`, `a`, or `Control+A`.                        |
| Keys                      | Textarea | —           | Free-text keys for `multiple-keys`; both fields feed the same key string.            |
| Press time (milliseconds) | Number   | `0`         | Stored with the operator; see the notes.                                             |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- Without a target, the key goes to whatever the page has focused. With a target, the operator focuses that element first.
- The page kernel dispatches `keydown`, `keypress`, and `keyup`. Pressing `Enter` on a control inside a form also submits the form.
- **Press time** is stored but ignored; the key events are dispatched immediately.
- Modifier combinations use `+`, for example `Control+Shift+Enter`.

<!-- operator:create-element -->

## Create element

Injects HTML, CSS, and optional JavaScript into the page. [Automa reference](https://www.goautoma.com/extension/docs/blocks/create-element.html)

### Settings

| Field                  | Type     | Default       | Notes                                                            |
| ---------------------- | -------- | ------------- | ---------------------------------------------------------------- |
| Find by                | Select   | `cssSelector` | `cssSelector`, `xpath`, or `text`.                               |
| Selector               | Text     | `body`        | Target element. Accepts `{{variables}}`.                         |
| Wait for selector      | Checkbox | Off           | Poll for the target before injecting.                            |
| Selector timeout (ms)  | Number   | `5000`        | Poll window used when **Wait for selector** is on.               |
| Insert element         | Select   | `after`       | `before`, `after`, `prev-sibling`, `next-sibling`, or `replace`. |
| Run before page loaded | Checkbox | Off           | Stored with the operator; see the notes.                         |
| HTML                   | Textarea | —             | Markup to create. Accepts `{{variables}}`.                       |
| CSS                    | Textarea | —             | Styles injected into the page.                                   |
| JavaScript             | Textarea | —             | Script run for each created element.                             |
| Preload scripts        | List     | Empty         | URL and type (`script` or `style`) per entry.                    |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The executor forwards the HTML, CSS, and JavaScript, but not the target selector or **Insert element**. Created markup is appended to `document.body`; CSS is added as a style element.
- **Run before page loaded** and **Preload scripts** are stored but not applied by this build.
- The JavaScript runs once per created element with that element as `this`, and can read variables through `automaRefData()`.
- Because the target selector is ignored, this operator is best for adding a banner, overlay, or helper element to the end of the page, not for inserting beside a specific node.

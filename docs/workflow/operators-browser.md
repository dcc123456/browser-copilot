# Browser operators

These operators work with tabs, windows, navigation, downloads, dialogs, cookies, and page capture. They either change which page the workflow is driving or read browser-level state that is not part of the DOM.

All data fields accept `{{variables}}`. The common **Description**, **Disable block**, **Timeout**, and **On error** settings apply to every node and are not repeated in the tables below. Fields that are stored but ignored by the current executor are called out in each operator's notes.

<!-- operator:active-tab -->

## Active tab

Records the browser's active tab as the tab the workflow is working with. [Automa reference](https://www.goautoma.com/extension/docs/blocks/active-tab.html)

### Settings

| Field         | Type     | Default | Notes                                              |
| ------------- | -------- | ------- | -------------------------------------------------- |
| Disable block | Checkbox | Off     | Standard setting; skips this operator at run time. |

### Outputs

- `{{lastActiveTab}}` receives `{ id, url, title, active }` for the active tab.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The operator reads the active tab but does not change the run's tab pin. Use **Switch tab** when later steps must move to a specific tab.
- There is no output-variable field for this operator; the result is always stored under `lastActiveTab`.
- It has no editable settings beyond the standard block options.

<!-- operator:new-tab -->

## New tab

Opens a URL in a new tab and makes it the tab the workflow drives. [Automa reference](https://www.goautoma.com/extension/docs/blocks/new-tab.html)

### Settings

| Field                        | Type     | Default | Notes                                                                               |
| ---------------------------- | -------- | ------- | ----------------------------------------------------------------------------------- |
| New tab URL                  | Text     | —       | Protocol plus address. An empty address opens a blank tab. Accepts `{{variables}}`. |
| Update previously opened tab | Checkbox | Off     | Reuse the tab opened by the previous **New tab** step instead of creating another.  |
| Wait until the tab is loaded | Checkbox | Off     | Wait for the tab to reach `complete` before continuing.                             |
| Set as active tab            | Checkbox | On      | Stored with the operator; see the notes.                                            |
| Add tab to a group           | Checkbox | Off     | Stored with the operator; see the notes.                                            |
| Use custom User-Agent        | Checkbox | Off     | Stored with the operator; see the notes.                                            |
| User-Agent                   | Text     | —       | Only shown when the custom User-Agent option is on.                                 |
| Tab zoom                     | Range    | `1`     | Stored with the operator; see the notes.                                            |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The tab is always created active, so **Set as active tab** currently has no effect. **Add tab to a group**, the custom User-Agent, and **Tab zoom** are stored but not applied.
- **Update previously opened tab** reuses only the tab created by this block's previous run and switches its URL when one is provided. If that tab was closed, a new tab is created.
- The step pins the run to the new tab. If **Wait until the tab is loaded** is off, a following read should use **Wait for selector** or poll for its own content.

<!-- operator:switch-tab -->

## Switch tab

Brings an open tab selected by pattern, title, position, or index to the foreground and makes it the workflow's tab. [Automa reference](https://www.goautoma.com/extension/docs/blocks/switch-tab.html)

### Settings

| Field                      | Type     | Default          | Notes                                                                  |
| -------------------------- | -------- | ---------------- | ---------------------------------------------------------------------- |
| Find tab by                | Select   | `match-patterns` | `match-patterns`, `tab-title`, `next-tab`, `prev-tab`, or `tab-index`. |
| Match patterns             | Text     | —                | Glob matched against the tab URL, for example `https://example.com/*`. |
| Tab title                  | Text     | —                | Substring matched against the tab title.                               |
| Create if there's no match | Checkbox | Off              | Create a tab when pattern or title matching finds nothing.             |
| New tab URL                | Text     | —                | Address used by **Create if there's no match**.                        |
| Index                      | Number   | `0`              | Zero-based tab index for `tab-index`.                                  |
| Set as active tab          | Checkbox | On               | Focus the tab in the browser in addition to retargeting the workflow.  |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- Tab indexes are zero-based and follow ascending tab id within the run's window, not visual order.
- Match patterns are glob patterns. Tab titles are matched by case-sensitive substring. **Next tab** and **Previous tab** are relative to the tab the run is driving and wrap around.
- Unchecking **Set as active tab** still retargets the run to the matched tab; it only avoids taking focus from the user.
- **Create if there's no match** needs a non-empty URL; without one, a missing match fails the step.

<!-- operator:new-window -->

## New window

Opens a new browser window and points the workflow at it. [Automa reference](https://www.goautoma.com/extension/docs/blocks/new-window.html)

### Settings

| Field                      | Type     | Default  | Notes                                                    |
| -------------------------- | -------- | -------- | -------------------------------------------------------- |
| Type                       | Select   | `normal` | `normal`, `popup`, or `panel`.                           |
| URL (optional)             | Text     | —        | Address to open. Accepts `{{variables}}`.                |
| Window state               | Select   | `normal` | `normal`, `minimized`, `maximized`, or `fullscreen`.     |
| Set as an incognito window | Checkbox | Off      | Requires the extension's incognito permission.           |
| Top                        | Number   | `0`      | Screen position; `0` leaves the position to the browser. |
| Left                       | Number   | `0`      | Screen position; `0` leaves the position to the browser. |
| Height                     | Number   | `0`      | `0` lets the browser choose.                             |
| Width                      | Number   | `0`      | `0` lets the browser choose.                             |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- Only the URL is forwarded to the browser. **Type**, **Window state**, the incognito flag, and the position and size fields are stored but not applied by this build.
- The run's window and tab are retargeted to the new window, so later steps act inside it.
- The default `0` geometry means "let the browser decide"; it does not mean a zero-sized window.

<!-- operator:proxy status:mv3-unsupported -->

## Proxy

Routes browser traffic through a proxy in Automa, but is unavailable in Browser Copilot's Manifest V3 build. [Automa reference](https://www.goautoma.com/extension/docs/blocks/proxy.html)

### Settings

| Field             | Type     | Default | Notes                                                |
| ----------------- | -------- | ------- | ---------------------------------------------------- |
| Host              | Text     | —       | Proxy host, for example `socks5://1.2.3.4:1080`.     |
| Port              | Number   | `443`   | Proxy port.                                          |
| Bypass list       | Textarea | —       | Comma-separated hosts that skip the proxy.           |
| Clear all proxies | Checkbox | Off     | Would remove the configured proxy.                   |
| Scheme            | Text     | `https` | Stored with the operator; not exposed by the editor. |

### Outputs

No output. The step fails before producing a value.

### Browser Copilot notes

- **Not supported under Manifest V3.** The `chrome.proxy` API is unavailable and the extension declares no `proxy` permission, so the executor throws instead of pretending to route traffic.
- The step failing is intentional: a workflow that exists to hide its network origin must not report success while connecting directly.
- The settings are kept only so imported Automa workflows keep their data. Changing them cannot make the operator work.
- Run the workflow without this operator, or use an external proxy at the browser or system level.

<!-- operator:go-back -->

## Go back

Navigates the workflow's tab back one entry in browser history. [Automa reference](https://www.goautoma.com/extension/docs/blocks/go-back.html)

### Settings

| Field         | Type     | Default | Notes                                              |
| ------------- | -------- | ------- | -------------------------------------------------- |
| Disable block | Checkbox | Off     | Standard setting; skips this operator at run time. |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The navigation is issued on the tab the workflow is driving, not necessarily the tab that is visible.
- The step returns after issuing the navigation; a following read should poll for its selector, and a following action should use **Wait for selector**.
- The tab must have a previous history entry; otherwise the browser reports an error and the step fails.

<!-- operator:forward-page -->

## Go forward

Navigates the workflow's tab forward one entry in browser history. No upstream Automa page.

### Settings

| Field         | Type     | Default | Notes                                              |
| ------------- | -------- | ------- | -------------------------------------------------- |
| Disable block | Checkbox | Off     | Standard setting; skips this operator at run time. |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- This operator exists in Browser Copilot for symmetry with **Go back**; the upstream documentation has no page for it.
- It calls the browser's forward navigation on the run's tab and does not wait for the page to finish loading.
- The tab must have a forward history entry, which usually means **Go back** ran earlier in the same tab.

<!-- operator:close-tab -->

## Close tab/window

Closes the tab the workflow is driving and follows the tab the browser focuses in its place. [Automa reference](https://www.goautoma.com/extension/docs/blocks/close-tab.html)

### Settings

| Field             | Type     | Default | Notes                                               |
| ----------------- | -------- | ------- | --------------------------------------------------- |
| Close             | Select   | `tab`   | `tab` or `window`.                                  |
| Close active tab  | Checkbox | On      | Close the run's active tab.                         |
| Match patterns    | Text     | —       | URL pattern shown when **Close active tab** is off. |
| Close all windows | Checkbox | Off     | Shown for `window`.                                 |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- This build ignores **Close**, the match pattern, and **Close all windows**: it always closes the active tab of the run's window.
- After closing, the run is pinned to the tab the browser activates next, so later steps do not keep pointing at a dead tab id.
- Closing the last tab of a window closes that window as well.

<!-- operator:take-screenshot -->

## Take screenshot

Captures the visible page, the full page, or one element and stores the image. [Automa reference](https://www.goautoma.com/extension/docs/blocks/take-screenshot.html)

### Settings

| Field                       | Type     | Default | Notes                                                                |
| --------------------------- | -------- | ------- | -------------------------------------------------------------------- |
| Take a screenshot of        | Select   | `page`  | `page` (visible area), `fullpage`, or `element`.                     |
| CSS Selector                | Text     | —       | Locator for `element`. Accepts `{{variables}}`.                      |
| Image quality (100%)        | Range    | `100`   | JPEG quality; only shown and applied for visible-page JPEG captures. |
| Save screenshot to computer | Checkbox | On      | Write the image to a file.                                           |
| File name                   | Text     | —       | Base name for the saved file. Accepts `{{variables}}`.               |
| Type                        | Select   | `png`   | `png` or `jpeg` for saved visible-page captures.                     |
| Insert screenshot to table  | Checkbox | Off     | Append the image as a data URL in the chosen column.                 |
| Select column               | Text     | —       | Column used when **Insert screenshot to table** is on.               |
| Assign to variable          | Checkbox | Off     | Publish the image under a custom variable name.                      |
| Variable name               | Text     | —       | Custom output name.                                                  |

### Outputs

- `{{lastScreenshot}}` when **Variable name** is empty, otherwise `{{<name>}}`. The image is a data URL.
- `{{lastScreenshotPath}}` receives the file name when **Save screenshot to computer** succeeds.
- With **Insert screenshot to table**, the data URL is appended to the chosen column.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- Full-page and element captures are always PNG. Choosing JPEG for those modes saves a `.png` file and logs a warning; JPEG quality applies only to visible-page captures.
- Saving to disk uses the configured download folder first, then the side-panel save picker, then the unattended folder `browser-copilot-downloads/` inside extension storage.
- Storing screenshots in a data column makes the workflow's data table large; prefer **Save screenshot to computer** for full-page images.
- The visible-page capture restores a minimized window when necessary, and a failed capture surfaces the underlying browser error.

<!-- operator:read-page -->

## Read page

Reads the active tab's visible text, selected text, or HTML into a variable and optionally the data table. No upstream Automa page.

### Settings

| Field              | Type     | Default | Notes                                                                        |
| ------------------ | -------- | ------- | ---------------------------------------------------------------------------- |
| Read               | Select   | `text`  | `text` (visible text), `selection`, or `html`.                               |
| Element (optional) | Text     | —       | CSS selector that scopes text or HTML reads; empty reads the whole document. |
| Max characters     | Number   | `20000` | Caps the returned string; a trimmed body logs an informational message.      |
| Assign to variable | Checkbox | Off     | Publish the result under a custom variable name.                             |
| Variable name      | Text     | —       | Custom output name for the result.                                           |
| Insert to table    | Checkbox | Off     | Write the result into the data table.                                        |
| Select column      | Text     | —       | Column that receives the result.                                             |

### Outputs

- `{{lastReadPage}}` when **Variable name** is empty, otherwise `{{<name>}}`. `lastReadPage` is updated in both cases.
- With **Insert to table**, one value is written per run, or one per loop iteration.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- This operator is specific to Browser Copilot; Automa has no equivalent page.
- `selection` ignores the element scope and reads the user's current selection. An empty selection logs an error but does not fail the step.
- `html` returns `outerHTML` for the scoped element or the whole document, capped by **Max characters**.
- Empty text or element-scoped HTML reads fail the step, the same way **Get text** does.

<!-- operator:browser-event status:placeholder -->

## Browser event

Would pause until a tab, network, or download event fires, but the operator is a placeholder in this build. [Automa reference](https://www.goautoma.com/extension/docs/blocks/browser-event.html)

### Settings

| Field                   | Type     | Default      | Notes                                                   |
| ----------------------- | -------- | ------------ | ------------------------------------------------------- |
| Event                   | Select   | `tab:loaded` | Tab, network, or download event from the editor's list. |
| Timeout (ms)            | Number   | `10000`      | Stored with the operator; see the notes.                |
| Set as active tab       | Checkbox | On           | Tab events only.                                        |
| Wait for tab URL        | Text     | —            | URL pattern for `tab:loaded`.                           |
| Download filename query | Text     | —            | Filename substring for `download:created`.              |

### Outputs

No output. The executor returns immediately after logging a notice.

### Browser Copilot notes

- **Placeholder.** The executor neither subscribes to browser events nor waits; the step completes as soon as it starts.
- **Timeout**, **Set as active tab**, and the filters are stored but have no effect.
- Use **Delay** plus a read or **Element exists** when you need to wait for page state, and **Handle download** when you need the resulting file.

<!-- operator:handle-dialog -->

## Handle dialog

Installs handlers that accept or dismiss the page's JavaScript dialogs. [Automa reference](https://www.goautoma.com/extension/docs/blocks/handle-dialog.html)

### Settings

| Field                  | Type     | Default | Notes                                                  |
| ---------------------- | -------- | ------- | ------------------------------------------------------ |
| Accept dialog          | Checkbox | On      | Accept rather than dismiss `confirm()` dialogs.        |
| Prompt text (optional) | Text     | —       | Answer used by `prompt()`; only shown while accepting. |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The operator patches the page's dialog handlers for later dialogs: `confirm()` returns the accept value, `prompt()` returns the configured text when one is set, and `beforeunload` prompts are suppressed.
- It does not dismiss an `alert()` that is already open, because page scripts cannot run while a native dialog blocks the page.
- A page that freezes or redefines its dialog functions may not be patchable; the step still reports success, so verify the next action when a dialog is critical.

<!-- operator:handle-download -->

## Handle download

Waits for a browser download and stores its details. [Automa reference](https://www.goautoma.com/extension/docs/blocks/handle-download.html)

### Settings

| Field                              | Type     | Default    | Notes                                                          |
| ---------------------------------- | -------- | ---------- | -------------------------------------------------------------- |
| Timeout (milliseconds)             | Number   | `20000`    | How long to look for a matching download.                      |
| File download ID (optional)        | Text     | —          | Stored with the operator; see the notes.                       |
| File name (optional)               | Text     | —          | Substring matched against the downloaded file's full path.     |
| On conflict                        | Select   | `uniquify` | Stored with the operator; see the notes.                       |
| Wait for the file to be downloaded | Checkbox | On         | Poll until a matching download appears or the timeout expires. |
| Assign to variable                 | Checkbox | Off        | Publish the record under a custom variable name.               |
| Variable name                      | Text     | —          | Custom output name.                                            |

### Outputs

- `{{lastDownload}}` when **Variable name** is empty, otherwise `{{<name>}}`.
- The value is `{ id, filename, url }` for the match, or `null` when none appears within the timeout.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- Matching is a filename substring test. With no file name, the most recent download returned by the browser is used.
- **File download ID** and **On conflict** are stored but not used; the operator only records metadata and never renames, moves, or deletes a file.
- A missing download is not an error: the output is `null`, so a following condition can branch on it.

<!-- operator:save-local -->

## Save to local

Writes interpolated text to a local file. No upstream Automa page.

### Settings

| Field                       | Type   | Default         | Notes                                                                                                |
| --------------------------- | ------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| Content                     | Text   | —               | Text to write. Accepts `{{variables}}`.                                                              |
| Filename (with extension)   | Text   | —               | File name, including its extension. An empty name falls back to `file.txt`. Accepts `{{variables}}`. |
| Save mode                   | Select | `auto`          | `auto`, `force`, or `manual`; see the notes.                                                         |
| Variable name (output path) | Text   | `lastSavedPath` | Variable that receives the saved file name.                                                          |

### Outputs

- `{{lastSavedPath}}`, or the custom **Variable name**, receives the file name when a file is written.
- The variable is left unchanged when the save is canceled or fails.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- This operator is specific to Browser Copilot; Automa has no equivalent page.
- **Save mode** is stored but not applied by this build. The writer uses the configured download folder first, then the side-panel save picker, then the unattended folder `browser-copilot-downloads/` inside extension storage.
- Empty content fails the step. A value whose references resolved to an empty string also fails, so the operator never writes a zero-byte file by accident.
- Use **Export data** for tables and **Save assets** for media; this operator writes text only.

<!-- operator:reload-tab -->

## Reload tab

Reloads the workflow's tab, or navigates it to a URL when one is set. [Automa reference](https://www.goautoma.com/extension/docs/blocks/reload-tab.html)

### Settings

| Field          | Type | Default | Notes                                                                                                 |
| -------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------- |
| URL (optional) | Text | —       | Empty reloads the current page; a value loads that address in the run's tab. Accepts `{{variables}}`. |

### Outputs

No output. One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- An empty URL reloads the tab the run is driving, not whichever tab happens to be visible.
- A non-empty URL navigates that same tab and waits for the new document; it does not open a second tab. Use **New tab** for that.
- After a reload, a following read should poll for its selector because the page renders again.

<!-- operator:tab-url -->

## Get tab URL

Reads the URL of the active tab or of every tab in the window. [Automa reference](https://www.goautoma.com/extension/docs/blocks/tab-url.html)

### Settings

| Field                     | Type     | Default      | Notes                                                                      |
| ------------------------- | -------- | ------------ | -------------------------------------------------------------------------- |
| Select tab                | Select   | `active-tab` | `active-tab` returns one URL; `all` returns every tab in the run's window. |
| Match Patterns (optional) | Text     | —            | Stored with the operator for `all`; see the notes.                         |
| Tab title (optional)      | Text     | —            | Stored with the operator for `all`; see the notes.                         |
| Assign to variable        | Checkbox | Off          | Publish the URL under a custom variable name.                              |
| Variable name             | Text     | —            | Custom output name.                                                        |

### Outputs

- `{{lastTabUrl}}` when **Variable name** is empty, otherwise `{{<name>}}`.
- `active-tab` returns one URL string. `all` returns the URLs joined with newlines.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- The optional match-pattern and title filters are stored but ignored by this build; `all` always returns every tab in the run's window.
- Only the URL is returned, not the title or tab id. Use **Active tab** when you need the tab object.
- There is no data-column field in the editor; the result is a variable only.

<!-- operator:cookie -->

## Cookie

Gets, sets, or removes browser cookies. [Automa reference](https://www.goautoma.com/extension/docs/blocks/cookie.html)

### Settings

| Field                               | Type     | Default | Notes                                                 |
| ----------------------------------- | -------- | ------- | ----------------------------------------------------- |
| Action                              | Select   | `get`   | `get`, `set`, or `remove`.                            |
| Get all cookies                     | Checkbox | Off     | Read every cookie instead of one named cookie.        |
| Use JSON format                     | Checkbox | Off     | Store the cookie operation as JSON; see the notes.    |
| URL                                 | Text     | —       | Cookie URL. Required for `set` and `remove`.          |
| Name                                | Text     | —       | Cookie name. Required for `get`, `set`, and `remove`. |
| Value (optional)                    | Text     | —       | Value written by `set`. Accepts `{{variables}}`.      |
| Path (optional)                     | Text     | —       | Stored with the operator; see the notes.              |
| Domain (optional)                   | Text     | —       | Stored with the operator; see the notes.              |
| sameSite (optional)                 | Text     | —       | Stored with the operator; see the notes.              |
| expirationDate (seconds) (optional) | Text     | —       | Expiry used by `set`; empty means a session cookie.   |
| httpOnly                            | Checkbox | Off     | Stored with the operator; see the notes.              |
| secure                              | Checkbox | Off     | Stored with the operator; see the notes.              |
| Assign to variable                  | Checkbox | Off     | Publish a read under a custom variable name.          |
| Variable name                       | Text     | —       | Custom output name for `get`.                         |

### Outputs

- `get`: `{{lastCookie}}` when **Variable name** is empty, otherwise `{{<name>}}`, containing the cookie value or an empty string.
- `get` with **Get all cookies**: the variable receives an array of cookie objects.
- `set` and `remove`: no output.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- Only the URL, name, value, and expiration date are forwarded to the browser API. **Path**, **Domain**, **sameSite**, **httpOnly**, **secure**, **session**, and the JSON editor are stored but not applied by this build.
- `set` and `remove` require a URL; `remove` also requires the name.
- Reading a cookie that does not exist stores an empty string rather than failing, so check the value before depending on it.

<!-- operator:ocr status:requires-ocr -->

## OCR text recognition

Runs local Tesseract.js OCR on an image variable, a page element, or the previous page snapshot. No upstream Automa page. This operator exists only in Browser Copilot.

### Settings

| Field                                         | Type     | Default          | Notes                                                                  |
| --------------------------------------------- | -------- | ---------------- | ---------------------------------------------------------------------- |
| Input image                                   | Select   | `page`           | `variable`, `element`, or `page` (the previous visible-page snapshot). |
| Image variable (data URL / base64 / link)     | Text     | `lastScreenshot` | Variable read by `variable`.                                           |
| CSS Selector                                  | Text     | —                | Element read by `element`; an `img`, `canvas`, or text-less container. |
| Language (empty = global setting)             | Text     | —                | Tesseract language codes joined with `+`, for example `eng+chi_sim`.   |
| Enhance image before OCR (upscale + contrast) | Checkbox | On               | Preprocess the image; failures fall back to the original.              |
| Output variable (type: string)                | Text     | `lastOcrText`    | Variable that receives the recognized text.                            |

### Outputs

- `{{lastOcrText}}` when **Output variable** is empty, otherwise `{{<name>}}`. The value is always a string.
- An empty recognition result fails the step with diagnostics about the capture, language, and preprocessing.
- One main output port; errors follow the block's **On error** policy.

### Browser Copilot notes

- **Full OCR build only.** The no-OCR variant compiles without Tesseract.js (`OCR_SUPPORTED` is false); the editor disables the operator and the executor refuses to run it.
- OCR runs locally with Tesseract.js and local language data; images are not uploaded anywhere.
- The element source uses a CSS selector only. The imported **Find by** value is ignored, and an XPath expression will not resolve.
- Empty **Language** uses the global **Local OCR language** setting. A missing language pack fails recognition rather than falling back silently.

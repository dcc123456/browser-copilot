# Data operators

Data operators work on what a workflow carries between steps: the run's data table, individual variables, and spreadsheet files. They read and write values without touching the page. The shared rules for variables, interpolation, the data table, and the download folder live in [Workflow concepts](concepts.md); the common **Description**, **Disable block**, **Timeout**, and **On error** settings apply to every node and are not repeated below.

<!-- operator:insert-data -->

## Insert data

Adds records to the run's data table or writes a value into a variable. [Automa reference](https://www.goautoma.com/extension/docs/blocks/insert-data.html)

### Settings

| Field         | Type   | Default | Notes                                                                                                                          |
| ------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Row type      | Select | `table` | `table` fills a column; `variable` writes a variable. The selector is unlabelled and sits at the start of each row.            |
| Table column  | Text   | —       | Column that receives the value. Shown for `table` rows; type the column id or name because the editor has no live column list. |
| Variable name | Text   | —       | Variable that receives the value. Shown for `variable` rows.                                                                   |
| Value         | Text   | —       | Interpolated, then written. Supports `{{variables}}`.                                                                          |

### Outputs

- A `table` row writes its value into that column on every row that already exists. On an empty table it creates one row first; it never adds rows per item.
- A `variable` row creates or replaces the variable.
- A record-shaped item such as `{"sku": "A-1"}` is appended as a new row. Generated workflows use this shape; the form does not produce it.
- No output variable of its own. One main output port.

### Browser Copilot notes

- The stored list may also be a JSON string; imported workflows use that form and it is parsed the same way.
- A stored `action: "append"` concatenates onto the variable's current value instead of replacing it. Only imported nodes carry that flag; the form always replaces.
- The file-import fields (`filePath`, `isFile`) are kept for imported workflows but are not applied by this build; the form states that file import is unsupported.
- Rows are edited in an **Insert data** modal, one block per row, with **Add** and a bin icon per row.

<!-- operator:delete-data -->

## Delete data

Removes columns from the data table or deletes variables. [Automa reference](https://www.goautoma.com/extension/docs/blocks/delete-data.html)

### Settings

| Field         | Type   | Default         | Notes                                                                                       |
| ------------- | ------ | --------------- | ------------------------------------------------------------------------------------------- |
| Data from     | Select | `table`         | `Table` targets the data table; `Variable` targets one variable.                            |
| Column        | Select | `[All columns]` | `[All columns]` empties the table; `Column` reveals a text field for the column id or name. |
| Column (name) | Text   | —               | Column to remove from every row. Shown only after choosing `Column`.                        |
| Variable name | Text   | —               | Variable to delete. Shown instead of **Column** for `Variable` entries.                     |

### Outputs

No output variable. One main output port; the run log reports how many columns and variables were removed.

### Browser Copilot notes

- `[All columns]` replaces `dataTable` with an empty array, so the rows go away as well. Removing a named column keeps the rows and strips only that field.
- Each entry is its own row with a remove button; an empty list is a no-op and the log says no delete entry was configured.
- Deleting a variable that does not exist is skipped silently. Deleting a column that no row has is also counted as done.

<!-- operator:log-data -->

## Get log data

Collects the current run's log as text and stores it in a variable and, optionally, in a data-table column. [Automa reference](https://www.goautoma.com/extension/docs/blocks/log-data.html)

### Settings

| Field                  | Type     | Default | Notes                                                                                                              |
| ---------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Workflow (workflow id) | Text     | —       | Keep empty. Only the current run's log exists in this build; a value here makes the step fail.                     |
| Assign to a variable   | Checkbox | Off     | Publish the transcript under a variable name.                                                                      |
| Variable name          | Text     | —       | Output variable. Shown when **Assign to a variable** is on.                                                        |
| Insert to table        | Checkbox | On      | Stored by the operator. A row is written only when a column name is set.                                           |
| Select column          | Text     | —       | Column that receives the transcript as one new row. The form shows this field only after a workflow id is entered. |

### Outputs

- `{{<name>}}` with the run log, when **Assign to a variable** is on.
- One appended row `{ <column>: <log> }` when **Insert to table** is on and a column is named.
- No fallback variable such as `lastLog` is written. One main output port.

### Browser Copilot notes

- The transcript is the lines emitted so far in this run, joined with newlines. Steps after this node are not included.
- A non-empty workflow id fails the step with an explanation that past runs are not stored in either host. The editor has no workflow list, so the id field is a stub: leave it blank.
- The log is also echoed to the run log, so a node that only needs to mark progress can leave both outputs off.

<!-- operator:slice-variable -->

## Slice variable

Takes a segment of a string variable or a sub-array of an array variable. [Automa reference](https://www.goautoma.com/extension/docs/blocks/slice-variable.html)

### Settings

| Field                | Type     | Default | Notes                                                           |
| -------------------- | -------- | ------- | --------------------------------------------------------------- |
| Variable name        | Text     | —       | Variable to slice. It is also where the result is written back. |
| Start index          | Checkbox | On      | Enables the start offset. Off means start at `0`.               |
| Start index (number) | Number   | `0`     | Offset where the segment begins.                                |
| End index            | Checkbox | Off     | Enables the end offset. Off means slice to the end.             |
| End index (number)   | Number   | `0`     | Exclusive offset where the segment stops.                       |

### Outputs

- The segment is stored back into the same variable; there is no separate output-name field. A string yields a substring, an array a shorter array.
- One main output port.

### Browser Copilot notes

- Indices follow JavaScript `slice` semantics: a negative index counts from the end, and an end before the start yields an empty value.
- A missing variable, or one holding a number or object, fails the step instead of producing an empty string.
- Imported nodes that carry only `start` / `end` are still read; a legacy `end` with no toggle means "use the end index".

<!-- operator:increase-variable -->

## Increase variable

Adds a fixed amount to a numeric variable, starting from zero when the variable does not exist yet. [Automa reference](https://www.goautoma.com/extension/docs/blocks/increase-variable.html)

### Settings

| Field         | Type   | Default | Notes                                                                        |
| ------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| Variable name | Text   | —       | Numeric variable to update. Required; an empty name fails the step.          |
| Increase by   | Number | `1`     | Amount to add. It is interpolated, so `{{step}}` from an earlier step works. |

### Outputs

- The same variable, updated. The run log prints `name = value`.
- One main output port.

### Browser Copilot notes

- A variable that is absent starts at `0`, which makes this operator usable as a loop counter without an initialiser.
- A current value that is not numeric collapses to `0` on the way through, because the computed `NaN` is replaced rather than stored. Keep the variable numeric.
- Imported nodes may carry `incType: "multiply"`, which multiplies instead of adding and starts an absent variable at `1`. The form exposes no such switch.

<!-- operator:regex-variable -->

## RegEx variable

Applies a regular expression to a text variable and keeps either the matches or the replaced text. [Automa reference](https://www.goautoma.com/extension/docs/blocks/regex-variable.html)

### Settings

| Field            | Type         | Default | Notes                                                                                        |
| ---------------- | ------------ | ------- | -------------------------------------------------------------------------------------------- |
| Variable name    | Text         | —       | Variable to read. The result is written back to it.                                          |
| Method           | Select       | `match` | `Match value` collects the hits; `Replace value` substitutes them.                           |
| Replace with     | Text         | —       | Replacement text, interpolated. Shown only for `replace`; an empty value deletes each match. |
| RegEx            | Text         | —       | Pattern body without the surrounding slashes. Required.                                      |
| Expression flags | Multi-select | None    | `g`, `i`, and `m` checkboxes, stored as a list and joined at run time.                       |

### Outputs

- With `match`, a JSON text of the hits, for example `["id-1","id-2"]`. The variable holds a string, not an array; use `{{name}}` downstream or parse it with **JavaScript code** if you need indexing.
- With `replace`, the rewritten string.
- Written back to the same variable; there is no separate output-name field. One main output port.

### Browser Copilot notes

- Without the `g` flag only the first hit is collected. With no hit at all the value becomes `[]`.
- An invalid pattern fails the step and leaves the variable untouched, so a later step cannot silently read a stale value.
- A node with no stored flags field at all is read as `g`; an explicitly empty list means no flags.
- **Replace with** is the only interpolated field; the pattern and flags are used literally.

<!-- operator:data-mapping -->

## Data mapping

Renames fields of table rows or of an array held in a variable. [Automa reference](https://www.goautoma.com/extension/docs/blocks/data-mapping.html)

### Settings

| Field                | Type     | Default | Notes                                                                                                                 |
| -------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| Data source          | Select   | `table` | `Table` reads `dataTable`; `Variable` reads the named variable.                                                       |
| Variable name        | Text     | —       | Source variable, shown when **Data source** is `Variable`.                                                            |
| Source               | Text     | —       | Property to rename. One row per source property.                                                                      |
| Destination          | Text     | —       | New property name. A source can list several destinations; the value is copied to each and the source key is removed. |
| Insert to table      | Checkbox | Off     | Stored by the operator; not applied by this build (see notes).                                                        |
| Select column        | Text     | —       | Stored by the operator; not applied by this build (see notes).                                                        |
| Assign to a variable | Checkbox | Off     | Store the mapped array under a variable.                                                                              |
| Variable name        | Text     | —       | Output variable, shown when **Assign to a variable** is on.                                                           |

### Outputs

- The mapped array, written back to the source variable when **Data source** is `Variable`.
- `{{lastMappedData}}` always receives the mapped array.
- `{{<name>}}` when **Assign to a variable** is on.
- One main output port.

### Browser Copilot notes

- With **Data source** = `Table` the mapped rows are **not** written back into the table. Turn on **Assign to a variable** (or read `{{lastMappedData}}`) to keep the result.
- **Insert to table** and **Select column** are persisted so imported workflows keep their settings, but this build performs no table write for them.
- Only top-level properties are renamed. Rows that lack a source property are passed through unchanged, and a destination equal to the source name is ignored.
- The mapping list is edited in a modal with a **Source** column and one or more **Destination** rows per source.

<!-- operator:sort-data -->

## Sort data

Orders the data table or an array held in a variable, optionally by up to three item properties. [Automa reference](https://www.goautoma.com/extension/docs/blocks/sort-data.html)

### Settings

| Field                       | Type     | Default | Notes                                                                                              |
| --------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------- |
| Data source                 | Select   | `table` | `Table` sorts `dataTable`; `Variable` sorts the named variable.                                    |
| Variable name               | Text     | —       | Source variable, shown when **Data source** is `Variable`. The sorted array is written back to it. |
| Sort by the item's property | Switch   | Off     | Off compares the items themselves; on reveals the property rows.                                   |
| Property 1–3                | Text     | —       | Property name to compare by. At most three property rows.                                          |
| Order                       | Select   | `asc`   | `Ascending` or `Descending`, one per property.                                                     |
| Insert to table             | Checkbox | Off     | Stored by the operator; not applied by this build (see notes).                                     |
| Select column               | Text     | —       | Stored by the operator; not applied by this build (see notes).                                     |
| Assign to a variable        | Checkbox | Off     | Also store the sorted array under a variable.                                                      |
| Variable name               | Text     | —       | Output variable, shown when **Assign to a variable** is on.                                        |

### Outputs

- The sorted copy replaces `dataTable` for a table source, or overwrites the source variable for a variable source.
- `{{<name>}}` when **Assign to a variable** is on.
- The run log reports the leading property and the row count.
- One main output port.

### Browser Copilot notes

- With **Sort by the item's property** off, or with no property rows, the whole item is compared directly. That is what a plain list of strings or numbers needs.
- **Insert to table** and **Select column** are persisted but not applied: no column is written by this build. Use **Assign to a variable** to keep the result.
- Property rows are evaluated left to right, so the second property only decides ties left by the first.
- Sorting copies the array first, so the previous order is not mutated mid-run before the result is written.

<!-- operator:set-variable -->

## Set variable

Writes one or more workflow variables in a single step. Browser Copilot-only operator.

### Settings

| Field         | Type | Default       | Notes                                                                                  |
| ------------- | ---- | ------------- | -------------------------------------------------------------------------------------- |
| Variables     | List | One blank row | Each row pairs a variable name with a value. Rows apply from top to bottom.            |
| Variable name | Text | —             | Name to create or replace, per row. A row with an empty name is skipped.               |
| Value         | Text | —             | Text to store. Interpolated, so it may read `{{variables}}` written by an earlier row. |

### Outputs

- Every named variable, holding its row's interpolated text.
- No other output variable. One main output port.

### Browser Copilot notes

- Rows run in order, so `{{token}}` set on row one can be used as `Bearer {{token}}` on row two.
- A node with no named row fails with a message that nothing was set, instead of running as a no-op.
- Values are stored as text. For numbers or arrays, follow this step with **Increase variable**, **Parse Excel**, or **JavaScript code**.
- The form writes the row list and clears the legacy `variableName` / `value` pair; imported nodes that only carry the pair still run it as a single row.

<!-- operator:get-secret -->

## Get secret

Copies stored credential fields into workflow variables at run time. Browser Copilot-only operator.

### Settings

| Field                         | Type   | Default       | Notes                                                                                                                               |
| ----------------------------- | ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Credentials this node fetches | List   | One blank row | One credential field per row, each writing its own variable.                                                                        |
| Credential                    | Select | —             | Entries read `credential label · field key`. Only metadata is listed; no value appears in the editor or the workflow.               |
| Variable name                 | Text   | —             | Output variable for that row. Picking a credential fills it with the field key, for example `apiKey`; a name typed by hand is kept. |

### Outputs

- One variable per row, holding that credential field's value.
- The run log names the field and the target variable and states that the value is hidden.
- One main output port.

### Browser Copilot notes

- Values come from **Settings → Secrets**, which is the credential store described in [Workflow concepts](concepts.md#secrets). Nothing is embedded in the workflow JSON, and rotating a password there takes effect on the next run.
- The stored reference is `credentialId::fieldKey`. A reference with no field key falls back to the entry's `password` field, then to its first field.
- A missing credential, a missing field, or an unnamed output variable fails the step. It never writes an empty string, so a downstream form fill cannot submit a blank password.
- All rows on the node read the credential store once per run, not once per row.
- Downstream steps read the values as ordinary variables, for example `{{password}}`. Keep those variables out of logs and exported files.

<!-- operator:parse-excel -->

## Parse Excel

Reads an `.xlsx` or `.csv` spreadsheet into row objects plus the raw cell grid. Browser Copilot-only operator.

### Settings

| Field                            | Type     | Default            | Notes                                                                                                                                                                                     |
| -------------------------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spreadsheet source               | Select   | `user-select`      | `User picks a file`, `File from an earlier step`, or `Specific file path`.                                                                                                                |
| File path in the download folder | Text     | —                  | For `file-path`. Relative to the configured download folder or the internal downloads folder; subfolders allowed, `{{variables}}` interpolated. **Browse downloads** lists what is there. |
| Variable holding the file        | Text     | —                  | For `workflow-file`. Must hold exactly one spreadsheet artifact or data URL produced by an earlier block.                                                                                 |
| Worksheet name                   | Text     | —                  | Exact sheet name; empty means the first sheet. Applies to `.xlsx` only.                                                                                                                   |
| First row is the header          | Checkbox | On                 | Turn the first row into object keys. The raw array keeps that row either way.                                                                                                             |
| Object rows variable             | Text     | `lastExcelRows`    | Receives an array of objects, one per data row.                                                                                                                                           |
| Raw rows variable                | Text     | `lastExcelRawRows` | Receives the two-dimensional array of typed cells, header row included.                                                                                                                   |

### Outputs

- `{{lastExcelRows}}`, or the name in **Object rows variable**: one object per data row, keyed by the header row.
- `{{lastExcelRawRows}}`, or the name in **Raw rows variable**: the cell grid as parsed, including the header row.
- `{{lastExcelSheet}}`: the sheet that was read. For a CSV this is the file's base name.
- One main output port.

### Browser Copilot notes

- `user-select` opens a file picker during the run, so someone must be present. Unattended runs should use a relative path or a file from an earlier step.
- With **First row is the header** off, keys are `column1`, `column2`, and so on. Empty header cells get the same generated names, and duplicate names get a `_2`, `_3` suffix so no cell is lost.
- Cells are typed: numbers become numbers, date-formatted cells become ISO strings, booleans become booleans, and empty cells become `null`. Fully blank rows are dropped and trailing blank cells are trimmed.
- `.xlsx` is read from its OOXML parts directly, so no spreadsheet library is needed; shared strings, inline strings, styles, one worksheet, and the workbook relationships are supported. `.csv` reads RFC-4180 quoting and detects `,`, `;`, or tab separators, with or without a BOM.
- Legacy `.xls` workbooks and password-protected files are rejected with a message to re-save as `.xlsx` or `.csv`; Zip64 workbooks are rejected too.
- The row limit of the data table does not apply to these variables; the file is parsed into the two variables only, and nothing is written to `dataTable`. Send the rows there with **Insert data** when needed.

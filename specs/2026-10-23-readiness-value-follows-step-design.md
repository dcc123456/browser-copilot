# Stored value expectations follow the step's own value (2026-10-23)

## Symptom

A conversation-generated workflow's Forms (表单输入) step fills
`input.cmp-account-input` with `1414633563@qq.com` — the value the user edited
into the block — and the run still fails every attempt:

```
[表单输入] input.cmp-account-input ← 1414633563@qq.com
ok
Retrying (1/2) after failure: READINESS_TIMEOUT(value-committed):
  控件值尚未提交（期望 "你好"，实际 "1414633563@qq.com"）
[表单输入] input.cmp-account-input ← 1414633563@qq.com
字段内容已是目标值，跳过填写（不清空已填写内容）
```

The value the generation model originally wrote was `你好`. The properties panel
shows `1414633563@qq.com` and contains no `你好` anywhere.

## Root cause

Three pieces compose the bug:

1. **Generation bakes a snapshot.** `generation-pipeline.ts` stage 4
   (`BUILD_RELIABILITY`) calls `autoCompleteReliability`, which copies
   `defaultReadinessFor(blockId, data)` into `node.data.__reliability.readiness`.
   For `forms` / `fill` that table builds
   `after: [{ state: 'value-committed', value: String(data.value) }]` — the
   literal value at generation time (`你好`).
2. **The explicit contract wins forever.** `effectiveReadinessSpec` prefers
   `__reliability.readiness` over the block default, so the run never reaches
   the default table that would have been rebuilt from the current, interpolated
   `params.value`.
3. **The editor never shows or rewrites it.** The workflow editor does not render
   `__reliability` at all. Editing the field updates `data.value` only; the
   stored expectation is invisible and stale.

The executor and the gate therefore disagree: the fill writes the live
`params.value` (email, and reports `字段内容已是目标值` on retries because the
page already holds it), while the after-gate compares the live control against
the frozen `你好`.

The only writer of `__reliability.readiness` in this codebase is
`autoCompleteReliability` (the generation prompt never mentions readiness, and
no `set-readiness` patch is constructed anywhere), so a literal
`value-committed` expectation on a node's own target can only be that
generation-time copy.

## Fix

Runtime re-anchoring, in the shared pure module and applied by
`effectiveReadinessSpec` (the after-action gate):

> A stored AFTER-gate `value-committed` requirement with **no own target** and
> **no `{{token}}`** follows the value the step currently writes.

- "Current value" per block mirrors the default table:
  `forms` / `fill` → `params.value` (not for `action: submit`),
  `select-option` → `params.value`, `set-checkbox` → `String(params.checked ?? true)`.
- A requirement carrying its own `target` describes another control; it is left
  alone.
- A `{{token}}` expectation keeps the existing variable-resolution path
  (`resolveRequirements`), so unresolved-token semantics do not change.
- Blocks without a single written value are untouched.

This fixes already-saved workflows without a migration and without changing the
stored shape. The generated contract stays on the node; the runtime simply
derives the piece that must track the block's own data instead of trusting a
copy of it.

### Non-goals

- No editor UI for `__reliability` (the contract is runtime metadata).
- No change to generation, migration or folding.
- No new readiness states, and no change to `valueCommittedMatches`.

## Tests

- `tests/readiness-engine.spec.ts`: a stale literal (`你好`) on an edited
  `forms` node is replaced by the step's current value; a `set-checkbox`
  expectation follows `checked`; a requirement with its own `target` is not
  rewritten; the existing `{{token}}` and unresolved-token tests stay green.
- `tests/engine-readiness-variables.spec.ts`: the engine-level path (stored
  contract + `vars`) keeps resolving templates, and a stale literal reaches the
  probe as the edited value.

## Verification

`pnpm typecheck`, `TZ=UTC pnpm test`, scoped eslint/prettier on touched files,
`pnpm build`, `pnpm server:typecheck`, `pnpm server:test`, `pnpm bench:debug`.

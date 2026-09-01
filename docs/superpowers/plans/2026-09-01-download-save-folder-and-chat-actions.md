# 下载目录 + 保存算子 + 对话按钮 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作流可通过「保存到本地」算子把数据写入本地文件，支持可配置下载目录与自动保存开关，并调整对话消息按钮为“仅最后一条总回复常显复制/下载/token、用户消息仅复制”。

**Architecture:** 下载目录句柄单独存 IndexedDB（key=`download`），service worker 用已授权句柄直接静默写入实现自动保存；确认另存为由 worker 发消息给侧面板调用 `showSaveFilePicker`。保存决策由纯函数 `resolveTransferMode` 归纳。对话按钮的可见性在 `ChatTab.tsx` 收紧，样式在 `styles.css` 改为常显。

**Tech Stack:** TypeScript, MV3 extension (Chrome runtime), File System Access API, React (side panel), IndexedDB。

---

## 文件结构

- `src/lib/download-dir.ts`（新建）— 下载目录句柄的 IndexedDB 读写、自动保存写入、模式决策纯函数。无 `chrome` 依赖（除类型），便于测试。
- `src/lib/types.ts` — `Settings` 增加 `downloadAutoSave: boolean`。
- `src/lib/storage.ts` — `getSettings` 默认值补 `downloadAutoSave: true`。
- `src/background/workflow-engine/executors.ts` — 新增 `saveLocal` 执行器并注册到 `EXECUTORS` 的 `'save-local'`。
- `src/lib/workflow/registry.ts` — 注册 `save-local` block 元数据（integration 分类）。
- `src/workflow-editor/blocks/batchB/EditSaveLocal.tsx`（新建）— block 表单；`batchB/index.ts` 注册；`EditForms` 路由。
- `src/workflow-editor/i18n.ts` + `block-i18n.ts` — 中英文案。
- `src/background/index.ts` — `onMessage` 对 `download:save-picker` 放行（不误处理）。
- `src/sidepanel/App.tsx` — 侧面板 `onMessage` 监听 `download:save-picker` 并调 `showSaveFilePicker`。
- `src/sidepanel/SettingsTab.tsx` — 新增“下载目录”卡片（选择/更换/断开 + 自动保存开关）。
- `src/sidepanel/ChatTab.tsx` — `MsgActions` 可见性收紧。
- `src/sidepanel/styles.css` — `.msg-actions` 改为常显在消息下方。
- `tests/download-dir.spec.ts`（新建）— 模式决策 + 自动保存写入测试。

---

### Task 1: 下载目录句柄模块 `lib/download-dir.ts`

**Files:**
- Create: `src/lib/download-dir.ts`
- Test: `tests/download-dir.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/download-dir.spec.ts
import { describe, expect, it } from 'vitest'
import {
  resolveTransferMode,
  type SaveMode,
} from '../src/lib/download-dir'

const makeCase = (saveMode: SaveMode, globalAuto: boolean, hasDir: boolean) =>
  resolveTransferMode(saveMode, globalAuto, hasDir)

describe('resolveTransferMode', () => {
  it('force always auto-saves, ignoring global flag', () => {
    expect(makeCase('force', false, true)).toBe('auto')
    expect(makeCase('force', true, true)).toBe('auto')
  })
  it('force without a directory falls back to manual', () => {
    expect(makeCase('force', true, false)).toBe('manual')
  })
  it('manual always confirms', () => {
    expect(makeCase('manual', true, true)).toBe('manual')
    expect(makeCase('manual', false, false)).toBe('manual')
  })
  it('auto follows global flag AND presence of directory', () => {
    expect(makeCase('auto', true, true)).toBe('auto')
    expect(makeCase('auto', true, false)).toBe('manual')
    expect(makeCase('auto', false, true)).toBe('manual')
    expect(makeCase('auto', false, false)).toBe('manual')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/download-dir.spec.ts`
Expected: FAIL — `resolveTransferMode` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/download-dir.ts
/**
 * Download-directory management.
 *
 * The chosen download folder is stored as a `FileSystemDirectoryHandle` in
 * IndexedDB under a dedicated key, separately from the fs-store root, so
 * auto-saved files land in a user-picked folder rather than the storage
 * subfolder. The service worker can write to an already-granted handle, which
 * is what makes silent auto-save from workflow blocks possible.
 *
 * @module lib/download-dir
 */

const IDB_DB = 'browser-copilot-fs'
const IDB_STORE = 'directory'
const IDB_KEY = 'download'

/** User-visible save policy of a `save-local` workflow block. */
export type SaveMode = 'auto' | 'force' | 'manual'

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(IDB_DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

/** The chosen download directory handle, or `null` when not configured. */
export async function getDownloadDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIdb()
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () =>
        resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/** Persist a chosen download directory handle. */
export async function setDownloadDir(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

/** Forget the download directory (back to "ask each time"). */
export async function clearDownloadDir(): Promise<void> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(IDB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Nothing configured — nothing to clear.
  }
}

/**
 * Decide auto-save vs. manual-confirm using the global auto-save flag, whether
 * a directory is configured, and the per-block override. Pure so it is trivial
 * to test.
 */
export function resolveTransferMode(
  saveMode: SaveMode,
  globalAuto: boolean,
  hasDir: boolean,
): 'auto' | 'manual' {
  if (saveMode === 'manual') return 'manual'
  if (saveMode === 'force') return hasDir ? 'auto' : 'manual'
  // 'auto' (follow global)
  return hasDir && globalAuto ? 'auto' : 'manual'
}

/**
 * Write text into a directory handle, overwriting any existing file.
 * Returns whether the write completed.
 */
export async function writeFileToDownloadDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
  text: string,
): Promise<boolean> {
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(text)
    await writable.close()
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/download-dir.spec.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/download-dir.ts tests/download-dir.spec.ts
git commit -m "feat: 下载目录句柄模块与保存模式决策"
```

---

### Task 2: `Settings.downloadAutoSave` 字段

**Files:**
- Modify: `src/lib/types.ts:49-73`
- Modify: `src/lib/storage.ts`（`getSettings` 默认设置对象）

- [ ] **Step 1: Add the field to the `Settings` interface**

In `src/lib/types.ts`, inside `interface Settings`, add after `systemPromptOverride: string`:

```ts
  /**
   * When a download directory is set, save workflow-produced files straight to
   * it without asking; when off (or no directory), ask the user where to save.
   */
  downloadAutoSave: boolean
```

- [ ] **Step 2: Default + normalize in `storage.ts`**

There are two places in `src/lib/storage.ts`:

(a) In the `DEFAULT_SETTINGS` object (around line 64-66, next to `maxToolRounds: 20`), add:

```ts
  downloadAutoSave: true,
```

(b) In `normalizeStoredSettings`'s returned object (around line 125-140, next to `systemPromptOverride:`), add:

```ts
    downloadAutoSave:
      typeof value.downloadAutoSave === 'boolean' ? value.downloadAutoSave : true,
```

This mirrors the existing per-field coercion so a hand-edited or migrated record always has the field.

- [ ] **Step 3: Verify no type errors**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/storage.ts
git commit -m "feat: Settings.downloadAutoSave 字段"
```

---

### Task 3: `save-local` block 元数据 + 执行器

**Files:**
- Modify: `src/lib/workflow/registry.ts`
- Modify: `src/background/workflow-engine/executors.ts`

- [ ] **Step 3.1: Register the block metadata**

In `src/lib/workflow/registry.ts`, inside `WORKFLOW_BLOCKS` (integration category, near the `handle-download` entry), add:

```ts
  {
    id: 'save-local',
    category: 'integration',
    label: '保存到本地',
    description: '把变量/数据内容保存为本地文件（可自动保存到下载目录，或让用户选择保存位置）。',
    params: [
      { name: 'value', label: '内容', type: 'string' },
      { name: 'filename', label: '文件名', type: 'string' },
      { name: 'saveMode', label: '保存方式', type: 'string', default: 'auto' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastSavedPath' },
    ],
  },
```

- [ ] **Step 3.2: Implement the `saveLocal` executor**

In `src/background/workflow-engine/executors.ts`, after the existing `saveAssetsExec` block, add (reusing the `interpolate` import already present and `getSettings` imported at the top):

```ts
import {
  clearDownloadDir,
  getDownloadDir,
  resolveTransferMode,
  writeFileToDownloadDir,
  type SaveMode,
} from '../../lib/download-dir'

/**
 * Sends a "please pick a save location" request to the side panel, which is the
 * only context that can open `showSaveFilePicker` (it needs a document plus a
 * user gesture). Times out if the panel is closed, so the block can fall back
 * to notifying the user instead of hanging.
 */
async function askSaveViaSidePanel(
  suggestedName: string,
): Promise<{ ok: boolean; canceled: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, canceled: false }), 4000)
    void chrome.runtime
      .sendMessage({ type: 'download:save-picker', payload: { suggestedName } })
      .then(
        (reply) => {
          clearTimeout(timer)
          const r = reply as { ok?: boolean; canceled?: boolean } | undefined
          resolve({ ok: Boolean(r?.ok), canceled: Boolean(r?.canceled) })
        },
        () => {
          clearTimeout(timer)
          resolve({ ok: false, canceled: false })
        },
      )
  })
}

const saveLocal: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
  const filename = interpolate(String(data['filename'] ?? 'file.txt'), ctx.variables, ctx.refData)
  const saveMode = (String(data['saveMode'] ?? 'auto') as SaveMode) || 'auto'
  const variable = String(data['variableName'] ?? 'lastSavedPath')

  const settings = await getSettings()
  const dir = await getDownloadDir()
  let hasDir = dir !== null
  // A stored handle may have dropped its permission; a background worker cannot
  // re-grant it, so probe by attempting a lightweight listing.
  if (hasDir) {
    try {
      await dir.getFileHandle('.probe-download-permission', { create: true })
    } catch {
      hasDir = false
    }
  }

  const transfer = resolveTransferMode(saveMode, settings.downloadAutoSave, hasDir)

  if (transfer === 'auto' && dir) {
    const ok = await writeFileToDownloadDir(dir, filename, value)
    if (ok) {
      ctx.variables[variable] = filename
      ctx.emit('result', `已自动保存: ${filename}`)
      return null
    }
    ctx.emit('info', '自动保存失败，改为询问保存位置')
  }

  const res = await askSaveViaSidePanel(filename)
  if (res.ok || res.canceled) {
    ctx.emit('result', res.canceled ? '用户取消了保存' : `已通过另存为保存: ${filename}`)
  } else {
    ctx.emit('error', '无法弹出保存对话框：请打开侧面板后重试')
  }
  return null
}
```

  Note: `clearDownloadDir` is imported for the settings-side task; it is unused here — do NOT import it in executors.ts (only in SettingsTab). Remove it from the import list above if unused to keep lint clean. Keep `getDownloadDir`, `resolveTransferMode`, `writeFileToDownloadDir`, `SaveMode`.

- [ ] **Step 3.3: Register the executor**

In `EXECUTORS` (integration group), add:

```ts
  'save-local': saveLocal,
```

- [ ] **Step 3.4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/workflow/registry.ts src/background/workflow-engine/executors.ts
git commit -m "feat: save-local 算子元数据与执行器"
```

---

### Task 4: `save-local` 编辑表单 + 路由 + 文案

**Files:**
- Create: `src/workflow-editor/blocks/batchB/EditSaveLocal.tsx`
- Modify: `src/workflow-editor/blocks/batchB/index.ts`
- Modify: `src/lib/workflow/blocks/catalog.ts`（若存在 block 表单路由映射，注册 `save-local`）
- Modify: `src/workflow-editor/i18n.ts`、`src/workflow-editor/block-i18n.ts`

- [ ] **Step 1: Create `EditSaveLocal.tsx`**

```tsx
/**
 * EditSaveLocal — "保存到本地" block form.
 *
 * Takes an interpolated content value and a filename, and lets the operator
 * choose the save policy: follow the global auto-save setting (`auto`), force
 * an automatic save into the download directory (`force`), or always ask the
 * user where to save (`manual`).
 *
 * @module workflow-editor/blocks/batchB/EditSaveLocal
 */

import type { EditFormProps } from '../EditForms'
import { Field, Select, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'

const SAVE_MODES = [
  { value: 'auto', label: 'Auto (follow global setting)' },
  { value: 'force', label: 'Force auto-save to download folder' },
  { value: 'manual', label: 'Ask where to save each time' },
]

export default function EditSaveLocal({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Content">
        <TextInput
          value={str(data, 'value')}
          placeholder="Text or {{variable}}"
          onChange={(v) => onChange({ value: v })}
        />
      </Field>

      <Field label="Filename (with extension)">
        <TextInput
          value={str(data, 'filename')}
          placeholder="report.md"
          onChange={(v) => onChange({ filename: v })}
        />
      </Field>

      <Field label="Save mode">
        <Select
          value={str(data, 'saveMode') || 'auto'}
          onChange={(v) => onChange({ saveMode: v })}
          options={SAVE_MODES}
        />
      </Field>

      <Field label="Variable name (output path)">
        <TextInput
          value={str(data, 'variableName') || 'lastSavedPath'}
          onChange={(v) => onChange({ variableName: v })}
        />
      </Field>
    </div>
  )
}
```

- [ ] **Step 2: Register the form**

In `src/workflow-editor/blocks/batchB/index.ts`: import `EditSaveLocal` and add `EditSaveLocal` to the exported map (alongside `EditHandleDownload`). If a per-id form route lives in `src/lib/workflow/blocks/catalog.ts` or in `EditForms.tsx`, add `'save-local': EditSaveLocal` at the `save-assets`/`handle-download` location.

- [ ] **Step 3: Add i18n strings**

In `src/workflow-editor/block-i18n.ts` and/or `src/workflow-editor/i18n.ts`, add translations for the new labels used by the form and registry (Content / Filename / Save mode / '保存到本地' / '把变量/数据内容保存为本地文件…'). Follow the existing map keyed by English string.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow-editor/blocks/batchB/EditSaveLocal.tsx src/workflow-editor/blocks/batchB/index.ts src/lib/workflow/blocks/catalog.ts src/workflow-editor/i18n.ts src/workflow-editor/block-i18n.ts
git commit -m "feat: save-local 编辑表单与文案"
```

---

### Task 5: 侧面板「另存为」消息处理 + 后台放行

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/background/index.ts`

- [ ] **Step 1: Side panel handles `download:save-picker`**

In `src/sidepanel/App.tsx`, add a `useEffect` that registers a `chrome.runtime.onMessage` listener (return cleanup to remove it). It must call `showSaveFilePicker` (requires user gesture) and reply via `sendResponse`:

```tsx
useEffect(() => {
  const handler = (
    message: { type?: string; payload?: { suggestedName?: string } },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (message?.type !== 'download:save-picker') return
    void (async () => {
      if (!('showSaveFilePicker' in window)) {
        sendResponse({ ok: false })
        return
      }
      try {
        await (window as Window & {
          showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>
        }).showSaveFilePicker?.({
          suggestedName: message.payload?.suggestedName ?? 'file.txt',
        })
        sendResponse({ ok: true })
      } catch (error) {
        // AbortError === user closed the picker.
        const canceled = error instanceof DOMException && error.name === 'AbortError'
        sendResponse({ ok: false, canceled })
      }
    })()
    return true // keep the message channel open for the async sendResponse
  }
  chrome.runtime.onMessage.addListener(handler)
  return () => chrome.runtime.onMessage.removeListener(handler)
}, [])
```

- [ ] **Step 2: Background passes the type through (no handling)**

In `src/background/index.ts` `onMessage`, ensure any branch that matches unknown message types does not consume `download:save-picker`. The single listener should `return false`/not call `sendResponse` for types it does not own so the side panel listener wins. Add an early guard at the top:

```ts
if (message?.type === 'download:save-picker') return false
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/App.tsx src/background/index.ts
git commit -m "feat: 侧面板另存为 picker 消息通道"
```

---

### Task 6: 设置页「下载目录」卡片

**Files:**
- Modify: `src/sidepanel/SettingsTab.tsx`

- [ ] **Step 1: Import the download-dir helpers**

At the top of `SettingsTab.tsx`, import:

```ts
import {
  clearDownloadDir,
  getDownloadDir,
  setDownloadDir,
} from '../lib/download-dir'
```

- [ ] **Step 2: Add local state and handlers**

Inside `SettingsTab`, add state and handlers mirroring the existing storage-folder ones (`chooseFolder/reconnectFolder/removeFolder`):

```tsx
const [downloadDirName, setDownloadDirName] = useState<string | null>(null)
const [downloadBusy, setDownloadBusy] = useState(false)
const [downloadNotice, setDownloadNotice] = useState<{
  kind: 'ok' | 'error'
  text: string
} | null>(null)

useEffect(() => {
  void getDownloadDir().then((handle) =>
    setDownloadDirName(handle ? handle.name : null),
  )
}, [])

const chooseDownloadDir = async (): Promise<void> => {
  setDownloadBusy(true)
  setDownloadNotice(null)
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    await setDownloadDir(handle)
    setDownloadDirName(handle.name)
    setDownloadNotice({ kind: 'ok', text: t.settingsDownloadFolderDone({ name: handle.name }) })
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      setDownloadNotice({ kind: 'error', text: t.settingsDownloadFolderFailed })
    }
  } finally {
    setDownloadBusy(false)
  }
}

const removeDownloadDir = async (): Promise<void> => {
  setDownloadBusy(true)
  await clearDownloadDir()
  setDownloadDirName(null)
  // keep the auto-save switch, just no folder
  void mutate({ type: 'settings.set', patch: { downloadAutoSave: false } })
  setDownloadBusy(false)
}
```

  Note: `window.showDirectoryPicker` already exists on `Window` types used by `fs-store`; if not typed in this project, cast similarly to the storage-folder picker.

- [ ] **Step 3: Add the new "下载目录" card** (place after the existing “Storage location” card)

```tsx
{/* --- Download directory --- */}
<div className="card">
  <div className="card-title">{t.settingsDownloadDir}</div>
  <p className="hint">{t.settingsDownloadDirIntro}</p>
  <p className="hint">
    {downloadDirName
      ? t.settingsDownloadDirFolder({ name: downloadDirName })
      : t.settingsDownloadDirNone}
  </p>
  {downloadNotice && (
    <p className={downloadNotice.kind === 'ok' ? 'hint ok' : 'hint error'}>
      {downloadNotice.text}
    </p>
  )}
  <div className="actions">
    {downloadDirName ? (
      <>
        <button disabled={downloadBusy} onClick={() => void chooseDownloadDir()} type="button">
          {t.settingsChangeFolder}
        </button>
        <button disabled={downloadBusy} onClick={() => void removeDownloadDir()} type="button">
          {t.settingsDownloadDirDisconnect}
        </button>
      </>
    ) : (
      <button disabled={downloadBusy} onClick={() => void chooseDownloadDir()} type="button">
        {t.settingsChooseFolder}
      </button>
    )}
  </div>
  <label className="field">
    <input
      type="checkbox"
      checked={settings.downloadAutoSave}
      disabled={!downloadDirName}
      onChange={(event) =>
        void mutate({ type: 'settings.set', patch: { downloadAutoSave: event.target.checked } })
      }
    />
    <span>{t.settingsDownloadAutoSave}</span>
  </label>
</div>
```

- [ ] **Step 4: Add the new i18n keys**

Add `settingsDownloadDir`, `settingsDownloadDirIntro`, `settingsDownloadDirFolder`, `settingsDownloadDirNone`, `settingsDownloadDirDone`, `settingsDownloadDirFailed`, `settingsDownloadDirDisconnect`, `settingsDownloadAutoSave` to the translations used by `SettingsTab` (side panel i18n — `src/sidepanel/i18n.ts` or `src/lib/i18n.ts`). Follow the existing key shape (`t.settings*`).

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/SettingsTab.tsx src/sidepanel/i18n.ts src/lib/i18n.ts
git commit -m "feat: 设置页下载目录卡片"
```

---

### Task 7: 对话消息按钮收紧 + 常显

**Files:**
- Modify: `src/sidepanel/ChatTab.tsx`
- Modify: `src/sidepanel/styles.css`

- [ ] **Step 1: Tighten `MsgActions` visibility**

In `ChatTab.tsx`, `MsgActions` currently shows copy for every message and copy+download for every assistant message. Change the component so:

- Only for the **last assistant reply** (`isLastAssistant`) show copy + download + token.
- User messages show copy only.
- Any other (non-last) assistant reply shows **no actions**.
- While busy and the assistant entry is not the last completed one, keep hiding (existing rule stays).

Replace the guard block (around lines 158-166) with:

```tsx
  if (entry.role !== 'user' && entry.role !== 'assistant') return null
  const isAssistant = entry.role === 'assistant'
  // While streaming, non-final intermediate replies show no actions.
  if (busy && isAssistant && !isLastAssistant) return null
  // After a turn completes: only the final assistant reply keeps actions,
  // plus the copy-only affordance on user messages. Earlier assistant
  // replies show nothing.
  if (isAssistant && !isLastAssistant) return null
  // Download + token only on the final assistant reply; user messages get
  // copy only.
  const isFinal = isAssistant && isLastAssistant
  if (!isAssistant) {
    // User message: copy button only, no token/download.
  }
```

  Then wrap the download button and token gauge so they render only when `isFinal`:

```tsx
  {isFinal && (
    <>
      <button
        aria-label={t.msgDownload}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="msg-action msg-download"
        onClick={() => setMenuOpen((open) => !open)}
        title={t.msgDownload}
        type="button"
      >
        <Download size={13} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="msg-download-menu" role="menu">
          <div className="msg-download-title">{t.msgDownloadAs}</div>
          <button onClick={() => download('md')} type="button">{t.msgDownloadMd}</button>
          <button onClick={() => download('txt')} type="button">{t.msgDownloadTxt}</button>
          <button onClick={() => download('html')} type="button">{t.msgDownloadHtmlPdf}</button>
          {hasTables(entry.text) && (
            <button onClick={() => download('csv')} type="button">{t.msgDownloadCsv}</button>
          )}
        </div>
      )}
      {!!entry.usage && (
        <div className="msg-token" tabIndex={0} role="button" aria-label={t.msgTokenUsage}>
          <Gauge size={13} aria-hidden="true" />
          <div className="msg-token-tip">
            <span className="msg-token-tip-title">{t.tokenBarLastTurn}</span>
            <span className="msg-token-tip-kv">{t.tokenBarT}:{formatTokens(entry.usage.totalTokens)}</span>
            <span className="msg-token-tip-kv">{t.tokenBarI}:{formatTokens(entry.usage.inputTokens)}</span>
            <span className="msg-token-tip-kv">{t.tokenBarO}:{formatTokens(entry.usage.outputTokens)}</span>
            <span className="msg-token-tip-kv">{t.tokenBarR}:{formatTokens(entry.usage.reasoningTokens ?? 0)}</span>
            <span className="msg-token-tip-kv">{t.tokenBarC}:{formatTokens(entry.usage.cachedInputTokens ?? 0)}</span>
          </div>
        </div>
      )}
    </>
  )}
```

  The copy button (already rendered above this block, outside `isAssistant`) remains for both user and final assistant replies. Move it out of the old `{isAssistant && ...}` so it shows for the final assistant reply (it will, since the copy button element is above `{isFinal && ...}`) — leave the copy `<button>` as-is at the top of `<div className="msg-actions">`.

- [ ] **Step 2: Make the actions bar always visible**

In `src/sidepanel/styles.css`, change `.msg-actions` from `display: none` to `display: flex`, and remove the hover/focus rule:

```css
.msg-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
```

Delete these two rules:

```css
.msg:hover .msg-actions,
.msg:focus-within .msg-actions {
  display: flex;
}
```

  This keeps the bar pinned below each message's text (it already has `margin-top: 8px`). Token/download margins that rely on the `msg-action` sizing are unchanged.

- [ ] **Step 3: Add/adjust a ChatTab behavior test**

If a `ChatTab`-level test exists for `MsgActions` visibility, extend it to assert: an assistant message that is not the last shows no actions; the last assistant reply exposes download + token; a user message exposes copy only. If no such test harness exists, assert the pure guard by extracting the visibility decision into a tiny exported helper in `ChatTab.tsx` and unit-test it:

```ts
export function actionsFor(role: 'user' | 'assistant', isLastAssistant: boolean, busy: boolean, isAssistant: boolean): boolean {
  if (role !== 'user' && role !== 'assistant') return false
  if (busy && isAssistant && !isLastAssistant) return false
  if (isAssistant && !isLastAssistant) return false
  return true
}
```

  and use it inside `MsgActions` (render nothing when `!actionsFor(...)`).

- [ ] **Step 4: Verify**

Run: `npm run typecheck` and `npx vitest run`
Expected: PASS; existing suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/ChatTab.tsx src/sidepanel/styles.css tests/
git commit -m "feat: 对话按钮仅最后一条总回复常显"
```

---

## 总体验证

Run: `npm run typecheck && npx vitest run`
Expected: all types pass, existing + new tests green.

Run the extension (`npm run dev`) and manually check:
1. 设置页出现“下载目录”卡片，可选择/断开目录，自动保存开关随是否有目录启用/禁用。
2. 工作流添加 `保存到本地` 算子，分别以 auto(全局开/关)、force、manual 运行：auto+全局开→目录内生成文件；manual 且侧面板打开→弹出保存框；force 无目录→回退另存为。
3. 对话中：仅最后一条助手回复下方常显 复制/下载/token；用户消息下方仅复制；其余助手回复无按钮。

## 自审

- **Spec 覆盖**：A(下载目录卡片+开关)→Task 6；B(save-local 算子+保存决策+另存为通道)→Task 3/4/5；C(对话按钮)→Task 7；Settings 字段→Task 2，句柄模块→Task 1。覆盖完整。
- **无占位**：所有步骤含真实代码与命令。
- **类型一致**：`resolveTransferMode(SaveMode, boolean, boolean)`、`getDownloadDir/setDownloadDir/clearDownloadDir`、`writeFileToDownloadDir`、`actionsFor` 命名在各任务间一致。
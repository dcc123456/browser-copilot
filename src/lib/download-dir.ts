/**
 * 下载目录句柄存储
 *
 * 与 `lib/fs-store` 共用一个 IndexedDB（DB 'browser-copilot-fs'，store 'directory'），
 * 但使用独立的 key 'download'，与文件存储目录（key 'root'）区分开。这样用户配置的
 * 「下载目录」是一个独立的授权句柄，不会与主文件存储目录混淆。
 *
 * 关键点：
 * - 句柄持久化在 IndexedDB 中之后，只要扩展脚本源的权限已授予，worker 无需用户手势
 *   也能直接读取该句柄并写入文件（包括回复全文导出、下载等）。
 * - 下载目录的句柄由 side panel 通过 `showDirectoryPicker` 选取并授权，之后后台
 *   worker 读写均可用同一授权句柄。
 * - `writeFileToDownloadDir` 会覆盖同名的已有文件（`create: true` + `createWritable`），
 *   因此适合「每次导出生成固定文件名」的场景。
 *
 * @module lib/download-dir
 */

const IDB_DB = 'browser-copilot-fs'
const IDB_STORE = 'directory'
const IDB_KEY = 'download'

/** 导出保存策略：'auto' 跟随全局开关 + 是否配置目录，'force' 强推自动保存，'manual' 始终由用户确认。 */
export type SaveMode = 'auto' | 'force' | 'manual'

/**
 * 打开共享的 IndexedDB。与 fs-store 相同：不存在 store 时按需创建。
 * 在无 IndexedDB 的环境（如部分 Node 测试环境）中会 reject。
 */
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

/**
 * 读取已配置的下载目录句柄；未配置或读取失败时返回 `null`。
 */
export async function getDownloadDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIdb()
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/**
 * 保存下载目录句柄到 IndexedDB（key 'download'）。之后 worker 即可直接使用该句柄写文件。
 */
export async function setDownloadDir(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

/**
 * 清除下载目录句柄（用户在设置中取消配置下载目录时调用）。已写入的文件不受影响。
 */
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
    // 未配置
  }
}

/**
 * 根据保存模式、全局「自动保存」开关、以及是否已配置下载目录，决定本次导出是自动保存
 * 还是转交用户手动确认：
 * - 'manual' 始终转交用户确认（不依赖任何开关）。
 * - 'force' 只要已配置目录就自动保存；未配置（无处可写）则退回手动。
 * - 'auto' 只有在已配置目录 **且** 全局自动保存开启时才自动保存。
 */
export function resolveTransferMode(
  saveMode: SaveMode,
  globalAuto: boolean,
  hasDir: boolean,
): 'auto' | 'manual' {
  if (saveMode === 'manual') return 'manual'
  if (saveMode === 'force') return hasDir ? 'auto' : 'manual'
  return hasDir && globalAuto ? 'auto' : 'manual'
}

/**
 * 将一个文本文件写到下载目录。`create: true` 时若同名文件已存在会被覆盖。
 * 返回是否写入成功（如目录句柄无效或权限丢失时返回 `false`）。
 */
export async function writeFileToDownloadDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
  text: string,
): Promise<boolean> {
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(text)
    } finally {
      await writable.close()
    }
    return true
  } catch {
    return false
  }
}

/**
 * 内部使用 chrome.runtime 发送消息（仅调用时引用，import 本身不触发，
 * 因此在无 chrome 的测试环境中导入本模块不受影响）。
 *
 * Sends a "please pick a save location" request to the side panel, which is the
 * only context that can open `showSaveFilePicker` (it needs a document).
 * Resolves false/false if the panel is closed or does not answer within 4s, so
 * callers can fall back instead of hanging. Shared by workflow blocks and the
 * chat agent's `save_local` tool.
 */
export async function askSaveViaSidePanel(
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
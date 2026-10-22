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

import {
  deleteDirectoryHandle,
  readDirectoryHandle,
  writeDirectoryHandle,
} from './directory-handle-store'
import { normalizeDownloadFilePath } from './workflow/download-file-path'

const DIRECTORY_KEY = 'download'

/** 导出保存策略：'auto' 跟随全局开关 + 是否配置目录，'force' 强推自动保存，'manual' 始终由用户确认。 */
export type SaveMode = 'auto' | 'force' | 'manual'

/**
 * 读取已配置的下载目录句柄；未配置或读取失败时返回 `null`。
 */
export function getDownloadDir(): Promise<FileSystemDirectoryHandle | null> {
  return readDirectoryHandle(DIRECTORY_KEY)
}

/**
 * 保存下载目录句柄（key 'download'）。之后 worker 即可直接使用该句柄写文件。
 */
export function setDownloadDir(handle: FileSystemDirectoryHandle): Promise<void> {
  return writeDirectoryHandle(DIRECTORY_KEY, handle)
}

/**
 * 清除下载目录句柄（用户在设置中取消配置下载目录时调用）。已写入的文件不受影响。
 */
export function clearDownloadDir(): Promise<void> {
  return deleteDirectoryHandle(DIRECTORY_KEY)
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
 * The directory an UNATTENDED run writes into when nobody can answer the save
 * picker: the extension's own OPFS origin directory, a subfolder of it.
 *
 * It needs no user gesture, no `showDirectoryPicker`, and no persisted handle, so
 * a bridge / harness / scheduled replay always has exactly one place that is sure
 * to be writable — which is the difference between a run that finishes and one that
 * dies at 16/44 on «无法打开保存对话框» (round 71). The path is on disk under the
 * profile (`…/<Profile>/File System/…`) and the run event names the file, so nothing
 * is hidden; it is only ever reached AFTER the configured download dir and AFTER the
 * side panel failed to answer, so an attended run still behaves exactly as before.
 */
export async function getUnattendedDownloadDir(
  create = true,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const storage = navigator.storage as { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
    const root = await storage?.getDirectory?.()
    if (!root) return null
    return await root.getDirectoryHandle('browser-copilot-downloads', { create })
  } catch {
    return null
  }
}

/** One file found while scanning the download locations. */
export interface DownloadedFileCandidate {
  /** File name only (`entry.name`). */
  name: string
  /** Path relative to its download root, `/`-separated. */
  relativePath: string
  mimeType: string
  size: number
  lastModified: number
  /** Which location it came from (never an absolute path). */
  source: 'configured-download-dir' | 'internal-download-dir'
  getFile(): Promise<File>
}

export interface DownloadedFileScan {
  candidates: DownloadedFileCandidate[]
  /** Locations that were readable and scanned (for error messages). */
  scanned: string[]
  /** Locations that were skipped, with the reason. */
  skipped: string[]
  /** True when the entry limit stopped a recursive scan early. */
  truncated?: boolean
}

export interface DownloadScanOptions {
  /** Walk subdirectories (the editor's file-path picker). Default false. */
  recursive?: boolean
  /** Directory levels below each root. Default 4. */
  maxDepth?: number
  /** Stop after this many files. Default 500. */
  maxEntries?: number
}

const CONFIGURED_DIR_LABEL = 'configured download folder'
const INTERNAL_DIR_LABEL = 'internal downloads folder'

async function canReadDirectory(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted'
  } catch {
    // Permission API unavailable — let enumeration itself decide.
    return true
  }
}

interface ScanAccumulator {
  candidates: DownloadedFileCandidate[]
  truncated: boolean
}

async function collectFiles(
  dir: FileSystemDirectoryHandle,
  source: DownloadedFileCandidate['source'],
  prefix: string,
  depth: number,
  options: Required<DownloadScanOptions>,
  accumulator: ScanAccumulator,
): Promise<void> {
  for await (const entry of dir.values()) {
    if (accumulator.candidates.length >= options.maxEntries) {
      accumulator.truncated = true
      return
    }
    if (entry.kind === 'file') {
      try {
        const file = await (entry as FileSystemFileHandle).getFile()
        accumulator.candidates.push({
          name: entry.name,
          relativePath: `${prefix}${entry.name}`,
          mimeType: file.type,
          size: file.size,
          lastModified: file.lastModified,
          source,
          getFile: () => (entry as FileSystemFileHandle).getFile(),
        })
      } catch {
        // A single unreadable file must not hide the rest of the folder.
      }
    } else if (options.recursive && depth < options.maxDepth) {
      try {
        await collectFiles(
          entry as FileSystemDirectoryHandle,
          source,
          `${prefix}${entry.name}/`,
          depth + 1,
          options,
          accumulator,
        )
      } catch {
        // An unreadable subdirectory must not hide its siblings.
      }
    }
  }
}

/**
 * Enumerate the files uploads may choose from: the folder configured in
 * Settings plus the extension's own unattended download folder. Read-only: the
 * internal folder is not created, and no permission prompt is raised (a worker
 * has no user gesture), the folder is reported as skipped.
 *
 * Root-only by default (`latest-download`); the editor's path picker opts into
 * recursion so files the user keeps in subfolders are reachable.
 */
export async function listDownloadedFileCandidates(
  scanOptions: DownloadScanOptions = {},
): Promise<DownloadedFileScan> {
  const options: Required<DownloadScanOptions> = {
    recursive: scanOptions.recursive === true,
    maxDepth: Math.max(0, scanOptions.maxDepth ?? 4),
    maxEntries: Math.max(1, scanOptions.maxEntries ?? 500),
  }
  const accumulator: ScanAccumulator = { candidates: [], truncated: false }
  const scanned: string[] = []
  const skipped: string[] = []

  const collectRoot = async (
    dir: FileSystemDirectoryHandle,
    source: DownloadedFileCandidate['source'],
    label: string,
  ): Promise<void> => {
    try {
      await collectFiles(dir, source, '', 0, options, accumulator)
      scanned.push(label)
    } catch {
      skipped.push(`${label} (could not be read)`)
    }
  }

  const configured = await getDownloadDir()
  if (configured) {
    if (await canReadDirectory(configured)) {
      await collectRoot(configured, 'configured-download-dir', CONFIGURED_DIR_LABEL)
    } else {
      skipped.push(
        `${CONFIGURED_DIR_LABEL} (read permission not granted; reconnect it in Settings)`,
      )
    }
  }

  const internal = await getUnattendedDownloadDir(false)
  if (internal) await collectRoot(internal, 'internal-download-dir', INTERNAL_DIR_LABEL)

  return {
    candidates: accumulator.candidates,
    scanned,
    skipped,
    ...(accumulator.truncated ? { truncated: true } : {}),
  }
}

/** A file resolved from a download-relative path. */
export interface DownloadedPathFile {
  file: File
  source: DownloadedFileCandidate['source']
  relativePath: string
}

/**
 * Read one file by its download-relative path. The configured folder wins over
 * the internal one, mirroring the latest-download scan order. Returns null for
 * an invalid path or when neither root holds it.
 */
export async function readDownloadedFileAtPath(
  rawPath: string,
): Promise<DownloadedPathFile | null> {
  const relativePath = normalizeDownloadFilePath(rawPath)
  if (!relativePath) return null
  const segments = relativePath.split('/')
  const filename = segments[segments.length - 1]!

  const resolveIn = async (
    root: FileSystemDirectoryHandle,
    source: DownloadedPathFile['source'],
  ): Promise<DownloadedPathFile | null> => {
    try {
      let directory = root
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment, { create: false })
      }
      const handle = await directory.getFileHandle(filename, { create: false })
      return { file: await handle.getFile(), source, relativePath }
    } catch {
      return null
    }
  }

  const configured = await getDownloadDir()
  if (configured && (await canReadDirectory(configured))) {
    const found = await resolveIn(configured, 'configured-download-dir')
    if (found) return found
  }

  const internal = await getUnattendedDownloadDir(false)
  if (internal) return resolveIn(internal, 'internal-download-dir')
  return null
}

/**
 * 将一个文件写到下载目录。`create: true` 时若同名文件已存在会被覆盖。
 * `data` 可以是文本或二进制（截图等），底层 `createWritable().write` 两者都收。
 * 返回是否写入成功（如目录句柄无效或权限丢失时返回 `false`）。
 */ export async function writeFileToDownloadDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
  data: string | BufferSource,
): Promise<boolean> {
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(data as FileSystemWriteChunkType)
    } finally {
      await writable.close()
    }
    return true
  } catch {
    return false
  }
}

/**
 * The file content handed to the side panel's save picker. Exactly one of the
 * two is set: `text` for UTF-8 text, `base64` for binary (screenshots).
 */
export interface SavePickerPayload {
  text?: string
  base64?: string
}

/**
 * 内部使用 chrome.runtime 发送消息（仅调用时引用，import 本身不触发，
 * 因此在无 chrome 的测试环境中导入本模块不受影响）。
 *
 * Sends a "please pick a save location" request to the side panel, which is the
 * only context that can open `showSaveFilePicker` (it needs a document). The
 * CONTENT travels with the request: the handle the picker returns only exists
 * in the panel, so the panel is the only place the write can happen.
 *
 * Resolves false/false if the panel is closed or does not answer within 4s, so
 * callers can fall back instead of hanging. Shared by workflow blocks and the
 * chat agent's `save_local` tool.
 */
export async function askSaveViaSidePanel(
  suggestedName: string,
  payload: SavePickerPayload,
): Promise<{ ok: boolean; canceled: boolean }> {
  // No extension context (tests, or a page that imported this module): there is
  // no panel to ask, and touching `chrome` here would throw a ReferenceError
  // inside the executor and fail the whole run instead of the one step.
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    return { ok: false, canceled: false }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, canceled: false }), 4000)
    void chrome.runtime
      .sendMessage({ type: 'download:save-picker', payload: { suggestedName, ...payload } })
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

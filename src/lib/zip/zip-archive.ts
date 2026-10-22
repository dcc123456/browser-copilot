/**
 * Dependency-free ZIP reader shared by the spreadsheet parser and the
 * extension updater.
 *
 * Supports stored (method 0) and deflated (method 8) entries via the central
 * directory, with explicit byte budgets. Zip64, encrypted entries and other
 * compression methods are rejected. Runs unchanged in the service worker, the
 * side panel and the headless Runner (Node exposes DecompressionStream too).
 *
 * The reader treats names as opaque text: path safety (absolute paths, `..`,
 * separators, duplicate destinations) belongs to callers that extract to disk.
 *
 * @module lib/zip/zip-archive
 */

export type ZipErrorCode =
  | 'ZIP_TRUNCATED'
  | 'ZIP_ZIP64_UNSUPPORTED'
  | 'ZIP_CENTRAL_DIRECTORY_OUT_OF_BOUNDS'
  | 'ZIP_CENTRAL_DIRECTORY_MALFORMED'
  | 'ZIP_ENTRY_NAME_TRUNCATED'
  | 'ZIP_ENTRY_LOCAL_HEADER_INVALID'
  | 'ZIP_ENTRY_TRUNCATED'
  | 'ZIP_ENTRY_MISSING'
  | 'ZIP_ENTRY_IS_DIRECTORY'
  | 'ZIP_ENCRYPTED_UNSUPPORTED'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_TOTAL_TOO_LARGE'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_METHOD_UNSUPPORTED'
  | 'ZIP_DECOMPRESS_FAILED'
  | 'ZIP_DECOMPRESSED_TOO_LARGE'
  | 'ZIP_DECOMPRESSION_UNAVAILABLE'

/** Structured ZIP failure; `entryName` / `method` are set when relevant. */
export class ZipError extends Error {
  readonly code: ZipErrorCode
  readonly entryName?: string
  readonly method?: number

  constructor(
    code: ZipErrorCode,
    message: string,
    detail: { entryName?: string; method?: number } = {},
  ) {
    super(message)
    this.name = 'ZipError'
    this.code = code
    if (detail.entryName !== undefined) this.entryName = detail.entryName
    if (detail.method !== undefined) this.method = detail.method
  }
}

/** One central-directory record. Directory records are listed too. */
export interface ZipEntryInfo {
  name: string
  /** True when the name ends with `/` (a directory record written by a zipper). */
  isDirectory: boolean
  method: number
  compressedSize: number
  uncompressedSize: number
  encrypted: boolean
}

export interface ZipOpenOptions {
  /** Per-entry decompressed byte cap. Default 64 MiB. */
  maxEntryBytes?: number
  /** Cap on the sum of declared uncompressed sizes. Default 128 MiB. */
  maxTotalUncompressedBytes?: number
  /** Cap on central-directory records. Default 10,000. */
  maxEntries?: number
}

export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
export const DEFAULT_MAX_ENTRIES = 10_000

const UTF8 = new TextDecoder('utf-8')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

interface ZipEntry extends ZipEntryInfo {
  dataOffset: number
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

export class ZipArchive {
  private readBytes = 0

  private constructor(
    private readonly bytes: Uint8Array,
    private readonly entryList: readonly ZipEntry[],
    private readonly byName: Map<string, ZipEntry>,
    private readonly options: Required<ZipOpenOptions>,
  ) {}

  static open(bytes: Uint8Array, options: ZipOpenOptions = {}): ZipArchive {
    const limits: Required<ZipOpenOptions> = {
      maxEntryBytes: options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      maxTotalUncompressedBytes:
        options.maxTotalUncompressedBytes ?? DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    }
    const eocd = findEndOfCentralDirectory(bytes)
    if (eocd < 0) {
      throw new ZipError('ZIP_TRUNCATED', 'The ZIP archive is truncated or malformed.')
    }
    const entryCount = readU16(bytes, eocd + 10)
    const centralSize = readU32(bytes, eocd + 12)
    const centralOffset = readU32(bytes, eocd + 16)
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new ZipError('ZIP_ZIP64_UNSUPPORTED', 'Zip64 archives are not supported.')
    }
    if (entryCount > limits.maxEntries) {
      throw new ZipError(
        'ZIP_TOO_MANY_ENTRIES',
        `The ZIP archive contains ${entryCount} entries, above the ${limits.maxEntries} limit.`,
      )
    }
    if (centralOffset + centralSize > bytes.length) {
      throw new ZipError(
        'ZIP_CENTRAL_DIRECTORY_OUT_OF_BOUNDS',
        'The ZIP central directory is out of bounds.',
      )
    }

    const entries: ZipEntry[] = []
    const byName = new Map<string, ZipEntry>()
    let declaredUncompressed = 0
    let cursor = centralOffset
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > bytes.length || readU32(bytes, cursor) !== CENTRAL_SIGNATURE) {
        throw new ZipError(
          'ZIP_CENTRAL_DIRECTORY_MALFORMED',
          'The ZIP central directory is malformed.',
        )
      }
      const flags = readU16(bytes, cursor + 8)
      const method = readU16(bytes, cursor + 10)
      const compressedSize = readU32(bytes, cursor + 20)
      const uncompressedSize = readU32(bytes, cursor + 24)
      const nameLength = readU16(bytes, cursor + 28)
      const extraLength = readU16(bytes, cursor + 30)
      const commentLength = readU16(bytes, cursor + 32)
      const localOffset = readU32(bytes, cursor + 42)
      const nameStart = cursor + 46
      if (nameStart + nameLength > bytes.length) {
        throw new ZipError('ZIP_ENTRY_NAME_TRUNCATED', 'A ZIP entry name is truncated.')
      }
      const name = UTF8.decode(bytes.subarray(nameStart, nameStart + nameLength))
      cursor = nameStart + nameLength + extraLength + commentLength

      if (localOffset + 30 > bytes.length || readU32(bytes, localOffset) !== LOCAL_SIGNATURE) {
        throw new ZipError(
          'ZIP_ENTRY_LOCAL_HEADER_INVALID',
          `The ZIP entry "${name}" has an invalid local header.`,
          { entryName: name },
        )
      }
      const localNameLength = readU16(bytes, localOffset + 26)
      const localExtraLength = readU16(bytes, localOffset + 28)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      if (dataOffset + compressedSize > bytes.length) {
        throw new ZipError('ZIP_ENTRY_TRUNCATED', `The ZIP entry "${name}" is truncated.`, {
          entryName: name,
        })
      }

      declaredUncompressed += uncompressedSize
      if (declaredUncompressed > limits.maxTotalUncompressedBytes) {
        throw new ZipError(
          'ZIP_TOTAL_TOO_LARGE',
          'The ZIP archive expands beyond the safe size limit.',
        )
      }

      const entry: ZipEntry = {
        name,
        isDirectory: name.endsWith('/'),
        method,
        compressedSize,
        uncompressedSize,
        dataOffset,
        encrypted: (flags & 1) === 1,
      }
      entries.push(entry)
      // Last record wins, matching the previous lookup behaviour; duplicates
      // stay visible through `entries` so extraction can reject them.
      byName.set(name.toLowerCase(), entry)
    }
    return new ZipArchive(bytes, entries, byName, limits)
  }

  /** Every central-directory record, in archive order. */
  get entries(): readonly ZipEntryInfo[] {
    return this.entryList
  }

  has(name: string): boolean {
    return this.byName.has(name.toLowerCase())
  }

  /** Case-insensitive metadata lookup (the archive's names are case-preserved). */
  get(name: string): ZipEntryInfo | undefined {
    return this.byName.get(name.toLowerCase())
  }

  async read(name: string): Promise<Uint8Array> {
    const entry = this.byName.get(name.toLowerCase())
    if (!entry) {
      throw new ZipError('ZIP_ENTRY_MISSING', `The ZIP archive is missing "${name}".`, {
        entryName: name,
      })
    }
    if (entry.isDirectory) {
      throw new ZipError(
        'ZIP_ENTRY_IS_DIRECTORY',
        `The ZIP entry "${entry.name}" is a directory.`,
        {
          entryName: entry.name,
        },
      )
    }
    if (entry.encrypted) {
      throw new ZipError('ZIP_ENCRYPTED_UNSUPPORTED', 'Encrypted ZIP entries are not supported.', {
        entryName: entry.name,
      })
    }
    if (entry.uncompressedSize > this.options.maxEntryBytes) {
      throw new ZipError('ZIP_ENTRY_TOO_LARGE', `The ZIP entry "${entry.name}" is too large.`, {
        entryName: entry.name,
      })
    }
    this.readBytes += entry.uncompressedSize
    if (this.readBytes > this.options.maxTotalUncompressedBytes) {
      throw new ZipError('ZIP_TOTAL_TOO_LARGE', 'The ZIP archive is too large to read safely.')
    }

    const compressed = this.bytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    )
    if (entry.method === 0) return compressed.slice()
    if (entry.method !== 8) {
      throw new ZipError(
        'ZIP_METHOD_UNSUPPORTED',
        `The ZIP entry "${entry.name}" uses unsupported compression method ${entry.method}.`,
        { entryName: entry.name, method: entry.method },
      )
    }
    try {
      return await inflateRaw(compressed, this.options.maxEntryBytes)
    } catch (error) {
      if (error instanceof ZipError) throw error
      throw new ZipError(
        'ZIP_DECOMPRESS_FAILED',
        `The ZIP entry "${entry.name}" could not be decompressed.`,
        { entryName: entry.name },
      )
    }
  }

  async readText(name: string): Promise<string> {
    return UTF8.decode(await this.read(name))
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.length < 22) return -1
  const earliest = Math.max(0, bytes.length - 0xffff - 22)
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

async function inflateRaw(data: Uint8Array, maxEntryBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError(
      'ZIP_DECOMPRESSION_UNAVAILABLE',
      'This environment cannot decompress ZIP entries (DecompressionStream is unavailable).',
    )
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  // TS's DOM lib types DecompressionStream against BufferSource while
  // ReadableStream defaults to Uint8Array; the pair is compatible at runtime.
  const decompressor = new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  const reader = source.pipeThrough(decompressor).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxEntryBytes) {
      await reader.cancel()
      throw new ZipError(
        'ZIP_DECOMPRESSED_TOO_LARGE',
        'A ZIP entry decompressed beyond the size limit.',
      )
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

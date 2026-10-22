/**
 * Dependency-free spreadsheet reader for the `parse-excel` operator.
 *
 * Supports `.xlsx` (the OOXML subset Excel actually writes: workbook,
 * relationships, shared strings, styles, one worksheet) and `.csv`
 * (RFC-4180 with delimiter / BOM handling). The parser runs unchanged in the
 * extension service worker and in the headless Runner, so both hosts produce
 * identical rows.
 *
 * `.xls` (BIFF), encrypted workbooks and Zip64 are rejected explicitly.
 *
 * @module lib/workflow/excel-parse
 */

export type SpreadsheetErrorCode =
  'EXCEL_PARSE_FAILED' | 'EXCEL_SHEET_NOT_FOUND' | 'EXCEL_LEGACY_FORMAT_UNSUPPORTED'

/** Error whose message carries a structured code prefix (see failure-code.ts). */
export class SpreadsheetParseError extends Error {
  readonly code: SpreadsheetErrorCode

  constructor(code: SpreadsheetErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'SpreadsheetParseError'
    this.code = code
  }
}

/** A converted cell: strings, numbers, booleans, or null for an empty cell. */
export type SpreadsheetCell = string | number | boolean | null

export interface SpreadsheetParseOptions {
  /** Worksheet name for `.xlsx`; empty/undefined picks the first sheet. */
  sheetName?: string
  /** Treat the first row as the object keys (default true). */
  hasHeader?: boolean
}

export interface ParsedSpreadsheet {
  /** Selected worksheet name (`.csv` uses the file's base name). */
  sheetName: string
  /** Object rows (header-keyed). Excludes the header row. */
  rows: Record<string, SpreadsheetCell>[]
  /** The 2-D values as parsed, including the header row. */
  rawRows: SpreadsheetCell[][]
}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Parse an `.xlsx` / `.csv` byte payload.
 *
 * Throws `SpreadsheetParseError` (`EXCEL_PARSE_FAILED`,
 * `EXCEL_SHEET_NOT_FOUND`, `EXCEL_LEGACY_FORMAT_UNSUPPORTED`).
 */
export async function parseSpreadsheet(
  bytes: Uint8Array,
  fileName: string,
  options: SpreadsheetParseOptions = {},
): Promise<ParsedSpreadsheet> {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  const hasHeader = options.hasHeader !== false

  if (extension === 'xls' || hasOleMagic(bytes)) {
    throw new SpreadsheetParseError(
      'EXCEL_LEGACY_FORMAT_UNSUPPORTED',
      `"${fileName}" is a legacy .xls workbook (or an encrypted spreadsheet). Save it as .xlsx or .csv and try again.`,
    )
  }

  if (extension === 'xlsx' || isZip(bytes)) {
    return parseXlsx(bytes, options.sheetName, hasHeader)
  }
  if (extension === 'csv' || extension === 'txt') {
    return parseCsv(bytes, fileName, hasHeader)
  }
  throw new SpreadsheetParseError(
    'EXCEL_PARSE_FAILED',
    `"${fileName}" is not a supported spreadsheet. Expected .xlsx or .csv.`,
  )
}

// --- Format sniffing ---------------------------------------------------------

function hasOleMagic(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
}

// --- ZIP ---------------------------------------------------------------------

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  dataOffset: number
  encrypted: boolean
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

class ZipArchive {
  private readBytes = 0

  private constructor(
    private readonly bytes: Uint8Array,
    private readonly entries: Map<string, ZipEntry>,
  ) {}

  static open(bytes: Uint8Array): ZipArchive {
    const eocd = findEndOfCentralDirectory(bytes)
    if (eocd < 0) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        'The .xlsx zip container is truncated or malformed.',
      )
    }
    const entryCount = readU16(bytes, eocd + 10)
    const centralSize = readU32(bytes, eocd + 12)
    const centralOffset = readU32(bytes, eocd + 16)
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        'Zip64 workbooks are not supported; re-save the file as a regular .xlsx.',
      )
    }
    if (centralOffset + centralSize > bytes.length) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        'The .xlsx central directory is out of bounds.',
      )
    }

    const entries = new Map<string, ZipEntry>()
    let cursor = centralOffset
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > bytes.length || readU32(bytes, cursor) !== CENTRAL_SIGNATURE) {
        throw new SpreadsheetParseError(
          'EXCEL_PARSE_FAILED',
          'The .xlsx central directory is malformed.',
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
        throw new SpreadsheetParseError('EXCEL_PARSE_FAILED', 'The .xlsx entry name is truncated.')
      }
      const name = UTF8.decode(bytes.subarray(nameStart, nameStart + nameLength))
      cursor = nameStart + nameLength + extraLength + commentLength

      if (localOffset + 30 > bytes.length || readU32(bytes, localOffset) !== LOCAL_SIGNATURE) {
        throw new SpreadsheetParseError(
          'EXCEL_PARSE_FAILED',
          `The .xlsx entry "${name}" has an invalid local header.`,
        )
      }
      const localNameLength = readU16(bytes, localOffset + 26)
      const localExtraLength = readU16(bytes, localOffset + 28)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      if (dataOffset + compressedSize > bytes.length) {
        throw new SpreadsheetParseError(
          'EXCEL_PARSE_FAILED',
          `The .xlsx entry "${name}" is truncated.`,
        )
      }

      entries.set(name.toLowerCase(), {
        name,
        method,
        compressedSize,
        uncompressedSize,
        dataOffset,
        encrypted: (flags & 1) === 1,
      })
    }
    return new ZipArchive(bytes, entries)
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase())
  }

  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name.toLowerCase())
    if (!entry) {
      throw new SpreadsheetParseError('EXCEL_PARSE_FAILED', `The workbook is missing "${name}".`)
    }
    if (entry.encrypted) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        'Encrypted workbooks are not supported; remove the password and try again.',
      )
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        `The workbook entry "${entry.name}" is too large to parse.`,
      )
    }
    this.readBytes += entry.uncompressedSize
    if (this.readBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        'The workbook is too large to parse safely.',
      )
    }

    const compressed = this.bytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    )
    if (entry.method === 0) return compressed.slice()
    if (entry.method !== 8) {
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        `The workbook uses unsupported compression method ${entry.method}.`,
      )
    }
    try {
      return await inflateRaw(compressed)
    } catch (error) {
      if (error instanceof SpreadsheetParseError) throw error
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        `The workbook entry "${entry.name}" could not be decompressed.`,
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

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new SpreadsheetParseError(
      'EXCEL_PARSE_FAILED',
      'This environment cannot decompress .xlsx files (DecompressionStream is unavailable).',
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
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel()
      throw new SpreadsheetParseError(
        'EXCEL_PARSE_FAILED',
        'A workbook entry decompressed beyond the size limit.',
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

// --- XML helpers -------------------------------------------------------------

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const codePoint = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(codePoint) ? safeFromCodePoint(codePoint) : whole
    }
    if (body.startsWith('#')) {
      const codePoint = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(codePoint) ? safeFromCodePoint(codePoint) : whole
    }
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return whole
    }
  })
}

function safeFromCodePoint(codePoint: number): string {
  if (codePoint < 0 || codePoint > 0x10ffff) return ''
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return ''
  }
}

function xmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const name = match[1]!
    const value = match[3] ?? match[4] ?? ''
    attributes[name] = decodeXmlEntities(value)
  }
  return attributes
}

/** Inner XML of the first `<tag>` element (namespace prefix tolerated). */
function xmlSegment(xml: string, tag: string): string {
  const openPattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>`, 'i')
  const open = openPattern.exec(xml)
  if (!open) return ''
  const contentStart = open.index + open[0].length
  const closePattern = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`, 'gi')
  closePattern.lastIndex = contentStart
  const close = closePattern.exec(xml)
  if (!close) return ''
  return xml.slice(contentStart, close.index)
}

/** Text of every `<t>` run inside a shared-string / inline-string fragment. */
function collectTextRuns(fragment: string): string {
  const pattern = /<(?:[\w.-]+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>)/gi
  let text = ''
  let match: RegExpExecArray | null
  while ((match = pattern.exec(fragment))) {
    text += decodeXmlEntities(match[1] ?? '')
  }
  return text
}

// --- Workbook structure ------------------------------------------------------

interface WorkbookSheet {
  name: string
  relationId: string
}

function parseWorkbookSheets(xml: string): WorkbookSheet[] {
  const sheetsXml = xmlSegment(xml, 'sheets') || xml
  const pattern = /<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/gi
  const sheets: WorkbookSheet[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sheetsXml))) {
    const attributes = xmlAttributes(match[1] ?? '')
    const name = attributes['name']?.trim() ?? ''
    if (!name) continue
    sheets.push({ name, relationId: attributes['r:id'] ?? attributes['relationshipId'] ?? '' })
  }
  return sheets
}

function parseWorksheetRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>()
  const pattern = /<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    const attributes = xmlAttributes(match[1] ?? '')
    const id = attributes['Id'] ?? attributes['id'] ?? ''
    const type = attributes['Type'] ?? attributes['type'] ?? ''
    const target = attributes['Target'] ?? attributes['target'] ?? ''
    if (id && target && type.endsWith('/worksheet')) relationships.set(id, target)
  }
  return relationships
}

function resolveZipTarget(basePath: string, target: string): string {
  const clean = target.replace(/\\/g, '/').trim()
  const combined = clean.startsWith('/') ? clean.slice(1) : `${basePath}/${clean}`
  const parts: string[] = []
  for (const segment of combined.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

// --- Styles ------------------------------------------------------------------

type DateKind = 'none' | 'date' | 'time' | 'datetime'

interface StyleInfo {
  dateKind: DateKind
}

function builtinDateKind(numberFormatId: number): DateKind {
  if (numberFormatId === 22) return 'datetime'
  if (
    (numberFormatId >= 14 && numberFormatId <= 17) ||
    (numberFormatId >= 27 && numberFormatId <= 31) ||
    numberFormatId === 36 ||
    (numberFormatId >= 50 && numberFormatId <= 54) ||
    numberFormatId === 57 ||
    numberFormatId === 58
  ) {
    return 'date'
  }
  if (
    (numberFormatId >= 18 && numberFormatId <= 21) ||
    (numberFormatId >= 32 && numberFormatId <= 35) ||
    (numberFormatId >= 45 && numberFormatId <= 47) ||
    (numberFormatId >= 55 && numberFormatId <= 56)
  ) {
    return 'time'
  }
  return 'none'
}

function dateKindFromFormatCode(formatCode: string): DateKind {
  const elapsedTime = /\[(h+|m+|s+)\]/i.test(formatCode)
  const stripped = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\\[\s\S]/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[_*][\s\S]/g, '')
    .toLowerCase()

  const hasTime = elapsedTime || /[hs]/.test(stripped) || /am\/pm/.test(stripped)
  const hasDate = /[yd]/.test(stripped) || (!hasTime && /m/.test(stripped))
  if (hasDate && hasTime) return 'datetime'
  if (hasDate) return 'date'
  if (hasTime) return 'time'
  return 'none'
}

function parseStyles(xml: string | null): StyleInfo[] {
  if (!xml) return []

  const customFormats = new Map<number, string>()
  const numFmtPattern = /<(?:[\w.-]+:)?numFmt\b([^>]*?)\/?>/gi
  let numFmtMatch: RegExpExecArray | null
  while ((numFmtMatch = numFmtPattern.exec(xml))) {
    const attributes = xmlAttributes(numFmtMatch[1] ?? '')
    const id = Number.parseInt(attributes['numFmtId'] ?? '', 10)
    if (Number.isFinite(id)) customFormats.set(id, attributes['formatCode'] ?? '')
  }

  const cellXfs = xmlSegment(xml, 'cellXfs')
  if (!cellXfs) return []
  const styles: StyleInfo[] = []
  const xfPattern = /<(?:[\w.-]+:)?xf\b([^>]*?)\/?>/gi
  let xfMatch: RegExpExecArray | null
  while ((xfMatch = xfPattern.exec(cellXfs))) {
    const attributes = xmlAttributes(xfMatch[1] ?? '')
    const id = Number.parseInt(attributes['numFmtId'] ?? '0', 10) || 0
    let dateKind = builtinDateKind(id)
    if (dateKind === 'none') {
      const custom = customFormats.get(id)
      if (custom !== undefined) dateKind = dateKindFromFormatCode(custom)
    }
    styles.push({ dateKind })
  }
  return styles
}

// --- Worksheet rows ----------------------------------------------------------

function columnIndexFromRef(reference: string): number | null {
  const letters = /^([A-Za-z]+)/.exec(reference.trim())?.[1]
  if (!letters) return null
  let index = 0
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64)
  }
  return index - 1
}

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 0) return null
  // Excel's 1900 date system counts the fictitious 1900-02-29; serials before
  // it are one day ahead of the 1899-12-30 epoch.
  const days = serial < 60 ? serial + 1 : serial
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86400000))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateCell(serial: number, kind: DateKind): SpreadsheetCell {
  const date = excelSerialToDate(serial)
  if (!date) return serial
  const iso = date.toISOString()
  if (kind === 'date') return iso.slice(0, 10)
  return iso
}

function parseNumericCell(raw: string, style: StyleInfo | undefined): SpreadsheetCell {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return raw
  if (style && style.dateKind !== 'none') return formatDateCell(value, style.dateKind)
  return value
}

function parseCellValue(
  attributes: Record<string, string>,
  inner: string,
  sharedStrings: readonly string[],
  styles: readonly StyleInfo[],
): SpreadsheetCell {
  const type = (attributes['t'] ?? '').toLowerCase()

  if (type === 'inlinestr') {
    return collectTextRuns(xmlSegment(inner, 'is'))
  }

  const valueMatch = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v\s*>/i.exec(inner)
  const raw = valueMatch ? decodeXmlEntities(valueMatch[1] ?? '') : ''
  if (raw === '') return null

  if (type === 's') {
    const index = Number.parseInt(raw, 10)
    return Number.isFinite(index) ? (sharedStrings[index] ?? null) : null
  }
  if (type === 'b') return raw.trim() === '1' || raw.trim().toLowerCase() === 'true'
  if (type === 'str' || type === 'd' || type === 'e') return raw

  const styleIndex = attributes['s'] === undefined ? 0 : Number.parseInt(attributes['s'], 10)
  return parseNumericCell(raw, Number.isFinite(styleIndex) ? styles[styleIndex] : undefined)
}

function parseWorksheetRows(
  xml: string,
  sharedStrings: readonly string[],
  styles: readonly StyleInfo[],
): SpreadsheetCell[][] {
  const sheetData = xmlSegment(xml, 'sheetData') || xml
  const rows: SpreadsheetCell[][] = []
  const rowPattern = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row\s*>)/gi
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(sheetData))) {
    const rowXml = rowMatch[2] ?? ''
    if (!rowXml.trim()) continue

    const cells: SpreadsheetCell[] = []
    let nextColumn = 0
    const cellPattern = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>)/gi
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(rowXml))) {
      const attributes = xmlAttributes(cellMatch[1] ?? '')
      const reference = attributes['r']
      let column = reference ? columnIndexFromRef(reference) : nextColumn
      if (column === null || column < 0) column = nextColumn
      while (cells.length < column) cells.push(null)
      cells[column] = parseCellValue(attributes, cellMatch[2] ?? '', sharedStrings, styles)
      nextColumn = column + 1
    }

    while (cells.length > 0 && isBlankCell(cells[cells.length - 1]!)) cells.pop()
    if (cells.some((cell) => !isBlankCell(cell))) rows.push(cells)
  }
  return rows
}

function isBlankCell(value: SpreadsheetCell | undefined): boolean {
  return value === null || value === undefined || value === ''
}

// --- XLSX --------------------------------------------------------------------

async function parseXlsx(
  bytes: Uint8Array,
  requestedSheet: string | undefined,
  hasHeader: boolean,
): Promise<ParsedSpreadsheet> {
  const archive = ZipArchive.open(bytes)
  if (!archive.has('xl/workbook.xml')) {
    throw new SpreadsheetParseError(
      'EXCEL_PARSE_FAILED',
      'The file is a zip archive but not an .xlsx workbook (xl/workbook.xml is missing).',
    )
  }

  const workbookXml = await archive.readText('xl/workbook.xml')
  const sheets = parseWorkbookSheets(workbookXml)
  if (sheets.length === 0) {
    throw new SpreadsheetParseError('EXCEL_PARSE_FAILED', 'The workbook contains no worksheets.')
  }

  const wantedName = requestedSheet?.trim() ?? ''
  const selected = wantedName ? sheets.find((sheet) => sheet.name === wantedName) : sheets[0]
  if (!selected) {
    const available = sheets.map((sheet) => `"${sheet.name}"`).join(', ')
    throw new SpreadsheetParseError(
      'EXCEL_SHEET_NOT_FOUND',
      `Worksheet "${wantedName}" was not found. Available worksheets: ${available}.`,
    )
  }

  const relationships = archive.has('xl/_rels/workbook.xml.rels')
    ? parseWorksheetRelationships(await archive.readText('xl/_rels/workbook.xml.rels'))
    : new Map<string, string>()
  const relationTarget = selected.relationId ? relationships.get(selected.relationId) : undefined
  const sheetPath = relationTarget
    ? resolveZipTarget('xl', relationTarget)
    : `xl/worksheets/sheet${sheets.indexOf(selected) + 1}.xml`
  if (!archive.has(sheetPath)) {
    throw new SpreadsheetParseError(
      'EXCEL_PARSE_FAILED',
      `The worksheet "${selected.name}" is missing from the workbook archive.`,
    )
  }

  const sharedStrings = archive.has('xl/sharedStrings.xml')
    ? parseSharedStrings(await archive.readText('xl/sharedStrings.xml'))
    : []
  const styles = archive.has('xl/styles.xml')
    ? parseStyles(await archive.readText('xl/styles.xml'))
    : []
  const rawRows = parseWorksheetRows(await archive.readText(sheetPath), sharedStrings, styles)
  return buildTable(rawRows, hasHeader, selected.name)
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = []
  const pattern = /<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si\s*>)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    const inner = (match[1] ?? '')
      .replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>/gi, '')
      .replace(/<(?:[\w.-]+:)?phoneticPr\b[^>]*\/?>/gi, '')
    strings.push(collectTextRuns(inner))
  }
  return strings
}

// --- CSV ---------------------------------------------------------------------

function detectCsvDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  const limit = Math.min(text.length, 64 * 1024)
  let inQuotes = false
  for (let index = 0; index < limit; index += 1) {
    const char = text[index]!
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1
      else inQuotes = !inQuotes
    } else if (!inQuotes && char in counts) {
      counts[char] = counts[char]! + 1
    }
  }
  const ranked = [',', ';', '\t'].sort((left, right) => counts[right]! - counts[left]!)
  return ranked[0]!
}

function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let fieldStarted = false
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
    fieldStarted = false
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      fieldStarted = true
    } else if (char === delimiter) {
      pushField()
    } else if (char === '\n') {
      pushRow()
    } else if (char === '\r') {
      if (text[index + 1] !== '\n') pushRow()
    } else {
      field += char
      fieldStarted = true
    }
  }

  if (field !== '' || row.length > 0 || fieldStarted) pushField()
  if (row.length > 0) rows.push(row)
  return rows
}

function sheetNameFromFileName(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).trim()
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base) || 'CSV'
}

function parseCsv(bytes: Uint8Array, fileName: string, hasHeader: boolean): ParsedSpreadsheet {
  const text = UTF8.decode(bytes).replace(/^\ufeff/, '')
  const delimiter = detectCsvDelimiter(text)
  const rawRows = parseCsvRows(text, delimiter)
  return buildTable(rawRows, hasHeader, sheetNameFromFileName(fileName))
}

// --- Row shaping -------------------------------------------------------------

function buildTable(
  parsedRows: SpreadsheetCell[][],
  hasHeader: boolean,
  sheetName: string,
): ParsedSpreadsheet {
  const rawRows = parsedRows.filter((row) => row.some((cell) => !isBlankCell(cell)))
  const width = rawRows.reduce((max, row) => Math.max(max, row.length), 0)
  if (width === 0) return { sheetName, rows: [], rawRows }

  if (!hasHeader) {
    const headers = Array.from({ length: width }, (_, index) => `column${index + 1}`)
    return {
      sheetName,
      rawRows,
      rows: rawRows.map((row) => rowToObject(row, headers)),
    }
  }

  const headerRow = rawRows[0] ?? []
  const headers = buildHeaders(headerRow, width)
  return {
    sheetName,
    rawRows,
    rows: rawRows.slice(1).map((row) => rowToObject(row, headers)),
  }
}

function buildHeaders(headerRow: SpreadsheetCell[], width: number): string[] {
  const headers: string[] = []
  const used = new Set<string>()
  for (let index = 0; index < width; index += 1) {
    const cell = headerRow[index]
    const base = cell === null || cell === undefined ? '' : String(cell).trim()
    const candidate = base || `column${index + 1}`
    let key = candidate
    let suffix = 2
    while (used.has(key)) {
      key = `${candidate}_${suffix}`
      suffix += 1
    }
    used.add(key)
    headers.push(key)
  }
  return headers
}

function rowToObject(row: SpreadsheetCell[], headers: string[]): Record<string, SpreadsheetCell> {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]))
}

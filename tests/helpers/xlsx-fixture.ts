/**
 * Hand-built `.xlsx` fixtures. The repository ships no spreadsheet library, so
 * tests assemble the OOXML files and the zip container themselves.
 */

import { deflateRawSync } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function littleEndianU16(value: number): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

function littleEndianU32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true)
  return bytes
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** Minimal zip writer (deflate or stored, no Zip64) for `.xlsx` fixtures. */
export function buildZip(
  entries: Record<string, string | Uint8Array>,
  options: { store?: boolean } = {},
): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === 'string' ? encodeText(content) : content
    const stored = options.store === true
    const payload = stored ? raw : new Uint8Array(deflateRawSync(raw))
    const method = stored ? 0 : 8
    const nameBytes = encodeText(name)
    const checksum = crc32(raw)

    const localHeader = new Uint8Array(30)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, LOCAL_SIGNATURE, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, method, true)
    localView.setUint16(10, 0, true)
    localView.setUint16(12, 0x21, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, raw.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)

    const localPart = concat([localHeader, nameBytes, payload])
    localParts.push(localPart)

    const centralHeader = new Uint8Array(46)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, CENTRAL_SIGNATURE, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0, true)
    centralView.setUint16(10, method, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint16(14, 0x21, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, raw.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, offset, true)
    centralParts.push(concat([centralHeader, nameBytes]))

    offset += localPart.length
  }

  const centralDirectory = concat(centralParts)
  const eocd = concat([
    littleEndianU32(EOCD_SIGNATURE),
    littleEndianU16(0),
    littleEndianU16(0),
    littleEndianU16(Object.keys(entries).length),
    littleEndianU16(Object.keys(entries).length),
    littleEndianU32(centralDirectory.length),
    littleEndianU32(offset),
    littleEndianU16(0),
  ])
  return concat([...localParts, centralDirectory, eocd])
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface XlsxSheetInput {
  name: string
  /** Full `<worksheet>…</worksheet>` XML. */
  xml: string
}

export interface XlsxFixtureOptions {
  sheets: XlsxSheetInput[]
  /** Plain strings (escaped for you) or a raw `sharedStrings.xml` document. */
  sharedStrings?: string[] | string
  /** Raw `styles.xml` document. */
  stylesXml?: string
  store?: boolean
}

/** Assemble a workbook zip with workbook/rels/worksheets wired together. */
export function buildXlsx(options: XlsxFixtureOptions): Uint8Array {
  const entries: Record<string, string | Uint8Array> = {}

  const sheetEntries = options.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('')
  entries['xl/workbook.xml'] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetEntries}</sheets></workbook>`

  const relationships = options.sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        `Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('')
  entries['xl/_rels/workbook.xml.rels'] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`

  options.sheets.forEach((sheet, index) => {
    entries[`xl/worksheets/sheet${index + 1}.xml`] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + sheet.xml
  })

  if (options.sharedStrings !== undefined) {
    entries['xl/sharedStrings.xml'] = Array.isArray(options.sharedStrings)
      ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        options.sharedStrings
          .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
          .join('') +
        '</sst>'
      : options.sharedStrings
  }

  if (options.stylesXml !== undefined) entries['xl/styles.xml'] = options.stylesXml

  return buildZip(entries, { store: options.store })
}

/** Convenience wrapper for a one-row-per-array sheet body. */
export function sheetXml(rows: string): string {
  return (
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData></worksheet>`
  )
}

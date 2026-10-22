import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZipArchive } from '../src/lib/zip/zip-archive'
import { buildZip } from './helpers/xlsx-fixture'

const TEXT = new TextDecoder()

function patchU16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true)
  return bytes
}

function patchU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true)
  return bytes
}

/** EOCD is the last 22 bytes because `buildZip` writes no archive comment. */
function eocdOffset(bytes: Uint8Array): number {
  return bytes.length - 22
}

function centralOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(eocdOffset(bytes) + 16, true)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ZipArchive · reading', () => {
  it('reads deflated and stored entries case-insensitively', async () => {
    const deflated = ZipArchive.open(buildZip({ 'a/Hello.txt': 'hello' }))
    expect(deflated.has('A/HELLO.TXT')).toBe(true)
    await expect(deflated.readText('a/hello.txt')).resolves.toBe('hello')

    const stored = ZipArchive.open(buildZip({ 'a/Hello.txt': 'hello' }, { store: true }))
    await expect(stored.readText('A/hello.TXT')).resolves.toBe('hello')
  })

  it('keeps binary bytes intact', async () => {
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255])
    const archive = ZipArchive.open(buildZip({ 'blob.bin': payload }))
    expect(await archive.read('blob.bin')).toEqual(payload)
  })

  it('lists directory records and every entry in archive order', () => {
    const archive = ZipArchive.open(
      buildZip({
        'folder/': '',
        'folder/a.txt': 'a',
        'root.txt': 'r',
      }),
    )
    expect(archive.entries.map((entry) => entry.name)).toEqual([
      'folder/',
      'folder/a.txt',
      'root.txt',
    ])
    expect(archive.entries[0]!.isDirectory).toBe(true)
    expect(archive.entries[1]!.isDirectory).toBe(false)
    expect(archive.get('FOLDER/A.TXT')?.uncompressedSize).toBe(1)
  })

  it('rejects reading a directory record', async () => {
    const archive = ZipArchive.open(buildZip({ 'folder/': '' }))
    await expect(archive.read('folder/')).rejects.toMatchObject({
      code: 'ZIP_ENTRY_IS_DIRECTORY',
    })
  })

  it('reports a missing entry by its requested name', async () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'a' }))
    await expect(archive.read('missing.txt')).rejects.toMatchObject({
      code: 'ZIP_ENTRY_MISSING',
      entryName: 'missing.txt',
    })
  })

  it('counts repeated reads against the total budget', async () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'abcdef' }), {
      maxTotalUncompressedBytes: 6,
    })
    expect(TEXT.decode(await archive.read('a.txt'))).toBe('abcdef')
    await expect(archive.read('a.txt')).rejects.toMatchObject({ code: 'ZIP_TOTAL_TOO_LARGE' })
  })

  it('rejects an entry above maxEntryBytes before inflating', async () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'abcdef' }), { maxEntryBytes: 3 })
    await expect(archive.read('a.txt')).rejects.toMatchObject({ code: 'ZIP_ENTRY_TOO_LARGE' })
  })

  it('rejects an archive whose declared total exceeds the budget at open', () => {
    expect(() =>
      ZipArchive.open(buildZip({ 'a.txt': 'abcdef' }), { maxTotalUncompressedBytes: 3 }),
    ).toThrow(expect.objectContaining({ code: 'ZIP_TOTAL_TOO_LARGE' }))
  })

  it('stops inflating past maxEntryBytes even when the header under-declares', async () => {
    const bytes = buildZip({ 'a.txt': 'x'.repeat(5000) })
    patchU32(bytes, centralOffset(bytes) + 24, 10)
    const archive = ZipArchive.open(bytes, { maxEntryBytes: 100 })
    await expect(archive.read('a.txt')).rejects.toMatchObject({
      code: 'ZIP_DECOMPRESSED_TOO_LARGE',
    })
  })

  it('reports a missing DecompressionStream instead of failing obscurely', async () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'hello' }))
    vi.stubGlobal('DecompressionStream', undefined)
    await expect(archive.read('a.txt')).rejects.toMatchObject({
      code: 'ZIP_DECOMPRESSION_UNAVAILABLE',
    })
  })
})

describe('ZipArchive · malformed archives', () => {
  it('rejects a truncated archive', () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    expect(() => ZipArchive.open(bytes.slice(0, bytes.length - 5))).toThrow(
      expect.objectContaining({ code: 'ZIP_TRUNCATED' }),
    )
  })

  it('rejects Zip64 markers', () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    patchU16(bytes, eocdOffset(bytes) + 10, 0xffff)
    expect(() => ZipArchive.open(bytes)).toThrow(
      expect.objectContaining({ code: 'ZIP_ZIP64_UNSUPPORTED' }),
    )
  })

  it('rejects a central directory outside the buffer', () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    patchU32(bytes, eocdOffset(bytes) + 16, 0x0fffffff)
    expect(() => ZipArchive.open(bytes)).toThrow(
      expect.objectContaining({ code: 'ZIP_CENTRAL_DIRECTORY_OUT_OF_BOUNDS' }),
    )
  })

  it('rejects an entry whose data runs past the buffer', () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    patchU32(bytes, centralOffset(bytes) + 20, 0x0fffffff)
    expect(() => ZipArchive.open(bytes)).toThrow(
      expect.objectContaining({ code: 'ZIP_ENTRY_TRUNCATED', entryName: 'a.txt' }),
    )
  })

  it('rejects an invalid local header and keeps the entry name', () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    patchU32(bytes, centralOffset(bytes) + 42, 1)
    expect(() => ZipArchive.open(bytes)).toThrow(
      expect.objectContaining({ code: 'ZIP_ENTRY_LOCAL_HEADER_INVALID', entryName: 'a.txt' }),
    )
  })

  it('rejects encrypted entries', async () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    patchU16(bytes, centralOffset(bytes) + 8, 1)
    const archive = ZipArchive.open(bytes)
    await expect(archive.read('a.txt')).rejects.toMatchObject({
      code: 'ZIP_ENCRYPTED_UNSUPPORTED',
    })
  })

  it('rejects unsupported compression methods with the method number', async () => {
    const bytes = buildZip({ 'a.txt': 'hello' })
    patchU16(bytes, centralOffset(bytes) + 10, 99)
    const archive = ZipArchive.open(bytes)
    await expect(archive.read('a.txt')).rejects.toMatchObject({
      code: 'ZIP_METHOD_UNSUPPORTED',
      method: 99,
    })
  })

  it('caps the number of central-directory records', () => {
    const bytes = buildZip({ 'a.txt': 'a', 'b.txt': 'b' })
    expect(() => ZipArchive.open(bytes, { maxEntries: 1 })).toThrow(
      expect.objectContaining({ code: 'ZIP_TOO_MANY_ENTRIES' }),
    )
  })
})

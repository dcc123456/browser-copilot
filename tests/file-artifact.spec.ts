/**
 * WorkflowFileArtifact normalization tests (U001-U011).
 *
 * Covers data URL validation/parsing and `normalizeWorkflowFiles` for the
 * three accepted shapes (data URL string, single artifact, artifact array)
 * plus the invalid inputs that must fail before an upload is attempted.
 */
import { describe, expect, it } from 'vitest'
import {
  UploadFileError,
  base64ByteLength,
  decodeDataUrlBytes,
  extensionForMimeType,
  isDataUrl,
  isValidMimeType,
  normalizeWorkflowFiles,
  parseDataUrl,
  type WorkflowFileArtifact,
} from '../src/lib/workflow/file-artifact'

// 1x1 transparent PNG.
const PNG_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG_URL = 'data:image/jpeg;base64,/9j/4AAQ'
const PDF_URL = 'data:application/pdf;base64,JVBERi0='

function artifact(overrides: Partial<WorkflowFileArtifact> = {}): WorkflowFileArtifact {
  return {
    type: 'file',
    name: 'a.png',
    mimeType: 'image/png',
    dataUrl: PNG_URL,
    source: 'generated-image',
    ...overrides,
  }
}

describe('isDataUrl / parseDataUrl', () => {
  it('U: recognizes image data URLs', () => {
    expect(isDataUrl(PNG_URL)).toBe(true)
    expect(isDataUrl(JPEG_URL)).toBe(true)
    expect(isDataUrl(PDF_URL)).toBe(true)
  })

  it('rejects non-data strings', () => {
    expect(isDataUrl('hello')).toBe(false)
    expect(isDataUrl('/Users/me/a.png')).toBe(false)
    expect(isDataUrl('data:')).toBe(false)
    expect(isDataUrl(42)).toBe(false)
    expect(isDataUrl(null)).toBe(false)
  })

  it('parses mime type and base64 payload', () => {
    const parsed = parseDataUrl(PNG_URL)
    expect(parsed?.mimeType).toBe('image/png')
    expect(parsed?.isBase64).toBe(true)
    expect(parsed?.base64.startsWith('iVBOR')).toBe(true)
  })
})

describe('normalizeWorkflowFiles', () => {
  it('U006: single data URL', () => {
    const [a] = normalizeWorkflowFiles(PNG_URL)
    expect(a!.name).toMatch(/\.png$/)
    expect(a!.mimeType).toBe('image/png')
    expect(a!.dataUrl).toBe(PNG_URL)
    expect(typeof a!.size).toBe('number')
  })

  it('U007: single artifact', () => {
    const [a] = normalizeWorkflowFiles(artifact())
    expect(a).toMatchObject({
      name: 'a.png',
      mimeType: 'image/png',
      source: 'generated-image',
    })
  })

  it('U008: artifact array', () => {
    const out = normalizeWorkflowFiles([
      artifact({ name: 'a.png' }),
      artifact({ name: 'b.jpg', mimeType: 'image/jpeg', dataUrl: JPEG_URL }),
    ])
    expect(out).toHaveLength(2)
    expect(out.map((f) => f.name)).toEqual(['a.png', 'b.jpg'])
  })

  it('accepts a mixed array of data URLs and artifacts', () => {
    const out = normalizeWorkflowFiles([PNG_URL, artifact({ name: 'x.png' })])
    expect(out).toHaveLength(2)
  })

  it('U009: invalid data URL string fails', () => {
    expect(() => normalizeWorkflowFiles('not-a-data-url')).toThrow(UploadFileError)
  })

  it('U010: missing name fails', () => {
    expect(() => normalizeWorkflowFiles(artifact({ name: '  ' }))).toThrow(/name/)
  })

  it('U011: invalid mime type fails', () => {
    expect(() => normalizeWorkflowFiles(artifact({ mimeType: 'png' }))).toThrow(/MIME/)
  })

  it('rejects null / undefined / empty array', () => {
    expect(() => normalizeWorkflowFiles(undefined)).toThrow(UploadFileError)
    expect(() => normalizeWorkflowFiles(null)).toThrow(UploadFileError)
    expect(() => normalizeWorkflowFiles([])).toThrow(UploadFileError)
  })

  it('rejects an artifact with an invalid data URL', () => {
    expect(() => normalizeWorkflowFiles(artifact({ dataUrl: 'nope' }))).toThrow(
      /data URL/,
    )
  })

  it('coerces unknown source to other', () => {
    const [a] = normalizeWorkflowFiles(
      artifact({ source: 'made-up' as unknown as WorkflowFileArtifact['source'] }),
    )
    expect(a!.source).toBe('other')
  })
})

describe('misc helpers', () => {
  it('validates MIME types', () => {
    expect(isValidMimeType('image/png')).toBe(true)
    expect(isValidMimeType('application/vnd.ms-excel')).toBe(true)
    expect(isValidMimeType('png')).toBe(false)
  })

  it('maps MIME to extension', () => {
    expect(extensionForMimeType('application/pdf')).toBe('pdf')
    expect(extensionForMimeType('image/jpeg')).toBe('jpg')
  })

  it('estimates base64 byte length', () => {
    expect(base64ByteLength('AAAA')).toBe(3)
    expect(base64ByteLength('AAA=')).toBe(2)
  })

  it('decodes data URL bytes', () => {
    const bytes = decodeDataUrlBytes('data:text/plain;base64,aGVsbG8=')
    expect(Buffer.from(bytes).toString()).toBe('hello')
  })
})

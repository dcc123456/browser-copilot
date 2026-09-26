/**
 * Unified Workflow file artifact model.
 *
 * Every file that flows through a Workflow — a user-picked local file, a
 * screenshot, a JavaScript-generated image, a downloaded or generated binary —
 * is normalized to the same shape (`WorkflowFileArtifact`) before it reaches
 * the page-upload entry point. Plain data URLs and arrays of either shape are
 * accepted at the boundary and normalized here.
 *
 * Pure module (no `chrome`, no DOM): the engine, executors, repair and tests
 * all share it.
 *
 * @module lib/workflow/file-artifact
 */

/** Where a Workflow file came from. */
export type WorkflowFileSource =
  | 'user'
  | 'screenshot'
  | 'javascript'
  | 'download'
  | 'generated-image'
  | 'other'

/** A file carried inside a Workflow. */
export interface WorkflowFileArtifact {
  type: 'file'
  /** Filename with extension (no local absolute path is ever stored). */
  name: string
  mimeType: string
  /** Byte size when known. */
  size?: number
  /** The file's content as a data URL (`data:<mime>;base64,...`). */
  dataUrl: string
  width?: number
  height?: number
  source: WorkflowFileSource
}

/**
 * Upload failure codes (spec §16). `UploadFileError.code` carries one of these;
 * the engine surfaces it to AI repair.
 */
export type UploadFileErrorCode =
  | 'UPLOAD_TARGET_NOT_FOUND'
  | 'UPLOAD_TARGET_NOT_FILE_INPUT'
  | 'UPLOAD_FILE_VARIABLE_NOT_FOUND'
  | 'UPLOAD_FILE_VARIABLE_INVALID'
  | 'UPLOAD_FILE_DATA_INVALID'
  | 'UPLOAD_MULTIPLE_NOT_SUPPORTED'
  | 'UPLOAD_USER_SELECTION_CANCELLED'
  | 'UPLOAD_USER_SELECTION_TIMEOUT'
  | 'UPLOAD_FILE_INJECTION_FAILED'
  | 'UPLOAD_FILE_VERIFICATION_FAILED'
  | 'UPLOAD_DROPZONE_UNSUPPORTED'

/** Error carrying a structured upload code plus machine-context for repair. */
export class UploadFileError extends Error {
  readonly code: UploadFileErrorCode
  readonly nodeId?: string
  readonly selector?: string

  constructor(
    code: UploadFileErrorCode,
    message: string,
    context?: { nodeId?: string; selector?: string },
  ) {
    // Prefix the message with the code: the engine emits only the message
    // string, and the failure classifier parses structured code prefixes.
    super(`${code}: ${message}`)
    this.name = 'UploadFileError'
    this.code = code
    if (context?.nodeId !== undefined) this.nodeId = context.nodeId
    if (context?.selector !== undefined) this.selector = context.selector
  }
}

// --- Data URL helpers --------------------------------------------------------

const DATA_URL_RE = /^data:([\w][\w!#$&^+.|-]*\/[\w!#$&^+.|-]*)?(;[^,]*)?,(.*)$/s

/** True when `value` is syntactically a data URL (base64 or URL-encoded). */
export function isDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('data:')) return false
  // At least a comma separating headers from payload.
  return DATA_URL_RE.test(value)
}

/**
 * Parse a data URL into its MIME type and the base64 payload body (the part
 * after the comma). Returns null when it is not a well-formed data URL.
 */
export function parseDataUrl(
  value: string,
): { mimeType: string; base64: string; isBase64: boolean } | null {
  const match = DATA_URL_RE.exec(value)
  if (!match) return null
  const mimeType = match[1] || 'application/octet-stream'
  const params = match[2] ?? ''
  const base64 = match[3] ?? ''
  return { mimeType, base64, isBase64: /;base64$/.test(params) }
}

/**
 * Decode a (possibly URL-encoded) data URL payload into raw bytes.
 * Throws when the base64 payload is malformed.
 */
export function decodeDataUrlBytes(value: string): Uint8Array {
  const parsed = parseDataUrl(value)
  if (!parsed) throw new Error('Invalid data URL')
  if (!parsed.isBase64) {
    if (typeof atob === 'function') {
      const text = decodeURIComponent(parsed.base64)
      return new TextEncoder().encode(text)
    }
    return new TextEncoder().encode(decodeURIComponent(parsed.base64))
  }
  const clean = parsed.base64.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Approximate byte length of a base64 payload without decoding it. */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/\s+/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length / 4) * 3) - padding
}

// --- MIME / filename helpers -------------------------------------------------

/** A reasonably conservative MIME-type check (`type/subtype`). */
export function isValidMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[\w!#$&^+.|-]+\/[\w!#$&^+.|-]+$/i.test(value.trim())
  )
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
}

/** Infer a filename extension from a MIME type (undefined when unknown). */
export function extensionForMimeType(mimeType: string): string | undefined {
  return EXT_BY_MIME[mimeType.toLowerCase().trim()]
}

const MIME_BY_EXT: Record<string, string> = Object.entries(EXT_BY_MIME).reduce(
  (acc, [mime, ext]) => {
    acc[ext] = mime
    return acc
  },
  {} as Record<string, string>,
)

/** Infer a MIME type from a filename extension (undefined when unknown). */
export function mimeTypeForFilename(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()]
}

/** True when `value` looks like a Workflow file artifact object. */
export function isFileArtifact(value: unknown): value is WorkflowFileArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    v['type'] === 'file' &&
    typeof v['name'] === 'string' &&
    typeof v['mimeType'] === 'string' &&
    typeof v['dataUrl'] === 'string'
  )
}

// --- Normalization -----------------------------------------------------------

const SOURCES: readonly WorkflowFileSource[] = [
  'user',
  'screenshot',
  'javascript',
  'download',
  'generated-image',
  'other',
]

/** Sanitize a source field, falling back to `other`. */
function sourceOf(value: unknown): WorkflowFileSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
    ? (value as WorkflowFileSource)
    : 'other'
}

/**
 * Normalize one non-array value to a file artifact.
 *
 * - a data URL string becomes an artifact (name derived / supplied separately
 *   by the caller only when possible — here a timestamped mime-based name);
 * - a valid artifact is validated and returned;
 * - anything else throws `UPLOAD_FILE_DATA_INVALID`.
 */
function normalizeOne(value: unknown): WorkflowFileArtifact {
  if (typeof value === 'string') {
    if (!isDataUrl(value)) {
      throw new UploadFileError(
        'UPLOAD_FILE_DATA_INVALID',
        'File value is a string but not a valid data: URL.',
      )
    }
    const parsed = parseDataUrl(value) as { mimeType: string; base64: string }
    const ext = extensionForMimeType(parsed.mimeType) ?? 'bin'
    return {
      type: 'file',
      name: `file-${Date.now()}.${ext}`,
      mimeType: parsed.mimeType,
      size: base64ByteLength(parsed.base64),
      dataUrl: value,
      source: 'other',
    }
  }

  if (!isFileArtifact(value)) {
    throw new UploadFileError(
      'UPLOAD_FILE_DATA_INVALID',
      'File value is neither a data URL nor a Workflow file artifact.',
    )
  }

  const name = value.name.trim()
  if (!name) {
    throw new UploadFileError('UPLOAD_FILE_DATA_INVALID', 'File artifact is missing a name.')
  }
  if (!isValidMimeType(value.mimeType)) {
    throw new UploadFileError(
      'UPLOAD_FILE_DATA_INVALID',
      `File artifact "${name}" has an invalid MIME type: ${String(value.mimeType)}`,
    )
  }
  if (!isDataUrl(value.dataUrl)) {
    throw new UploadFileError(
      'UPLOAD_FILE_DATA_INVALID',
      `File artifact "${name}" has an invalid data URL.`,
    )
  }

  const artifact: WorkflowFileArtifact = {
    type: 'file',
    name,
    mimeType: value.mimeType.toLowerCase().trim(),
    dataUrl: value.dataUrl,
    source: sourceOf(value.source),
  }
  if (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0) {
    artifact.size = value.size
  }
  if (typeof value.width === 'number') artifact.width = value.width
  if (typeof value.height === 'number') artifact.height = value.height
  return artifact
}

/**
 * Normalize an arbitrary Workflow file value into an array of artifacts.
 *
 * Accepts a data URL string, a single artifact, or an array of either (arrays
 * may mix both). An empty array / undefined throws `UPLOAD_FILE_DATA_INVALID`
 * through the `required` behavior — callers distinguish a *missing variable*
 * (undefined, `UPLOAD_FILE_VARIABLE_NOT_FOUND`) before calling this.
 */
export function normalizeWorkflowFiles(value: unknown): WorkflowFileArtifact[] {
  if (value === undefined || value === null) {
    throw new UploadFileError(
      'UPLOAD_FILE_DATA_INVALID',
      'No file data was provided to upload.',
    )
  }
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) {
    throw new UploadFileError(
      'UPLOAD_FILE_DATA_INVALID',
      'File artifact array is empty.',
    )
  }
  return list.map(normalizeOne)
}

/**
 * Build a file artifact from raw bytes (used by the side panel when the user
 * picks a local `File` — its bytes are read into a data URL so the file can
 * travel through the Workflow without an OS path).
 */
export function artifactFromBytes(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  source: WorkflowFileSource = 'user',
  extra?: { width?: number; height?: number },
): WorkflowFileArtifact {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : binary
  const mime = mimeType || mimeTypeForFilename(name) || 'application/octet-stream'
  return {
    type: 'file',
    name,
    mimeType: mime,
    size: bytes.length,
    dataUrl: `data:${mime};base64,${base64}`,
    source,
    ...(extra?.width !== undefined ? { width: extra.width } : {}),
    ...(extra?.height !== undefined ? { height: extra.height } : {}),
  }
}

/** Read a browser `File` into a Workflow artifact. */
export async function artifactFromFile(file: File): Promise<WorkflowFileArtifact> {
  const buffer = await file.arrayBuffer()
  return artifactFromBytes(file.name, file.type, new Uint8Array(buffer), 'user')
}

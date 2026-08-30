/**
 * Attachment support for chat messages.
 *
 * A user turn can carry a small number of files alongside its text: images
 * (stored as data URLs and sent to the model as OpenAI-compatible `image_url`
 * content parts) and small text files (stored decoded and inlined as fenced
 * text). This module is the single source of truth for the descriptor shape,
 * the size/count limits, and the validation both the panel (before send) and
 * the service worker (on receipt) run.
 *
 * Descriptors are persisted inside the conversation transcript, so an
 * attachment survives panel closure and service-worker eviction. The limits
 * below are sized so one message can never approach chrome.storage.local's
 * ~10 MB quota on its own.
 *
 * @module lib/attachments
 */

/** One file attached to a user chat turn. */
export interface AttachmentDescriptor {
  /** Stable id, used as a list key and for removing a pending chip. */
  id: string
  /** Original file name, shown on chips and used in model-facing labels. */
  name: string
  /** MIME type (guessed from the file, falling back to the extension). */
  mimeType: string
  /** Raw byte size of the original file. */
  size: number
  /** Data URL for image attachments (`data:image/png;base64,…`). */
  dataUrl?: string
  /** Decoded text for text attachments, truncated to {@link MAX_TEXT_BYTES}. */
  content?: string
}

/**
 * Slimmed descriptor sent over the agent port when a transcript is replayed
 * (`restore` / `conversations.get`): enough to re-render chips and image
 * thumbnails without resending potentially large text content, which the
 * worker reloads from storage itself.
 */
export type AttachmentSummary = Omit<AttachmentDescriptor, 'content'>

/** Max images/text files per message. */
export const MAX_ATTACHMENTS = 4
/** Max raw bytes for one image (≈5.4 MB as base64). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** Max raw bytes for one text file. */
export const MAX_TEXT_BYTES = 200 * 1024
/** Max combined raw bytes of all attachments on one message. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** Image types the model path supports as data URLs. */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** File extensions treated as inlinable text. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.html',
  '.htm',
  '.py',
  '.sh',
])

/** Value for `<input type="file" accept>` covering everything we allow. */
export const FILE_INPUT_ACCEPT = [...IMAGE_MIME_TYPES].join(',') + ',' + [...TEXT_EXTENSIONS].join(',')

/** Why a file was rejected. */
export type AttachmentErrorCode =
  | 'too-many'
  | 'unsupported'
  | 'too-large-image'
  | 'too-large-text'
  | 'total-too-large'

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function isTextLike(name: string, mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(extensionOf(name))
}

/** True when the descriptor carries an image (and can be shown as a thumbnail). */
export function isImageAttachment(attachment: Pick<AttachmentDescriptor, 'dataUrl'>): boolean {
  return typeof attachment.dataUrl === 'string' && attachment.dataUrl.startsWith('data:image/')
}

/** True when the descriptor carries inline text content. */
export function isTextAttachment(attachment: Pick<AttachmentDescriptor, 'content'>): boolean {
  return typeof attachment.content === 'string'
}

/**
 * Validates one file's metadata against the limits and the attachments already
 * accepted on the same message. Returns a rejection code, or `null` to accept.
 *
 * Pure metadata check — the file's bytes are read separately by
 * {@link fileToDraft}, so the panel can reject oversized files before paying
 * for the base64 read.
 */
export function validateAttachmentMeta(
  meta: { name: string; size: number; mimeType: string },
  existing: readonly AttachmentDescriptor[],
): AttachmentErrorCode | null {
  if (existing.length >= MAX_ATTACHMENTS) return 'too-many'
  const image = IMAGE_MIME_TYPES.has(meta.mimeType)
  if (!image && !isTextLike(meta.name, meta.mimeType)) return 'unsupported'
  if (image && meta.size > MAX_IMAGE_BYTES) return 'too-large-image'
  if (!image && meta.size > MAX_TEXT_BYTES) return 'too-large-text'
  const total = existing.reduce((sum, attachment) => sum + attachment.size, 0)
  if (total + meta.size > MAX_TOTAL_BYTES) return 'total-too-large'
  return null
}

/** Generates a reasonably unique descriptor id. */
function nextAttachmentId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

/** Decodes the base64 payload of a data URL into text (UTF-8). */
function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function guessMimeFromName(name: string): string {
  switch (extensionOf(name)) {
    case '.gif':
      return 'image/gif'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.txt':
      return 'text/plain'
    case '.md':
    case '.markdown':
      return 'text/markdown'
    case '.json':
      return 'application/json'
    case '.csv':
      return 'text/csv'
    case '.html':
    case '.htm':
      return 'text/html'
    case '.css':
      return 'text/css'
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      return 'text/javascript'
    case '.xml':
      return 'text/xml'
    case '.yml':
    case '.yaml':
      return 'text/yaml'
    default:
      return ''
  }
}

/**
 * Reads one `File` into an attachment descriptor: images as a data URL, text
 * files as decoded (truncated) content. Throws when the file cannot be read.
 */
export async function fileToDraft(file: File): Promise<AttachmentDescriptor> {
  const mimeType = file.type || guessMimeFromName(file.name)
  const dataUrl = await readAsDataUrl(file)
  const draft: AttachmentDescriptor = {
    id: nextAttachmentId(),
    name: file.name,
    mimeType: mimeType || 'application/octet-stream',
    size: file.size,
  }
  if (mimeType.startsWith('image/')) {
    draft.dataUrl = dataUrl
  } else {
    // The validator caps the file at MAX_TEXT_BYTES, so this character slice is
    // only a belt-and-braces guard (chars ≤ UTF-8 bytes for any encoding).
    draft.content = decodeDataUrlText(dataUrl).slice(0, MAX_TEXT_BYTES)
  }
  return draft
}

/** Strips text content from descriptors, for replay over the agent port. */
export function toAttachmentSummaries(attachments: readonly AttachmentDescriptor[]): AttachmentSummary[] {
  return attachments.map(({ id, name, mimeType, size, dataUrl }) => ({
    id,
    name,
    mimeType,
    size,
    ...(dataUrl ? { dataUrl } : {}),
  }))
}

function asDescriptor(value: unknown): AttachmentDescriptor | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AttachmentDescriptor>
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return null
  if (typeof candidate.size !== 'number' || !Number.isFinite(candidate.size) || candidate.size < 0) return null
  if (typeof candidate.dataUrl !== 'string' && typeof candidate.content !== 'string') return null
  if (typeof candidate.dataUrl === 'string' && !candidate.dataUrl.startsWith('data:')) return null
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : nextAttachmentId(),
    name: candidate.name,
    mimeType: typeof candidate.mimeType === 'string' && candidate.mimeType ? candidate.mimeType : 'application/octet-stream',
    size: candidate.size,
    ...(typeof candidate.dataUrl === 'string' ? { dataUrl: candidate.dataUrl } : {}),
    ...(typeof candidate.content === 'string' ? { content: candidate.content } : {}),
  }
}

/**
 * Re-validates panel-supplied attachments on the worker side, where the panel
 * cannot be trusted (and a stale panel may predate the current limits).
 *
 * Malformed or over-limit entries are dropped rather than failing the whole
 * turn; the caller reports each rejection as a status line.
 */
export function sanitizeAttachments(
  input: readonly unknown[] | undefined,
): { kept: AttachmentDescriptor[]; rejected: { name: string; code: AttachmentErrorCode }[] } {
  const kept: AttachmentDescriptor[] = []
  const rejected: { name: string; code: AttachmentErrorCode }[] = []
  for (const value of input ?? []) {
    const descriptor = asDescriptor(value)
    if (!descriptor) {
      // Keep whatever name we can salvage so the status line is actionable.
      const attempted =
        typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string'
          ? ((value as { name: string }).name as string)
          : '(unknown file)'
      rejected.push({ name: attempted || '(unknown file)', code: 'unsupported' })
      continue
    }
    const code = validateAttachmentMeta(descriptor, kept)
    if (code) rejected.push({ name: descriptor.name, code })
    else kept.push(descriptor)
  }
  return { kept, rejected }
}

/**
 * English status-line text for one rejection, used by the worker (which, like
 * the rest of its worker-side statuses, does not localize). The panel-side
 * equivalents live in i18n.
 */
export function rejectionMessage(name: string, code: AttachmentErrorCode): string {
  switch (code) {
    case 'too-many':
      return `Too many attachments (max ${MAX_ATTACHMENTS} per message)`
    case 'unsupported':
      return `${name} is not a supported file type`
    case 'too-large-image':
      return `${name} is too large (images ≤ ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`
    case 'too-large-text':
      return `${name} is too large (text files ≤ ${MAX_TEXT_BYTES / 1024} KB)`
    case 'total-too-large':
      return `Attachments exceed the total size limit (${MAX_TOTAL_BYTES / (1024 * 1024)} MB)`
  }
}

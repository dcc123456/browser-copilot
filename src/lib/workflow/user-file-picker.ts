/**
 * User file-picker request: background → side panel.
 *
 * A Workflow's `upload-file` block in `user-select` mode needs the user to
 * pick a local file through the OS file chooser. The MV3 service worker has
 * no document and cannot open it; the side panel shows a "Choose file" card
 * and opens a hidden `<input type=file>` from the real user gesture. This
 * module only performs the `chrome.runtime` round trip — same pattern as
 * `lib/download-dir`'s save-picker request.
 *
 * The panel answers with the picked files already normalized to
 * `WorkflowFileArtifact[]` (raw bytes travel through the message; no local
 * absolute path is ever stored or returned).
 *
 * @module lib/workflow/user-file-picker
 */

import {
  UploadFileError,
  type WorkflowFileArtifact,
} from './file-artifact'

/** Message type for the file-picker request (background → panel). */
export const USER_FILE_PICKER_REQUEST = 'workflow:user-file-required'

export interface UserFilePickerRequest {
  type: typeof USER_FILE_PICKER_REQUEST
  /** Request id; the panel echoes it so stale replies can be ignored. */
  requestId: string
  /** `accept` attribute for the picker (may be empty). */
  accept: string
  multiple: boolean
}

export type UserFilePickerReply =
  | { ok: true; files: WorkflowFileArtifact[] }
  | { ok: false; canceled: boolean; error?: string }

/**
 * Ask the side panel to run the native file picker. Resolves when the user
 * picks files, rejects with `UPLOAD_USER_SELECTION_CANCELLED` when the user
 * cancels the chooser. If no panel answers within `timeoutMs`, rejects with
 * `UPLOAD_USER_SELECTION_TIMEOUT`.
 */
export function requestUserFiles(
  options: { accept?: string; multiple?: boolean; timeoutMs?: number },
): Promise<WorkflowFileArtifact[]> {
  const accept = options.accept ?? ''
  const multiple = options.multiple === true
  const timeoutMs = options.timeoutMs ?? 300000
  // No extension context (tests / page import): nothing can answer.
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    return Promise.reject(
      new UploadFileError(
        'UPLOAD_USER_SELECTION_TIMEOUT',
        'No Browser Copilot panel is available to choose a file.',
      ),
    )
  }

  const request: UserFilePickerRequest = {
    type: USER_FILE_PICKER_REQUEST,
    requestId:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `uf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    accept,
    multiple,
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new UploadFileError(
          'UPLOAD_USER_SELECTION_TIMEOUT',
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for file selection.`,
        ),
      )
    }, timeoutMs)

    void chrome.runtime.sendMessage(request).then(
      (reply) => {
        if (settled) return
        const r = reply as UserFilePickerReply | undefined
        if (r && r.ok && Array.isArray(r.files) && r.files.length > 0) {
          settled = true
          clearTimeout(timer)
          resolve(r.files)
          return
        }
        settled = true
        clearTimeout(timer)
        const canceled = r && !r.ok ? r.canceled : false
        reject(
          new UploadFileError(
            'UPLOAD_USER_SELECTION_CANCELLED',
            canceled
              ? 'User cancelled the file selection.'
              : (r && !r.ok && r.error) || 'File selection did not return a file.',
          ),
        )
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Receiving end does not exist = panel closed; treat as timeout so a
        // run launched with the panel shut reports a clear reason.
        reject(
          new UploadFileError(
            'UPLOAD_USER_SELECTION_TIMEOUT',
            'No Browser Copilot panel answered the file-picker request.',
          ),
        )
      },
    )
  })
}

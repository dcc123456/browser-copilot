/**
 * The browser window that opened this editor.
 *
 * The editor is a `popup`-type chrome-extension window: its sender window is
 * NOT a normal browser window, so background-side sender scoping degrades it
 * to unscoped (global). Instead, the panel that opens the editor appends its
 * own window id to the URL (`?hostWindow=<id>`), and every command the editor
 * issues (run / record / element picking) carries that id explicitly — the
 * worker validates it and pins the operation to that window, so a workflow
 * only ever acts in the window it was opened from.
 *
 * @module workflow-editor/host-window
 */

let cached: number | undefined | null = null

/**
 * The host window id from the URL, or `undefined` when the editor was opened
 * without one (e.g. directly from the address bar) — commands then omit the
 * field and keep the legacy global behaviour.
 */
export function hostWindowId(): number | undefined {
  if (cached === null) {
    const raw = new URLSearchParams(window.location.search).get('hostWindow')
    const id = raw === null ? Number.NaN : Number(raw)
    cached = Number.isFinite(id) ? id : undefined
  }
  return cached
}

/**
 * Builds the URL for opening the editor, appending the host window when
 * known. Shared by the panel opener and the post-recording reload so the
 * `hostWindow` param survives both paths.
 */
export function editorUrl(existing: string, windowId?: number): string {
  if (typeof windowId !== 'number') return existing
  return `${existing}${existing.includes('?') ? '&' : '?'}hostWindow=${windowId}`
}

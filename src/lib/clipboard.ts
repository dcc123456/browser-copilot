/**
 * Copy text from a UI surface.
 *
 * `navigator.clipboard.writeText` is not dependable in extension pages: the
 * manifest grants `clipboardRead` but not `clipboardWrite`, and without a
 * granted permission Chrome can leave the promise pending so the button looks
 * like it did nothing. `document.execCommand('copy')` runs inside the click
 * gesture, needs no permission, and is still the reliable route here.
 *
 * @module lib/clipboard
 */

export async function copyText(text: string): Promise<void> {
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '0'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  try {
    if (!document.execCommand('copy')) {
      throw new Error('clipboard: copy refused by the browser')
    }
  } finally {
    field.remove()
  }
}

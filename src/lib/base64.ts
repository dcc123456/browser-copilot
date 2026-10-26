/**
 * Base64 between bytes and text.
 *
 * The GitHub contents API wants file bytes as base64, a publish draft keeps
 * screenshots the same way because `chrome.storage` holds JSON only, and Feishu
 * signatures are base64-encoded digests. Both directions live here so those
 * paths cannot drift.
 *
 * @module lib/base64
 */

/** Base64 of a byte array, chunked so a large file cannot overflow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

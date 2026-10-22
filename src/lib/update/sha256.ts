/**
 * SHA-256 helpers for verifying a downloaded release asset against the digest
 * GitHub reports. Uses WebCrypto, available in the side panel, the service
 * worker and Node.
 *
 * @module lib/update/sha256
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether `actualHex` equals the hex half of a `sha256:<hex>` digest string. */
export function sha256Matches(actualHex: string, expectedDigest: string): boolean {
  const expected = expectedDigest.toLowerCase()
  if (!expected.startsWith('sha256:')) return false
  return expected.slice('sha256:'.length) === actualHex.toLowerCase()
}

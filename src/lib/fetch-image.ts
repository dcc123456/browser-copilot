/**
 * Downloads an http(s) image and inlines it as a data URL, so both the local
 * OCR worker and the vision model receive self-contained bytes instead of a
 * URL they must each fetch themselves. The response must actually BE an image,
 * but the verdict comes from the PAYLOAD'S MAGIC BYTES, not the Content-Type
 * header: several captcha servers (jxt56's /Api/makeVerify observed) serve PNG
 * bytes mislabelled as `text/html; charset=UTF-8`, and a strict header check
 * silently pushed those captchas onto the blurry screenshot-crop fallback.
 * Cookies are sent: captchas are commonly session-bound.
 *
 * @module lib/fetch-image
 */

/** Payload sniffing: real image bytes pass even with a lying Content-Type. */
function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  // GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return true
  // RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true
  }
  return false
}

export function fetchImageAsDataUrl(
  url: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  return (async () => {
    try {
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} while downloading ${url}` }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
      const mime = type.startsWith('image/')
        ? type
        : looksLikeImage(bytes)
          ? bytes[0] === 0x89
            ? 'image/png'
            : bytes[0] === 0xff
              ? 'image/jpeg'
              : bytes[0] === 0x47
                ? 'image/gif'
                : bytes[0] === 0x42 && bytes[1] === 0x4d
                  ? 'image/bmp'
                  : 'image/webp'
          : ''
      if (!mime) {
        return {
          ok: false,
          error:
            `${url} did not return an image (Content-Type: ${type || 'unknown'}, ` +
            'unrecognized payload). That URL likely serves an API/JSON response — ' +
            'capture the rendered element with a selector instead.',
        }
      }
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      return { ok: true, dataUrl: `data:${mime};base64,${btoa(binary)}` }
    } catch (error) {
      return { ok: false, error: `Could not download ${url}: ${(error as Error)?.message ?? String(error)}` }
    }
  })()
}

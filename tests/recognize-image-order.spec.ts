import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `recognize_image` runs local OCR (Tesseract.js) FIRST and only falls back to
 * the vision model when OCR returns nothing or fails. These tests pin that
 * ordering — the offline path must be attempted before any remote model call.
 */
const mocks = vi.hoisted(() => ({
  ocrImage: vi.fn(),
  recognizeImage: vi.fn(),
  getSettings: vi.fn(),
  getActiveProvider: vi.fn(),
}))

vi.mock('../src/background/driver', async (importActual) => ({
  ...(await importActual<typeof import('../src/background/driver')>()),
  ocrImage: mocks.ocrImage,
}))

vi.mock('../src/lib/vision', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/vision')>()),
  preprocessImage: async (dataUrl: string): Promise<string> => dataUrl,
  recognizeImage: mocks.recognizeImage,
}))

vi.mock('../src/lib/storage', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/storage')>()),
  getSettings: mocks.getSettings,
  getActiveProvider: mocks.getActiveProvider,
}))

import { executeTool } from '../src/background/agent'

const DATA_URL = 'data:image/png;base64,abc'

const visionProfile = {
  id: 'p1',
  label: 'Vision',
  presetId: 'custom',
  baseUrl: 'https://vision.example.com/v1',
  apiKey: 'k',
  model: 'glm-4v',
}

const baseCtx = {
  conversationId: 'test',
  navigated: false,
  disabled: new Set<string>(),
}

function configure({ vision }: { vision: boolean }): void {
  mocks.getSettings.mockResolvedValue({
    ocrLanguage: 'chi_sim',
    imageModel: vision ? { providerId: 'p1', model: '' } : { providerId: '', model: '' },
    providers: vision ? [visionProfile] : [],
  })
  mocks.getActiveProvider.mockResolvedValue(undefined)
}

beforeEach(() => {
  mocks.ocrImage.mockReset()
  mocks.recognizeImage.mockReset()
})

describe('recognize_image path ordering', () => {
  it('returns the local OCR text without ever calling the vision model', async () => {
    configure({ vision: true })
    mocks.ocrImage.mockResolvedValue({ ok: true, text: '  AB12 ' })

    const output = await executeTool('recognize_image', { image: DATA_URL }, baseCtx)
    const parsed = JSON.parse(output) as { ok: boolean; text: string; model: string }

    expect(parsed).toMatchObject({ ok: true, text: 'AB12', model: 'tesseract(ocr)' })
    expect(mocks.ocrImage).toHaveBeenCalledWith(DATA_URL, 'chi_sim')
    expect(mocks.recognizeImage).not.toHaveBeenCalled()
  })

  it('falls back to the vision model when OCR reads nothing, OCR first', async () => {
    configure({ vision: true })
    mocks.ocrImage.mockResolvedValue({ ok: true, text: '   ' })
    mocks.recognizeImage.mockResolvedValue({ ok: true, text: 'XY99' })

    const output = await executeTool('recognize_image', { image: DATA_URL }, baseCtx)
    const parsed = JSON.parse(output) as { ok: boolean; text: string; model: string }

    expect(parsed).toMatchObject({ ok: true, text: 'XY99', model: 'glm-4v' })
    expect(mocks.recognizeImage).toHaveBeenCalledTimes(1)
    expect(mocks.ocrImage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recognizeImage.mock.invocationCallOrder[0]!,
    )
  })

  it('still falls back to the vision model when OCR errors', async () => {
    configure({ vision: true })
    mocks.ocrImage.mockResolvedValue({ ok: false, error: 'offscreen gone' })
    mocks.recognizeImage.mockResolvedValue({ ok: true, text: 'Z1' })

    const output = await executeTool('recognize_image', { image: DATA_URL }, baseCtx)
    const parsed = JSON.parse(output) as { ok: boolean; text: string }

    expect(parsed).toMatchObject({ ok: true, text: 'Z1' })
  })

  it('reports both failures when OCR errors and no vision model is configured', async () => {
    configure({ vision: false })
    mocks.ocrImage.mockResolvedValue({ ok: false, error: 'offscreen gone' })

    const output = await executeTool('recognize_image', { image: DATA_URL }, baseCtx)
    const parsed = JSON.parse(output) as { ok: boolean; error: string }

    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('Local OCR could not read the image')
    expect(parsed.error).toContain('OCR error: offscreen gone')
  })

  it('refetches a URL captcha and retries when the first read is untrusted', async () => {
    configure({ vision: true })
    const imageResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([0x89, 0x50]).buffer,
    })
    const fetchMock = vi.fn().mockImplementation(async () => imageResponse())
    vi.stubGlobal('fetch', fetchMock)
    try {
      mocks.ocrImage
        .mockResolvedValueOnce({ ok: true, text: 'Zl xX 8 =', confidence: 43, agreed: false })
        .mockResolvedValueOnce({ ok: true, text: '7 x 1 =', confidence: 63, agreed: true })

      const output = await executeTool(
        'recognize_image',
        { image: 'https://site.example/captcha?_=1' },
        baseCtx,
      )
      const parsed = JSON.parse(output) as {
        ok: boolean
        text: string
        attempts: number
        agreed: boolean
        model: string
      }

      expect(parsed).toMatchObject({ ok: true, text: '7 x 1 =', attempts: 2, agreed: true, model: 'tesseract(ocr)' })
      expect(mocks.ocrImage).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

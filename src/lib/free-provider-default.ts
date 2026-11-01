/**
 * The keyless free provider a fresh install starts on.
 *
 * Kept in its own module so `providers.ts` (preset data) and `storage.ts`
 * (default settings + the v8 seed) share one definition without a runtime
 * import cycle.
 *
 * @module lib/free-provider-default
 */
import type { ProviderProfile } from './providers'

export const DEFAULT_FREE_PROVIDER_ID = 'default-pollinations'
export const DEFAULT_FREE_PROVIDER_LABEL = 'Pollinations'
export const DEFAULT_FREE_PROVIDER_PRESET_ID = 'pollinations'
export const DEFAULT_FREE_PROVIDER_BASE_URL = 'https://text.pollinations.ai/openai'
export const DEFAULT_FREE_PROVIDER_MODEL = 'openai-fast'

/** A ready-to-use, keyless Pollinations profile. */
export function defaultFreeProvider(): ProviderProfile {
  return {
    id: DEFAULT_FREE_PROVIDER_ID,
    label: DEFAULT_FREE_PROVIDER_LABEL,
    presetId: DEFAULT_FREE_PROVIDER_PRESET_ID,
    baseUrl: DEFAULT_FREE_PROVIDER_BASE_URL,
    apiKey: '',
    model: DEFAULT_FREE_PROVIDER_MODEL,
    models: [DEFAULT_FREE_PROVIDER_MODEL],
  }
}

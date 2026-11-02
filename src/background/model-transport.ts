/**
 * One entry point for a model completion over a provider profile.
 *
 * Keeps the profile→request field mapping (key, base URL, model, headers) in
 * one place; `lib/llm.ts` stays HTTP-only so the Runner can keep importing it.
 *
 * @module background/model-transport
 */
import {
  streamCompletion,
  type StreamHandlers,
  type StreamRequest,
  type StreamResult,
} from '../lib/llm'
import type { ProviderProfile } from '../lib/providers'

export type ModelCall = Omit<StreamRequest, 'apiKey' | 'baseUrl' | 'model' | 'headers'>

export async function streamModel(
  profile: ProviderProfile,
  call: ModelCall,
  handlers: StreamHandlers = {},
): Promise<StreamResult> {
  return streamCompletion(
    {
      ...call,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.headers ? { headers: profile.headers } : {}),
    },
    handlers,
  )
}

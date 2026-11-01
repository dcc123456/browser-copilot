/**
 * One entry point for a model completion, routed by the profile's transport.
 *
 * `lib/llm.ts` stays HTTP-only so the Runner can keep importing it; web-chat
 * profiles branch to the background DOM transport instead.
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
import { streamWebChat } from './web-chat/transport'

export type ModelCall = Omit<StreamRequest, 'apiKey' | 'baseUrl' | 'model' | 'headers'>

export async function streamModel(
  profile: ProviderProfile,
  call: ModelCall,
  handlers: StreamHandlers = {},
): Promise<StreamResult> {
  if (profile.transport === 'web') {
    return streamWebChat(profile, call, handlers)
  }
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

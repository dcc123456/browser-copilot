/**
 * AI repair proposal provider for the real background (spec §7).
 *
 * Adapts the shared {@link parseRepairProposal} to the configured completion
 * model: one system + one redacted-context call, parsed into a patch set (or
 * null). The Patch Engine still re-validates every field — this provider only
 * translates model text.
 *
 * @module background/workflow-engine/repair/repair-provider
 */

import { streamCompletion } from '../../../lib/llm'
import {
  buildRepairMessages,
  parseRepairProposal,
} from './repair-agent'
import type {
  RepairContext,
  WorkflowPatchSet,
} from '../../../lib/workflow/repair/types'

export interface RepairModelConfig {
  apiKey: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
}

const REPAIR_TIMEOUT_MS = 45_000

/** Build the proposal provider over the configured model. */
export function createAiRepairProposer(config: RepairModelConfig): {
  propose(context: RepairContext): Promise<WorkflowPatchSet | null>
} {
  return {
    async propose(context): Promise<WorkflowPatchSet | null> {
      const messages = buildRepairMessages(context)
      const result = await streamCompletion(
        {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          messages: messages as unknown as Parameters<typeof streamCompletion>[0]['messages'],
          headers: config.headers,
          signal: AbortSignal.timeout(REPAIR_TIMEOUT_MS),
        },
        {},
      )
      return parseRepairProposal(result.content, context)
    },
  }
}

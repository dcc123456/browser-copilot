/**
 * The agent: tool schemas, the tool-call loop, and confirmation gating.
 *
 * Provider-agnostic — it talks to whichever OpenAI-compatible endpoint is
 * active (DeepSeek, Volcengine Ark, a local model), because tool calling is part
 * of the shared wire format rather than a vendor feature.
 *
 * ## Why reading a page needs approval
 *
 * Page text is not neutral data: the active tab may be webmail, an internal
 * dashboard, or a bank statement, and reading it ships that text to a
 * third-party model endpoint. So a *model-initiated* read is gated behind an
 * explicit approval that names the tab first.
 *
 * The deliberate path is deliberately friction-free: ticking **Attach current
 * page** in the composer scrapes the page directly, without going through this
 * tool, because the user has already said which page and when. The prompt
 * therefore only appears when the model decided on its own.
 *
 * @module background/agent
 */

import {
  LlmError,
  streamCompletion,
  type WireMessage,
  type WireTool,
  type WireToolCall,
} from '../lib/llm'
import type { AgentServerMessage } from '../lib/messages'
import { renderSkillCatalogue, renderSkillPrompt } from '../lib/skills'
import { findSkillByName, getActiveProvider, getSkill, listSkills } from '../lib/storage'
import type { Skill } from '../lib/types'
import { readActivePage } from './page'

/**
 * Tools that must be confirmed by the user before they run.
 *
 * See the module note: reading the page is the one tool with a privacy cost, and
 * `use_skill` only re-reads text the user wrote themselves.
 */
const REQUIRES_CONFIRMATION = new Set(['read_current_page'])

/** Caps the tool-call loop so a confused model cannot spin forever. */
const MAX_TOOL_ROUNDS = 5

const SYSTEM_PROMPT = `You are Browser Copilot, a browser extension assistant that lives in the side panel.

You help the user with whatever they are doing in the browser, and you can read the page they are currently looking at.

Key facts you must respect:
- You can only read ordinary http(s) pages. Browser settings pages (chrome://), the Chrome Web Store, and local files are off limits, and no permission can change that.
- You read a page only when you call read_current_page, or when the user attached the page to their message. Never guess or invent page content: if you have not read it, say so and offer to read it.
- Reading the page needs the user's approval, so ask for what you need in one call rather than reading repeatedly.
- You cannot click, type, navigate, or otherwise change the page. You observe and advise; the user acts.

Answer in the language the user writes in. Be concise and concrete.`

/**
 * Builds the system prompt for one turn.
 *
 * Composed per turn rather than kept constant because skills change the
 * instructions: an explicitly selected skill is inlined, while auto-matchable
 * skills contribute only a name/description catalogue the model can draw from via
 * `use_skill`.
 *
 * Order matters. The base rules come first so a skill cannot talk the agent out
 * of the facts above (never inventing page content, for instance), and the active
 * skill comes last so it wins on ordinary stylistic questions.
 */
export function buildSystemPrompt(options: {
  activeSkill?: Skill | undefined
  catalogue?: readonly Skill[] | undefined
}): string {
  const parts = [SYSTEM_PROMPT]

  // Only advertise the catalogue when no skill is already loaded; offering
  // alternatives mid-skill invites the model to swap instructions unprompted.
  if (!options.activeSkill && options.catalogue && options.catalogue.length > 0) {
    const catalogue = renderSkillCatalogue(options.catalogue)
    if (catalogue) parts.push(catalogue)
  }

  if (options.activeSkill) parts.push(renderSkillPrompt(options.activeSkill))

  return parts.join('\n\n')
}

export const TOOLS: WireTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_current_page',
      description:
        'Read the title, URL, selected text, and visible body text of the tab the user is currently viewing. Use this whenever the user refers to "this page" or asks about what they are looking at. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          maxChars: {
            type: 'number',
            description: 'Optional character budget for the page text.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Load a saved skill\u2019s full instructions by name, then follow them. Use this when a skill from the "Available skills" list fits the request. Read-only: it changes nothing and needs no confirmation.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Exact skill name as shown in the available-skills list.',
          },
        },
        required: ['name'],
      },
    },
  },
]

/** Asks the panel to approve one tool call; resolves to the user's answer. */
export type ConfirmFn = (name: string, argsPreview: string) => Promise<boolean>

export interface AgentDeps {
  send: (message: AgentServerMessage) => void
  confirm: ConfirmFn
  signal?: AbortSignal
  /**
   * Skill the user explicitly selected in the panel, if any.
   *
   * An explicit choice suppresses the auto-match catalogue: the user has already
   * decided, so offering the model alternatives would only invite it to second-
   * guess them.
   */
  skillId?: string | undefined
}

/** Parses tool arguments, tolerating the empty string models send for no-arg calls. */
function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new Error(`Tool arguments were not valid JSON: ${trimmed.slice(0, 200)}`)
  }
}

/** Executes one tool call and returns the string handed back to the model. */
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'read_current_page': {
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : undefined
      const page = await readActivePage(maxChars)
      return JSON.stringify(page)
    }

    case 'use_skill': {
      const wanted = String(args.name ?? '').trim()
      if (!wanted) return JSON.stringify({ error: 'A skill name is required.' })

      const skill = await findSkillByName(wanted)
      if (!skill) {
        // Report the real options rather than a bare failure, so the model can
        // correct itself instead of inventing a second wrong name.
        const available = (await listSkills()).map((entry) => entry.name)
        return JSON.stringify({
          error: `No skill named "${wanted}".`,
          available,
        })
      }

      // The instructions are returned as the tool result, which places them in the
      // conversation the model is already reading. That is why loading a skill
      // needs no prompt rebuild: the tool result *is* the delivery mechanism.
      return JSON.stringify({
        skill: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        note: 'Follow these instructions for the rest of this conversation unless the user says otherwise.',
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

/** One-line summary of a tool result, for the transcript. */
function summarize(name: string, result: string): string {
  if (name === 'read_current_page') {
    try {
      const page = JSON.parse(result) as { title?: string; text?: string }
      return `Read "${page.title ?? 'page'}" (${page.text?.length ?? 0} chars)`
    } catch {
      return 'Read the page'
    }
  }
  if (name === 'use_skill') {
    // The raw result is the whole instruction body; echoing it into the
    // transcript would duplicate content the user already authored.
    try {
      const loaded = JSON.parse(result) as { skill?: string; error?: string }
      if (loaded.error) return loaded.error
      return `Using skill "${loaded.skill ?? 'unknown'}"`
    } catch {
      return 'Loaded a skill'
    }
  }
  return result.length > 200 ? `${result.slice(0, 200)}…` : result
}

/**
 * Runs one agent turn to completion, including any tool rounds.
 *
 * `history` is mutated in place so the caller keeps the full conversation,
 * including tool calls and their results, for the next turn.
 */
export async function runAgentTurn(history: WireMessage[], deps: AgentDeps): Promise<void> {
  const provider = await getActiveProvider()

  // Resolved once per turn, not per round: re-reading storage between tool rounds
  // could swap the instructions mid-turn if the user edited a skill meanwhile.
  const activeSkill = deps.skillId ? await getSkill(deps.skillId) : undefined
  const catalogue = activeSkill ? [] : await listSkills()
  const systemPrompt = buildSystemPrompt({ activeSkill, catalogue })

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const messages: WireMessage[] = [{ role: 'system', content: systemPrompt }, ...history]

    let result
    try {
      result = await streamCompletion(
        {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: provider.model,
          providerLabel: provider.label,
          messages,
          tools: TOOLS,
          ...(provider.headers ? { headers: provider.headers } : {}),
          ...(typeof provider.temperature === 'number'
            ? { temperature: provider.temperature }
            : {}),
          ...(typeof provider.maxTokens === 'number' ? { maxTokens: provider.maxTokens } : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        },
        {
          onText: (delta) => deps.send({ type: 'delta', text: delta }),
          onToolCallStart: (name) => deps.send({ type: 'tool.start', name }),
        },
      )
    } catch (error) {
      if (error instanceof LlmError) throw error
      if ((error as Error)?.name === 'AbortError') return
      throw error
    }

    if (result.toolCalls.length === 0) {
      history.push({ role: 'assistant', content: result.content })
      return
    }

    // Tool-call turns must replay content as "" rather than null: some
    // OpenAI-compatible gateways reject a null content field on replay.
    history.push({
      role: 'assistant',
      content: result.content.length > 0 ? result.content : '',
      tool_calls: result.toolCalls,
    })

    for (const call of result.toolCalls) {
      await runOneToolCall(call, history, deps)
    }
  }

  deps.send({
    type: 'status',
    text: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds to avoid a loop.`,
  })
}

/** Confirms if required, executes, and appends the tool result to history. */
async function runOneToolCall(
  call: WireToolCall,
  history: WireMessage[],
  deps: AgentDeps,
): Promise<void> {
  const name = call.function.name
  const pushResult = (content: string): void => {
    history.push({ role: 'tool', tool_call_id: call.id, content })
  }

  let args: Record<string, unknown>
  try {
    args = parseArgs(call.function.arguments)
  } catch (error) {
    pushResult(JSON.stringify({ error: (error as Error).message }))
    deps.send({
      type: 'tool.result',
      name,
      summary: `Invalid arguments: ${(error as Error).message}`,
    })
    return
  }

  if (REQUIRES_CONFIRMATION.has(name)) {
    const approved = await deps.confirm(name, JSON.stringify(args, null, 2))
    if (!approved) {
      pushResult(
        JSON.stringify({ error: 'The user declined this action. Do not retry it.' }),
      )
      deps.send({ type: 'tool.result', name, summary: 'Declined by user' })
      return
    }
  }

  try {
    const output = await executeTool(name, args)
    pushResult(output)
    deps.send({ type: 'tool.result', name, summary: summarize(name, output) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Tool failures are reported to the model, not thrown: it should explain
    // the problem to the user rather than have the turn die silently.
    pushResult(JSON.stringify({ error: message }))
    deps.send({ type: 'tool.result', name, summary: `Failed: ${message}` })
  }
}

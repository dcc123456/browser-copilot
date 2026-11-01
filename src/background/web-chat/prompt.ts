/**
 * Flattens the agent's message list into the single text block a web chat
 * accepts. The site has no role or tool protocol, so the transcript is marked
 * up as text and the closing line keeps the model on the last user turn.
 *
 * @module background/web-chat/prompt
 */
import type { WireMessage } from '../../lib/llm'

export const WEB_CHAT_PROMPT_MAX_CHARS = 16_000

export class WebChatPromptError extends Error {
  readonly code = 'attachments' as const

  constructor() {
    super('Web-chat providers do not support attachments.')
    this.name = 'WebChatPromptError'
  }
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

function turnOf(message: WireMessage): Turn | undefined {
  if (message.role === 'user') {
    if (message.attachments && message.attachments.length > 0) throw new WebChatPromptError()
    const text = message.content.trim()
    return text ? { role: 'user', text } : undefined
  }
  if (message.role === 'assistant') {
    const text = (message.content ?? '').trim()
    return text ? { role: 'assistant', text } : undefined
  }
  return undefined
}

export function buildWebChatPrompt(messages: WireMessage[]): string {
  const system = messages
    .filter(
      (message): message is Extract<WireMessage, { role: 'system' }> => message.role === 'system',
    )
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n')
  const turns = messages.map(turnOf).filter((turn): turn is Turn => turn !== undefined)

  let truncated = false
  const render = (): string => {
    const head = system ? `[Instructions]\n${system}\n\n` : ''
    const body = turns
      .map((turn) => `[${turn.role === 'user' ? 'User' : 'Assistant'}]\n${turn.text}`)
      .join('\n\n')
    const note = truncated ? '\n\n[Earlier conversation was truncated to fit this web chat.]' : ''
    return `${head}${body}${note}\n\nAnswer the final [User] message only. Do not continue the transcript.`
  }

  let prompt = render()
  // Drop old assistant replies first; user turns are the part the model needs.
  while (prompt.length > WEB_CHAT_PROMPT_MAX_CHARS && turns.length > 1) {
    const oldestAssistant = turns.findIndex((turn) => turn.role === 'assistant')
    turns.splice(oldestAssistant >= 0 ? oldestAssistant : 0, 1)
    truncated = true
    prompt = render()
  }
  // A single oversized user turn is cut from the front so the question itself
  // and the closing instruction survive.
  if (prompt.length > WEB_CHAT_PROMPT_MAX_CHARS) {
    prompt = prompt.slice(prompt.length - WEB_CHAT_PROMPT_MAX_CHARS)
  }
  return prompt
}

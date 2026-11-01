/**
 * Per-site selectors for the free web chats the extension can drive.
 *
 * The DOM is the provider here, so every field is a list of candidates tried in
 * order. When a site ships a redesign, update only this table and run the
 * Diagnose action to see which candidates still match.
 *
 * @module background/web-chat/adapters
 */
import type { Target } from '../../lib/ops'
import type { WebChatSiteId } from '../../lib/providers'

export interface WebChatAdapter {
  id: WebChatSiteId
  url: string
  /** Where the prompt is typed. */
  composer: string[]
  /** The send button; an empty list means press Enter. */
  send: string[]
  /** "New chat" control, used to reset context between requests. */
  newChat: string[]
  /** The last assistant reply container. */
  reply: string[]
  /** Present while the site is generating. */
  stop: string[]
  /** Present when the user is signed out. */
  login: string[]
}

export const WEB_CHAT_ADAPTERS: Record<WebChatSiteId, WebChatAdapter> = {
  deepseek: {
    id: 'deepseek',
    url: 'https://chat.deepseek.com/',
    composer: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
    send: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]'],
    newChat: ['button[aria-label*="新对话"]', 'div[class*="new-chat"]', 'a[href="/"]'],
    reply: [
      'div.ds-markdown:last-of-type',
      'div[class*="markdown"]:last-of-type',
      'div[class*="message"]:last-child',
    ],
    stop: ['div[class*="stop"]', 'button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    login: ['input[type="password"]', 'div[class*="login"]'],
  },
  chatgpt: {
    id: 'chatgpt',
    url: 'https://chatgpt.com/',
    composer: ['#prompt-textarea', 'div[contenteditable="true"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
    newChat: [
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      'a[href="/"]',
    ],
    reply: [
      '[data-message-author-role="assistant"]:last-of-type',
      'article[data-testid^="conversation-turn"]:last-of-type',
    ],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
    login: ['a[href*="auth/login"]', 'button[data-testid="login-button"]'],
  },
}

export function adapterFor(site: WebChatSiteId): WebChatAdapter {
  return WEB_CHAT_ADAPTERS[site]
}

/** Turns a candidate list into the kernel's ordered locator. */
export function cssTarget(candidates: string[]): Target {
  return {
    primary: { how: 'css', value: candidates[0] ?? '' },
    fallbacks: candidates.slice(1).map((value) => ({ how: 'css' as const, value })),
  }
}

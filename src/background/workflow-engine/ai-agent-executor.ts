/**
 * `ai-agent` block executor.
 *
 * A workflow step that hands control to the same tool-calling agent loop the
 * side panel and scheduled tasks use (`runAgentTurn`, wrapped for unattended
 * runs by `runUnattendedPrompt`). At runtime it:
 *
 *   1. Reads the text of the user-configured target element (CSS/XPath) from
 *      the page the workflow is driving — an empty selector skips this and the
 *      agent reads the page itself via its tools.
 *   2. Builds a task message from that element text, an optional instruction to
 *      snapshot the page first, and the user's (interpolated) prompt.
 *   3. Runs the agent:
 *      - `actOnPage: false` (default) → read-only mode: the agent may read /
 *        snapshot the page and answer, but every action tool is withheld so it
 *        cannot click, type, or navigate.
 *      - `actOnPage: true` → full-auto mode: the agent acts on the page
 *        without per-step confirmation (there is no panel to confirm on during
 *        a workflow run); every tool step is streamed into the run log.
 *   4. Stores the agent's final text answer in the configured output variable
 *      (and `lastAIAgent`).
 *
 * The element-reader is injected as a top-level, closure-free function so
 * `chrome.scripting.executeScript` can serialize it.
 *
 * @module background/workflow-engine/ai-agent-executor
 */

import { getSettings } from '../../lib/storage'
import { interpolate } from '../../lib/workflow/interpolate'
import type { AgentMode } from '../../lib/types'
import { resolveAutomationTab } from '../driver'
import { runUnattendedPrompt } from '../agent-unattended'
import type { BlockExecutor, WorkflowExecCtx } from './executors'

/** Cap the element text shipped to the model so one node can't blow context. */
const ELEMENT_TEXT_CAP = 4000

/**
 * Top-level injected function (no closure): return the trimmed text of the
 * first element matching a CSS selector, or '' when nothing matches / the
 * selector is invalid.
 */
function readElementTextInPage(selector: string): string {
  try {
    const el = document.querySelector(selector)
    return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
  } catch {
    return ''
  }
}

/**
 * Read the configured element's text from the page the run is driving.
 * Prefers the run-pinned tab (`ctx.tabId`), then the active tab. Returns ''
 * quietly when there is no injectable tab or the selector matches nothing;
 * XPath selectors are resolved in-page.
 */
async function readElementText(
  selector: string,
  findBy: string,
  ctx: WorkflowExecCtx,
): Promise<string> {
  // Resolve the page the run is driving: the run-pinned tab first, otherwise
  // the normal automation-tab resolution (which, when launched from the editor
  // popup, falls back to the last viewed http(s) tab rather than the extension
  // page).
  const tab = await resolveAutomationTab(ctx.tabId, ctx.scope).catch(() => undefined)
  const tabId = typeof tab?.id === 'number' ? tab.id : undefined
  if (typeof tabId !== 'number') return ''

  if (findBy === 'xpath') {
    const func = (xpath: string): string => {
      try {
        const result = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        )
        const node = result.singleNodeValue
        const text =
          node && (node as Element).textContent !== undefined
            ? (node as Element).textContent ?? ''
            : node?.nodeValue ?? ''
        return text.replace(/\s+/g, ' ').trim()
      } catch {
        return ''
      }
    }
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: [selector],
      })
      return String((injection?.result as string | undefined) ?? '').slice(0, ELEMENT_TEXT_CAP)
    } catch {
      return ''
    }
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readElementTextInPage,
      args: [selector],
    })
    return String((injection?.result as string | undefined) ?? '').slice(0, ELEMENT_TEXT_CAP)
  } catch {
    return ''
  }
}

/** Compose the business prompt handed to the agent. */
export function buildAgentPrompt(parts: {
  userPrompt: string
  selector: string
  elementText: string
  elementFound: boolean
  useSnapshot: boolean
  actOnPage: boolean
}): string {
  const lines: string[] = []
  lines.push('You are running as one step inside a Browser Copilot workflow.')
  lines.push(
    parts.actOnPage
      ? 'You MAY act on the current page (click, fill, navigate) to complete the task. Work step by step and take a fresh snapshot after any navigation.'
      : 'You are in READ-ONLY mode: analyze the provided content and answer. Do NOT click, type, navigate, or change anything on the page.',
  )
  if (parts.useSnapshot) {
    lines.push(
      'Start by calling snapshot_page to see the current page and its interactive elements, then use that context for your task.',
    )
  }
  if (parts.selector) {
    lines.push('', `The workflow is targeting this element (selector: ${parts.selector}):`)
    lines.push('"""')
    lines.push(parts.elementFound ? parts.elementText || '(element has no text)' : '(element not found)')
    lines.push('"""')
  }
  lines.push('', 'Task / instruction from the workflow author:')
  lines.push(parts.userPrompt || '(no instruction provided)')
  lines.push('', 'When done, reply with a concise text summary of the result (this is stored for later workflow steps).')
  return lines.join('\n')
}

/** Read a block param as a boolean (Automa checkboxes persist literal booleans). */
function asBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export const aiAgent: BlockExecutor = async (data, ctx) => {
  if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const selector =
    (typeof data['selector'] === 'string' && data['selector']) ||
    (typeof data['cssSelector'] === 'string' && data['cssSelector']) ||
    ''
  const findBy = typeof data['findBy'] === 'string' ? data['findBy'] : 'cssSelector'
  const userPrompt = interpolate(String(data['prompt'] ?? ''), ctx.variables, ctx.refData)
  const actOnPage = asBool(data['actOnPage'], false)
  const useSnapshot = asBool(data['useSnapshot'], true)
  const variable = String(data['variableName'] ?? 'lastAIAgent') || 'lastAIAgent'
  const rounds = Math.min(50, Math.max(1, Number(data['maxToolRounds'] ?? 20) || 20))

  /** Emit + bail, pre-setting the output variable to '' so a downstream forms
   *  block's `{{variable}}` reference resolves empty (its guard then skips the
   *  fill instead of typing a blank or a leftover `{{token}}` literal). */
  const fail = (kind: 'error' | 'info', text: string): null => {
    ctx.variables[variable] = ''
    ctx.emit(kind, text)
    return null
  }

  if (!userPrompt.trim() && !selector) {
    return fail('error', 'AI 智能体: 请填写提示词或选择目标元素')
  }

  // Fail fast with a clear message when no model is configured (mirrors the
  // ai-prompt block), instead of letting the agent loop throw opaquely.
  const settings = await getSettings()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (!provider || !provider.apiKey.trim()) {
    return fail('error', 'AI 智能体: 未配置模型 provider / API Key')
  }

  let elementText = ''
  let elementFound = false
  if (selector) {
    ctx.emit('status', `读取目标元素: ${selector}`)
    elementText = await readElementText(selector, findBy, ctx)
    elementFound = elementText.length > 0
    if (!elementFound) ctx.emit('info', 'AI 智能体: 未读取到元素文本（选择器无匹配或页面不可注入）')
  }

  const prompt = buildAgentPrompt({
    userPrompt,
    selector,
    elementText,
    elementFound,
    useSnapshot,
    actOnPage,
  })

  const mode: AgentMode = actOnPage ? 'full' : 'readonly'
  ctx.emit('status', actOnPage ? 'AI 智能体开始（可操作页面）' : 'AI 智能体开始（只读分析）')

  const conversationId = `workflow-ai-agent:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const result = await runUnattendedPrompt(prompt, conversationId, mode, {
    signal: ctx.signal,
    maxToolRounds: rounds,
    // Pin the nested turn to THIS workflow's window: without it the nested
    // turn would re-resolve "the plugin window" and, with several plugin
    // windows open, could act in the wrong one.
    ...(ctx.scope ? { scopeWindowId: ctx.scope.windowId } : {}),
    onStep: (kind, text) => {
      if (kind === 'error') ctx.emit('error', text)
      else if (kind === 'result') ctx.emit('result', text)
      else ctx.emit('status', kind === 'tool' ? `🤖 ${text}` : text)
    },
  })

  if (result.cancelled) {
    return fail('info', 'AI 智能体已取消')
  }

  if (!result.ok) {
    // Emit but do not fail the whole run: other blocks continue on the default
    // edge, matching the engine's per-block error convention.
    return fail('error', `AI 智能体: ${result.error ?? '运行失败'}`)
  }

  const answer = result.answer ?? ''
  ctx.variables[variable] = answer
  ctx.variables['lastAIAgent'] = answer
  ctx.emit('result', answer.slice(0, 200) || 'AI 智能体完成（无文本输出）')
  return null
}

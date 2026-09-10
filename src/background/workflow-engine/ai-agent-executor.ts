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
import { sanitizeModelAnswer } from '../../lib/model-output'
import type { AgentMode } from '../../lib/types'
import { resolveAutomationTab } from '../driver'
import { runUnattendedPrompt } from '../agent-unattended'
import type { BlockExecutor, WorkflowExecCtx } from './executors'

/** Cap the element text shipped to the model so one node can't blow context. */
const ELEMENT_TEXT_CAP = 4000

/** Result of reading a targeted element from the page. */
interface ElementReadResult {
  /** Whether the element exists in the DOM. */
  exists: boolean
  /** The trimmed text content (empty when the element has no text or is visual-only). */
  text: string
}

/**
 * Top-level injected function (no closure): read the first element matching a
 * CSS selector. Returns whether the element exists AND its text content.
 * Visual-only elements (images, canvas) return exists=true but text=''.
 */
function readElementTextInPage(selector: string): ElementReadResult {
  try {
    const el = document.querySelector(selector)
    if (!el) return { exists: false, text: '' }
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    return { exists: true, text }
  } catch {
    return { exists: false, text: '' }
  }
}

/**
 * Read the configured element's text from the page the run is driving.
 * Prefers the run-pinned tab (`ctx.tabId`), then the active tab. Returns
 * `{ exists, text }` where `exists` indicates whether the element is in the
 * DOM and `text` is its text content (empty for visual-only elements like
 * images/canvas). XPath selectors are resolved in-page.
 */
async function readElementText(
  selector: string,
  findBy: string,
  ctx: WorkflowExecCtx,
): Promise<ElementReadResult> {
  // Resolve the page the run is driving: the run-pinned tab first, otherwise
  // the normal automation-tab resolution (which, when launched from the editor
  // popup, falls back to the last viewed http(s) tab rather than the extension
  // page).
  const tab = await resolveAutomationTab(ctx.tabId, ctx.scope).catch(() => undefined)
  const tabId = typeof tab?.id === 'number' ? tab.id : undefined
  if (typeof tabId !== 'number') return { exists: false, text: '' }

  if (findBy === 'xpath') {
    const func = (xpath: string): ElementReadResult => {
      try {
        const result = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        )
        const node = result.singleNodeValue
        if (!node) return { exists: false, text: '' }
        const text =
          (node as Element).textContent !== undefined
            ? (node as Element).textContent ?? ''
            : node?.nodeValue ?? ''
        return { exists: true, text: text.replace(/\s+/g, ' ').trim() }
      } catch {
        return { exists: false, text: '' }
      }
    }
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: [selector],
      })
      const result = (injection?.result as ElementReadResult | undefined) ?? {
        exists: false,
        text: '',
      }
      return { exists: result.exists, text: result.text.slice(0, ELEMENT_TEXT_CAP) }
    } catch {
      return { exists: false, text: '' }
    }
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readElementTextInPage,
      args: [selector],
    })
    const result = (injection?.result as ElementReadResult | undefined) ?? {
      exists: false,
      text: '',
    }
    return { exists: result.exists, text: result.text.slice(0, ELEMENT_TEXT_CAP) }
  } catch {
    return { exists: false, text: '' }
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
    if (!parts.elementFound) {
      lines.push('(element not found — selector did not match anything on the page)')
    } else if (!parts.elementText) {
      lines.push(
        '(element EXISTS but has NO text content — it is likely a visual element like an image, canvas, or captcha. Use snapshot_page to see it visually.)',
      )
    } else {
      lines.push(parts.elementText)
    }
    lines.push('"""')
  }
  lines.push('', 'Task / instruction from the workflow author:')
  lines.push(parts.userPrompt || '(no instruction provided)')
  lines.push(
    '',
    'Output requirements for your FINAL reply (it is stored into a workflow variable and consumed verbatim by later steps — filled into form fields, compared, parsed):',
    '- Reply with the final result only. Do NOT include your reasoning, planning, or <think> blocks — thinking content is junk to the workflow.',
    '- Do NOT wrap the answer in markdown code fences unless the task explicitly asks for code.',
    '- If the task asks for data (JSON, a number, a list), output exactly that data and nothing else.',
  )
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

  /**
   * Config/runtime failures THROW, not emit-and-continue: the engine's
   * per-block onError machinery then applies (retry → fallback edge → fail
   * the run). The previous "emit + return null" kept the run flowing to
   * downstream blocks while the AI had produced NO result — from the user's
   * view the workflow "didn't wait for the AI". Downstream must never run on
   * an empty output variable, so pre-set it to '' before bailing.
   */
  const fail = (text: string): never => {
    ctx.variables[variable] = ''
    throw new Error(text)
  }

  if (!userPrompt.trim() && !selector) {
    fail('AI 智能体: 请填写提示词或选择目标元素')
  }

  // Fail fast with a clear message when no model is configured (mirrors the
  // ai-prompt block), instead of letting the agent loop throw opaquely.
  const settings = await getSettings()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (!provider || !provider.apiKey.trim()) {
    fail('AI 智能体: 未配置模型 provider / API Key')
  }

  let elementText = ''
  let elementFound = false
  if (selector) {
    ctx.emit('status', `读取目标元素: ${selector}`)
    const elementResult = await readElementText(selector, findBy, ctx)
    elementFound = elementResult.exists
    elementText = elementResult.text
    if (!elementFound) {
      ctx.emit('info', 'AI 智能体: 未找到目标元素（选择器无匹配或页面不可注入）')
    } else if (!elementText) {
      // Element exists but has no text (e.g., image, canvas, visual-only captcha)
      ctx.emit('info', 'AI 智能体: 元素已找到但无文本内容（图片/画布等视觉元素），将使用截图分析')
    }
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
    // Deliberate cancellation: the run is aborting anyway; no error, no throw.
    ctx.variables[variable] = ''
    ctx.emit('info', 'AI 智能体已取消')
    return null
  }

  if (!result.ok) {
    // No answer → the block FAILS (see `fail` above): downstream blocks must
    // not run on an empty result, and the engine's retry/fallback now applies.
    fail(`AI 智能体: ${result.error ?? '运行失败'}`)
  }

  // Defense in depth at the workflow boundary (the unattended runner already
  // cleans): strip reasoning-model `<think>` blocks, a wrapping ``` fence, and
  // trim, so the variable downstream blocks consume never carries wrapper junk.
  const answer = sanitizeModelAnswer(result.answer ?? '')
  if (!answer) {
    // The turn "finished" but produced nothing usable (thinking-only reply,
    // empty fence). FAIL like the no-answer path above — downstream must never
    // run on an empty output variable, and onError (retry → fallback) applies.
    fail('AI 智能体: 模型未输出有效内容（仅思考过程或空回复）')
  }
  ctx.variables[variable] = answer
  ctx.variables['lastAIAgent'] = answer
  ctx.emit('result', answer.slice(0, 200))
  return null
}

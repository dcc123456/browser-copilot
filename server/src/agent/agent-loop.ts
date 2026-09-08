/**
 * The server agent loop: an OpenAI-compatible tool-calling turn driven by the
 * shared `lib/llm.ts` client, with the Playwright tool set from
 * `agent/tools.ts`.
 *
 * This is the server equivalent of the extension's unattended agent turn
 * (`background/agent.ts` + `agent-unattended.ts`): the model observes the page
 * through `snapshot_page` / `read_text` and (in full mode) acts with
 * click / fill / press / navigate / scroll until it produces a final answer.
 *
 * Two entry points:
 * - {@link runAgentLoop} — the raw turn (prompt → answer);
 * - {@link runAgentTurnForBlock} — the `ai-agent` block executor semantics
 *   (element targeting, variable output, error contract).
 *
 * @module server/agent/agent-loop
 */

import { sanitizeModelAnswer } from '../../../src/lib/model-output'
import { streamCompletion, type WireMessage } from '../../../src/lib/llm'
import { interpolate } from '../../../src/lib/workflow/interpolate'
import type { WorkflowExecCtx } from '../../../src/background/workflow-engine/executors'
import type { ExecutorDeps } from '../executors'
import { buildAgentTools, type AgentToolMode } from './tools'

/** Hard cap on model↔tool round trips per turn (mirrors the extension). */
const MAX_TOOL_ROUNDS_CAP = 50

/** The prompt builder for `ai-agent` blocks — verbatim semantics of the
 * extension's `buildAgentPrompt` (see background/workflow-engine/ai-agent-executor.ts). */
export function buildBlockPrompt(parts: {
  userPrompt: string
  selector: string
  elementText: string
  elementFound: boolean
  useSnapshot: boolean
  actOnPage: boolean
}): string {
  const lines: string[] = []
  lines.push('You are running as one step inside a Browser Copilot workflow (server runner).')
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
  lines.push(
    '',
    'Output requirements for your FINAL reply (it is stored into a workflow variable and consumed verbatim by later steps — filled into form fields, compared, parsed):',
    '- Reply with the final result only. Do NOT include your reasoning, planning, or <think> blocks — thinking content is junk to the workflow.',
    '- Do NOT wrap the answer in markdown code fences unless the task explicitly asks for code.',
    '- If the task asks for data (JSON, a number, a list), output exactly that data and nothing else.',
  )
  return lines.join('\n')
}

function systemPrompt(mode: AgentToolMode): string {
  return [
    'You are the browser-automation agent of the Browser Copilot server runner.',
    mode === 'full'
      ? 'You may act on pages with the provided tools to complete the task.'
      : 'You are in READ-ONLY mode: only observation tools are available.',
    'Use tools as needed, be efficient (no unnecessary exploration), then answer with the final result only.',
  ].join(' ')
}

export interface AgentTurnResult {
  ok: boolean
  answer?: string
  error?: string
  cancelled?: boolean
}

/** The raw agent turn: prompt → (tool rounds) → final answer. */
export async function runAgentLoop(opts: {
  provider: { apiKey: string; baseUrl: string; model: string; headers?: Record<string, string> }
  prompt: string
  mode: AgentToolMode
  maxRounds: number
  signal: AbortSignal
  driver: import('../driver').RunDriver
  artifactsDir: string
  onStep?: (kind: 'tool' | 'status' | 'result' | 'error' | 'info', text: string) => void
}): Promise<AgentTurnResult> {
  const { provider, signal } = opts
  const toolSet = buildAgentTools(opts.driver, opts.artifactsDir, opts.mode)
  const onStep = opts.onStep ?? (() => {})

  const messages: WireMessage[] = [
    { role: 'system', content: systemPrompt(opts.mode) },
    { role: 'user', content: opts.prompt },
  ]

  const maxRounds = Math.min(MAX_TOOL_ROUNDS_CAP, Math.max(1, Math.floor(opts.maxRounds)))
  for (let round = 1; round <= maxRounds; round++) {
    if (signal.aborted) return { ok: false, cancelled: true, error: 'Cancelled.' }
    let result
    try {
      result = await streamCompletion({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        headers: provider.headers,
        messages,
        tools: toolSet.tools,
        signal,
      })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        return { ok: false, cancelled: true, error: 'Cancelled.' }
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    if (result.toolCalls.length === 0) {
      const answer = sanitizeModelAnswer(result.content)
      if (!answer) return { ok: false, error: '模型未输出有效内容（仅思考过程或空回复）' }
      return { ok: true, answer }
    }

    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls,
    })
    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        /* malformed args → the tool reports it */
      }
      onStep('tool', `${call.function.name} ${JSON.stringify(args).slice(0, 160)}`)
      let output: string
      try {
        output = await toolSet.execute(call.function.name, args)
      } catch (error) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`
      }
      onStep('info', `→ ${output.slice(0, 200)}`)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: output,
        name: call.function.name,
      })
    }
  }
  return { ok: false, error: `已达到最大工具轮次 (${maxRounds})` }
}

/** Read an element's text in-page (CSS or XPath), mirroring the extension. */
async function readElementText(
  deps: ExecutorDeps,
  selector: string,
  findBy: string,
  ctx: WorkflowExecCtx,
): Promise<string> {
  const cap = 4000
  if (findBy === 'xpath') {
    const result = await deps.driver.execJs(
      `(() => { try { const r = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const n = r.singleNodeValue; return n ? ((n.textContent ?? n.nodeValue) ?? '').replace(/\\s+/g, ' ').trim() : '' } catch { return '' } })()`,
      {},
      ctx.tabId,
    )
    return result.ok ? String(result.data ?? '').slice(0, cap) : ''
  }
  const result = await deps.driver.execJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent ?? '').replace(/\\s+/g, ' ').trim() : '' })()`,
    {},
    ctx.tabId,
  )
  return result.ok ? String(result.data ?? '').slice(0, cap) : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * The `ai-agent` block on the server — the same contract as the extension's
 * executor (element text → agent turn → output variable; failures throw so
 * the engine's onError machinery applies).
 */
export async function runAgentTurnForBlock(
  data: Record<string, unknown>,
  ctx: WorkflowExecCtx,
  deps: ExecutorDeps,
): Promise<string | null> {
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

  const fail = (text: string): never => {
    ctx.variables[variable] = ''
    throw new Error(text)
  }

  if (!userPrompt.trim() && !selector) {
    fail('AI 智能体: 请填写提示词或选择目标元素')
  }

  if (!deps.provider || !deps.provider.apiKey.trim()) {
    fail('AI 智能体: 服务端未配置模型（BC_LLM_BASE_URL / BC_LLM_API_KEY / BC_LLM_MODEL）')
  }
  const provider = deps.provider!

  let elementText = ''
  let elementFound = false
  if (selector) {
    ctx.emit('status', `读取目标元素: ${selector}`)
    elementText = await readElementText(deps, selector, findBy, ctx)
    elementFound = elementText.length > 0
    if (!elementFound) ctx.emit('info', 'AI 智能体: 未读取到元素文本（选择器无匹配或页面不可注入）')
  }

  const prompt = buildBlockPrompt({
    userPrompt,
    selector,
    elementText,
    elementFound,
    useSnapshot,
    actOnPage,
  })

  const mode: AgentToolMode = actOnPage ? 'full' : 'readonly'
  ctx.emit('status', actOnPage ? 'AI 智能体开始（可操作页面）' : 'AI 智能体开始（只读分析）')

  const result = await runAgentLoop({
    provider,
    prompt,
    mode,
    maxRounds: rounds,
    signal: ctx.signal,
    driver: deps.driver,
    artifactsDir: deps.artifactsDir,
    onStep: (kind, text) => {
      if (kind === 'error') ctx.emit('error', text)
      else if (kind === 'result') ctx.emit('result', text)
      else ctx.emit('status', kind === 'tool' ? `🤖 ${text}` : text)
    },
  })

  if (result.cancelled) {
    ctx.variables[variable] = ''
    ctx.emit('info', 'AI 智能体已取消')
    return null
  }

  if (!result.ok) {
    fail(`AI 智能体: ${result.error ?? '运行失败'}`)
  }

  const answer = sanitizeModelAnswer(result.answer ?? '')
  if (!answer) {
    fail('AI 智能体: 模型未输出有效内容（仅思考过程或空回复）')
  }
  ctx.variables[variable] = answer
  ctx.variables['lastAIAgent'] = answer
  ctx.emit('result', answer.slice(0, 200))
  return null
}

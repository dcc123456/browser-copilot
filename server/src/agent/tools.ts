/**
 * The server agent's page tools — a Playwright-backed subset of the
 * extension's tool catalog, sufficient for workflow `ai-agent` steps and AI
 * takeover: observe the page, act on it, read from it.
 *
 * Actions accept EITHER a CSS selector (or `xpath:`-prefixed) OR an explicit
 * kernel locator spec (`how` + `value`[, `role`]) — the same strategies the
 * kernel natively resolves (role/text/testid/id/name), so elements without a
 * stable id stay clickable when the snapshot shows their role/name.
 *
 * @module server/agent/tools
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WireTool } from '../../../src/lib/llm'
import { locatorHintOf, type Op, type PageSnapshot, type Target, type TargetSpec } from '../../../src/lib/ops'
import type { RunDriver } from '../driver'

export type AgentToolMode = 'readonly' | 'full'

/** A validated kernel locator spec `how`. */
const SPEC_HOWS = new Set(['testid', 'id', 'name', 'role', 'text', 'css'])

function targetFromToolArgs(args: Record<string, unknown>): Target {
  const selector = typeof args['selector'] === 'string' ? args['selector'].trim() : ''
  if (selector) {
    return { primary: { how: 'css', value: selector }, fallbacks: [] }
  }
  const how = typeof args['how'] === 'string' ? args['how'] : ''
  const value = typeof args['value'] === 'string' ? args['value'] : ''
  if (how && SPEC_HOWS.has(how) && value) {
    const spec: TargetSpec = { how: how as TargetSpec['how'], value }
    if (typeof args['role'] === 'string' && args['role']) spec.role = args['role']
    return { primary: spec, fallbacks: [] }
  }
  throw new Error('需要 selector（CSS 或 xpath: 前缀）或 how+value 定位参数')
}

/** Renders a PageSnapshot for the model: header, text, element lines. */
function renderSnapshot(page: PageSnapshot): string {
  const lines: string[] = []
  lines.push(`URL: ${page.url}`)
  lines.push(`Title: ${page.title}`)
  lines.push('')
  lines.push('Page text (capped):')
  lines.push(page.text || '(empty)')
  lines.push('')
  lines.push(`Interactive elements (${page.elements.length}${page.elementsTruncated ? '+, truncated' : ''}):`)
  for (const element of page.elements) {
    const hint = locatorHintOf(element.target)
    lines.push(
      `${element.ref} <${element.role}> "${element.name}" <${element.tag}>` +
        (element.value !== undefined ? ` value="${element.value}"` : '') +
        (element.disabled ? ' [disabled]' : '') +
        (hint ? ` loc=${hint}` : ''),
    )
  }
  if (page.forms.length > 0) {
    lines.push('')
    lines.push('Forms:')
    for (const form of page.forms) {
      lines.push(
        `form "${form.name}": ${form.fields
          .map((field) => `${field.ref} ${field.label} (${field.tag}${field.type ? `/${field.type}` : ''})`)
          .join('; ')}`,
      )
    }
  }
  return lines.join('\n')
}

/** A tool definition: the wire shape plus its Playwright implementation. */
interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

function toWireTool(def: ToolDef): WireTool {
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.parameters },
  }
}

export interface AgentToolSet {
  tools: WireTool[]
  execute(name: string, args: Record<string, unknown>): Promise<string>
}

/**
 * Builds the tool set for one agent turn. `readonly` withholds every
 * mutating tool, mirroring the extension's read-only agent mode.
 */
export function buildAgentTools(
  driver: RunDriver,
  artifactsDir: string,
  mode: AgentToolMode,
): AgentToolSet {
  const canAct = mode === 'full'
  const defs: ToolDef[] = [
    {
      name: 'snapshot_page',
      description:
        'Observe the current page: URL, title, visible text (capped) and the list of interactive elements with roles, names and stable locator hints. Call this FIRST and after every navigation.',
      parameters: {
        type: 'object',
        properties: {
          maxChars: { type: 'number', description: 'Text character budget (default 6000)' },
          maxElements: { type: 'number', description: 'Max interactive elements (default 120)' },
        },
      },
      async execute(args) {
        const op: Op = { action: 'snapshot' }
        if (typeof args['maxChars'] === 'number') op.maxChars = args['maxChars']
        if (typeof args['maxElements'] === 'number') op.maxElements = args['maxElements']
        const result = await driver.execOp(op)
        if (!result.ok || !result.page) {
          return `Error: ${result.error ?? 'snapshot failed'}`
        }
        return renderSnapshot(result.page)
      },
    },
    {
      name: 'read_text',
      description:
        'Read text from the page. With `selector`, the text of the first matching element; without, the page body text (capped).',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (or xpath:… prefix), optional' },
          maxChars: { type: 'number', description: 'Cap for the returned text (default 4000)' },
        },
      },
      async execute(args) {
        const selector = typeof args['selector'] === 'string' ? args['selector'] : ''
        const cap = typeof args['maxChars'] === 'number' ? args['maxChars'] : 4000
        const code = selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent ?? '').trim() : '' })()`
          : `document.body ? (document.body.innerText ?? '').trim() : ''`
        const result = await driver.execJs(code, {})
        if (!result.ok) return `Error: ${result.error}`
        const text = String(result.data ?? '')
        return text.length > cap ? `${text.slice(0, cap)}…(truncated)` : text
      },
    },
    {
      name: 'wait_for',
      description: 'Wait (in-page, up to timeoutMs) until an element matching the locator exists.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (or xpath:… prefix)' },
          how: { type: 'string', enum: ['testid', 'id', 'name', 'role', 'text', 'css'] },
          value: { type: 'string' },
          timeoutMs: { type: 'number', description: 'Default 10000' },
        },
        required: ['selector'],
      },
      async execute(args) {
        const result = await driver.execOp({
          action: 'wait_for',
          target: targetFromToolArgs(args),
          waitFor: typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 10_000,
        })
        return result.ok && result.found ? 'Element appeared.' : `Error: ${result.error ?? 'not found'}`
      },
    },
    {
      name: 'screenshot',
      description:
        'Save a PNG screenshot of the current page into the run artifacts. Returns the file path (no vision — use read_text/snapshot to inspect).',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const dataUrl = await driver.screenshot('page')
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
        const path = join(artifactsDir, `agent-screenshot-${Date.now()}.png`)
        writeFileSync(path, Buffer.from(base64, 'base64'))
        return `Screenshot saved: ${path}`
      },
    },
  ]

  if (canAct) {
    defs.push(
      {
        name: 'click',
        description:
          'Click an element. Locate it with `selector` (CSS or xpath:…) or with a kernel spec (`how` + `value`, optionally `role`).',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            how: { type: 'string', enum: ['testid', 'id', 'name', 'role', 'text', 'css'] },
            value: { type: 'string' },
            role: { type: 'string', description: 'ARIA role when how="role"' },
          },
        },
        async execute(args) {
          const result = await driver.execOp({ action: 'click', target: targetFromToolArgs(args) })
          if (result.ok === false) return `Error: ${result.error ?? 'click failed'}`
          return result.note ?? 'Clicked.'
        },
      },
      {
        name: 'fill',
        description:
          'Clear and type text into an input/textarea/contenteditable. Locate like `click`; `value` is the text to type.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            how: { type: 'string', enum: ['testid', 'id', 'name', 'role', 'text', 'css'] },
            value: { type: 'string', description: 'The text to type' },
            role: { type: 'string' },
          },
          required: ['value'],
        },
        async execute(args) {
          const result = await driver.execOp({
            action: 'fill',
            target: targetFromToolArgs(args),
            value: String(args['value'] ?? ''),
          })
          if (result.ok === false) return `Error: ${result.error ?? 'fill failed'}`
          return result.note ?? 'Filled.'
        },
      },
      {
        name: 'press_key',
        description: 'Press a keyboard key on the focused element, e.g. "Enter", "Tab", "Escape".',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        async execute(args) {
          const result = await driver.execOp({ action: 'press_key', value: String(args['key'] ?? '') })
          if (result.ok === false) return `Error: ${result.error ?? 'press failed'}`
          return 'Key pressed.'
        },
      },
      {
        name: 'navigate',
        description: 'Navigate to a URL in a new page of the run session and wait for load (best-effort).',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        async execute(args) {
          const url = String(args['url'] ?? '')
          const tab = await driver.newTab(url)
          return `Navigated to ${tab.url}`
        },
      },
      {
        name: 'scroll',
        description:
          'Scroll the page: `{x, y}` by pixels (negative y up), or `{selector}` to scroll an element into view.',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            selector: { type: 'string', description: 'Scroll this element into view instead' },
          },
        },
        async execute(args) {
          const selector = typeof args['selector'] === 'string' ? args['selector'] : ''
          const op: Op = selector
            ? {
                action: 'scroll',
                target: { primary: { how: 'css', value: selector }, fallbacks: [] },
                scroll: { mode: 'into_view' },
              }
            : {
                action: 'scroll',
                scroll: {
                  mode: 'by',
                  x: typeof args['x'] === 'number' ? args['x'] : 0,
                  y: typeof args['y'] === 'number' ? args['y'] : 600,
                },
              }
          const result = await driver.execOp(op)
          if (result.ok === false) return `Error: ${result.error ?? 'scroll failed'}`
          return 'Scrolled.'
        },
      },
    )
  }

  const byName = new Map(defs.map((def) => [def.name, def]))
  return {
    tools: defs.map(toWireTool),
    async execute(name, args) {
      const tool = byName.get(name)
      if (!tool) return `Error: unknown tool ${name}`
      return tool.execute(args)
    },
  }
}

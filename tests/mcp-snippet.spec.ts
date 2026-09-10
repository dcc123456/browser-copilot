import { describe, expect, it } from 'vitest'
import {
  ADAPTER_ASSET_PATH,
  ADAPTER_EXPORT_FILENAME,
  ADAPTER_PATH_PLACEHOLDER,
  buildMcpSnippet,
} from '../src/lib/mcp-adapter'

describe('buildMcpSnippet', () => {
  it('keeps a placeholder before export', () => {
    for (const client of ['claude', 'codex', 'trae'] as const) {
      const snippet = buildMcpSnippet(client)
      expect(snippet).toContain(ADAPTER_PATH_PLACEHOLDER)
      expect(snippet).not.toContain('examples/local-agent')
    }
  })

  it('treats empty / whitespace paths as unset', () => {
    expect(buildMcpSnippet('claude', '')).toContain(ADAPTER_PATH_PLACEHOLDER)
    expect(buildMcpSnippet('claude', '   ')).toContain(ADAPTER_PATH_PLACEHOLDER)
  })

  it('embeds a real absolute path in the claude JSON snippet', () => {
    const path = '/Users/alice/Downloads/browser-copilot/mcp-server.mjs'
    const snippet = buildMcpSnippet('claude', path)
    expect(snippet).toContain(`"args": ["${path}"]`)
    // Must remain valid, parseable JSON.
    const parsed = JSON.parse(snippet)
    expect(parsed.mcpServers['browser-copilot'].command).toBe('node')
    expect(parsed.mcpServers['browser-copilot'].args).toEqual([path])
  })

  it('escapes Windows backslashes in the JSON snippet', () => {
    const win = 'C:\\Users\\alice\\Downloads\\browser-copilot\\mcp-server.mjs'
    const snippet = buildMcpSnippet('claude', win)
    // Raw text must contain the doubled form ...
    expect(snippet).toContain(
      '"args": ["C:\\\\Users\\\\alice\\\\Downloads\\\\browser-copilot\\\\mcp-server.mjs"]',
    )
    // ... and parse back to the original single-backslash path.
    const parsed = JSON.parse(snippet)
    expect(parsed.mcpServers['browser-copilot'].args).toEqual([win])
  })

  it('builds the codex TOML-style snippet', () => {
    const win = 'C:\\Users\\alice\\Downloads\\browser-copilot\\mcp-server.mjs'
    const snippet = buildMcpSnippet('codex', win)
    expect(snippet).toBe(
      '[mcp_servers.browser-copilot]\n' +
        'command = "node"\n' +
        'args = ["C:\\\\Users\\\\alice\\\\Downloads\\\\browser-copilot\\\\mcp-server.mjs"]',
    )
  })

  it('builds the trae UI snippet', () => {
    const snippet = buildMcpSnippet('trae', '/tmp/mcp-server.mjs')
    expect(snippet).toContain('command: node')
    expect(snippet).toContain('args: ["/tmp/mcp-server.mjs"]')
  })

  it('exposes the shipped asset path and export filename', () => {
    expect(ADAPTER_ASSET_PATH).toBe('mcp-server.mjs')
    expect(ADAPTER_EXPORT_FILENAME).toBe('browser-copilot/mcp-server.mjs')
  })
})

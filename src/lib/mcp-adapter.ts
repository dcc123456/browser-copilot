/**
 * MCP local-agent adapter helpers (chrome-free).
 *
 * The adapter (`mcp-server.mjs`, a zero-dependency Node WebSocket↔stdio bridge)
 * ships INSIDE the extension package: the source file lives at
 * `public/mcp-server.mjs`, so after build it sits at the extension root and is
 * reachable via `chrome.runtime.getURL(ADAPTER_ASSET_PATH)`. Users on a release
 * zip do not need the source repository: the settings card exports this asset
 * to a stable folder (`~/Downloads/browser-copilot/`) and the absolute path
 * returned by the downloads API is substituted into the snippets below.
 *
 * Before export the snippets keep a `__插件目录__` placeholder; once exported
 * they carry the real absolute path (Windows backslashes are escaped correctly
 * via JSON.stringify, so the JSON snippet never needs manual escaping).
 *
 * @module lib/mcp-adapter
 */

/** Asset path inside the built extension (Vite copies public/ to dist root). */
export const ADAPTER_ASSET_PATH = 'mcp-server.mjs'

/** Suggested download location, relative to the browser download directory. */
export const ADAPTER_EXPORT_FILENAME = 'browser-copilot/mcp-server.mjs'

/** Placeholder shown before the user has exported the adapter. */
export const ADAPTER_PATH_PLACEHOLDER = '__插件目录__/mcp-server.mjs'

/** The three MCP clients the settings card ships ready-made snippets for. */
export type McpClient = 'claude' | 'codex' | 'trae'

function argFor(adapterPath?: string): string {
  // JSON.stringify doubles as the escaper for every snippet: backslashes
  // (Windows paths) become `\\` and quotes/control chars are handled too.
  return JSON.stringify(adapterPath && adapterPath.trim() ? adapterPath : ADAPTER_PATH_PLACEHOLDER)
}

/**
 * Builds the copy-ready MCP config snippet for one client.
 * @param client      target MCP client (changes format: JSON / TOML / UI)
 * @param adapterPath absolute path of an exported adapter; when omitted the
 *                    `__插件目录__` placeholder is kept.
 */
export function buildMcpSnippet(client: McpClient, adapterPath?: string): string {
  const arg = argFor(adapterPath)
  switch (client) {
    case 'claude':
      return (
        '{\n' +
        '  "mcpServers": {\n' +
        '    "browser-copilot": {\n' +
        '      "command": "node",\n' +
        `      "args": [${arg}],\n` +
        '      "env": { "BROWSER_COPILOT_TOKEN": "" }\n' +
        '    }\n' +
        '  }\n' +
        '}'
      )
    case 'codex':
      return (
        '[mcp_servers.browser-copilot]\n' +
        'command = "node"\n' +
        `args = [${arg}]`
      )
    case 'trae':
      return (
        'MCP 设置面板 → 添加 stdio MCP 服务：\n' +
        '  command: node\n' +
        `  args: [${arg}]`
      )
  }
}

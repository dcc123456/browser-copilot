/**
 * MCP adapter tool format: the `tools/list` stdio response must be standard MCP
 * format (top-level `name`/`description`/`inputSchema` per tool). Earlier the
 * adapter leaked the plugin's OpenAI-style wrapper (`{type:'function',
 * function:{name,description,parameters}}`), which Claude Code's MCP client
 * dropped — the "connected but tools empty/incomplete" bug. This test spawns
 * the real adapter over stdio and asserts the wire format, so the root-cause
 * fix cannot silently regress.
 *
 * The outcome is deterministic: whether the spawned instance becomes the main
 * adapter (port 8765 free, plugin offline → static fallback) or falls into
 * proxy mode (port occupied), `tools/list` still returns the MCP-format static
 * tool list.
 *
 * The second test covers the other reported symptom — "plugin not connected"
 * when *calling* a tool. It assembles the full chain (main adapter + a fake
 * plugin WS client + a proxy-mode adapter) and asserts a `tools/call` issued
 * through the proxy reaches the plugin instead of being rejected because the
 * proxy instance itself has no plugin socket. That regression was introduced
 * when `tools/call` bypassed `sendToPlugin` (which routes through the main
 * adapter in proxy mode) and called `sendWsRequest` directly.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ADAPTER = path.join(ROOT, 'examples', 'local-agent', 'mcp-server.mjs')
const PORT = 8765

interface Tool {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
  type?: unknown
  function?: unknown
}

let proc: ChildProcessWithoutNullStreams | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolves once a TCP listener accepts connections on 127.0.0.1:PORT. */
function waitForPort(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tryConnect = (): void => {
      const sock = net.connect(PORT, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error('timed out waiting for adapter port'))
        else setTimeout(tryConnect, 100).unref()
      })
    }
    tryConnect()
  })
}

/** Sends one JSON-RPC line and resolves with the first matching-id response. */
function rpc(
  target: ChildProcessWithoutNullStreams,
  pid: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const lines = target.stdout
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (msg.id === pid) {
          lines.off('data', onData)
          resolve(msg)
          return
        }
      }
    }
    lines.on('data', onData)
    target.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: pid, method, params })}\n`)
    setTimeout(() => {
      lines.off('data', onData)
      reject(new Error(`timeout waiting for ${method} response`))
    }, 15_000).unref()
  })
}

afterEach(() => {
  if (proc) {
    proc.kill()
    proc = null
  }
})

describe('mcp-server tools/list wire format', () => {
  it('returns every tool in MCP format with no OpenAI wrapper or schema refs', async () => {
    proc = spawn(process.execPath, [ADAPTER], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.stderr.resume()

    await rpc(proc, 1, 'initialize', {})
    const list = (await rpc(proc, 2, 'tools/list', {})) as { result?: { tools?: Tool[] } }
    const tools = list.result?.tools
    expect(tools).toBeDefined()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools!.length).toBeGreaterThanOrEqual(23)

    for (const tool of tools!) {
      // Standard MCP shape: name/description/inputSchema live at the top level.
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema).toEqual(
        expect.objectContaining({ type: 'object', properties: expect.any(Object) }),
      )
      // The OpenAI wrapper must never leak into the wire format.
      expect(tool.type).toBeUndefined()
      expect(tool.function).toBeUndefined()
    }

    // Sanitization: no $ref/$defs/oneOf anywhere, target collapsed to object.
    const raw = JSON.stringify(tools)
    expect(raw).not.toMatch(/\$ref|\$defs|oneOf|anyOf|allOf/)
    const click = tools!.find((t) => t.name === 'click')
    expect(click).toBeDefined()
    const clickSchema = click!.inputSchema as {
      properties?: Record<string, { type?: string }>
      required?: string[]
    }
    expect(clickSchema.properties?.target).toEqual(
      expect.objectContaining({ type: 'object' }),
    )
    expect(clickSchema.required).toEqual(['target'])
    const fill = tools!.find((t) => t.name === 'fill')
    const fillSchema = fill!.inputSchema as { required?: string[] }
    expect(fillSchema.required).toEqual(['target', 'value'])
  })

  it(
    'routes a proxy-mode tools/call to the plugin instead of rejecting as offline',
    { timeout: 25_000 },
    async () => {
      // --- 1. main adapter: binds 127.0.0.1:8765 -------------------------------
      const main = spawn(process.execPath, [ADAPTER], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      main.stderr.resume()
      try {
        await waitForPort()

        // --- 2. fake plugin: a WS client that answers the adapter's requests ----
      const plugin = new WebSocket(`ws://127.0.0.1:${PORT}`)
      const pluginReady = new Promise<void>((resolve, reject) => {
        plugin.onopen = () => {
          // First message makes the main adapter register this socket as "plugin".
          plugin.send(JSON.stringify({ id: 'hb-1', type: 'ping' }))
          resolve()
        }
        plugin.onerror = () => reject(new Error('fake plugin WS connection failed'))
      })
      plugin.onmessage = (event) => {
        let msg: { id?: unknown; type?: unknown; tool?: unknown }
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (msg && typeof msg.id === 'string' && typeof msg.type === 'string') {
          if (msg.type === 'tool') {
            plugin.send(
              JSON.stringify({ id: msg.id, ok: true, data: { ok: true, result: `PLUGIN-EXEC:${msg.tool}` } }),
            )
          } else if (msg.type === 'tools.list') {
            plugin.send(
              JSON.stringify({
                id: msg.id,
                ok: true,
                data: {
                  tools: [
                    {
                      name: 'open_url',
                      description: 'navigate',
                      inputSchema: {
                        type: 'object',
                        properties: { url: { type: 'string' } },
                        required: ['url'],
                      },
                    },
                  ],
                },
              }),
            )
          }
        }
      }
      await pluginReady

      // --- 3. proxy adapter: port occupied → EADDRINUSE → proxy mode ------------
      proc = spawn(process.execPath, [ADAPTER], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stderr.resume()
      await sleep(2000) // let the proxy WS handshake settle

      await rpc(proc, 100, 'initialize', {})
      const call = (await rpc(proc, 101, 'tools/call', {
        name: 'open_url',
        arguments: { url: 'https://www.baidu.com' },
      })) as { result?: { content?: { text?: string }[]; isError?: boolean } }

      // The proxy must have forwarded to the main adapter → fake plugin, so the
      // plugin's canned marker is echoed back — NOT the offline rejection.
      expect(call.result?.isError).toBe(false)
      const text = call.result?.content?.[0]?.text ?? ''
      expect(text).toContain('PLUGIN-EXEC:open_url')
      expect(text).not.toContain('插件未连接')

      plugin.close()
    } finally {
      proc?.kill()
      proc = null
      main.kill()
    }
  },
  )

  it(
    'registers a plugin that pings WITHOUT an id, so tools/call executes instead of returning "插件未连接"',
    { timeout: 25_000 },
    async () => {
      // --- 1. main adapter: binds 127.0.0.1:8765 -------------------------------
      const main = spawn(process.execPath, [ADAPTER], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      main.stderr.resume()
      proc = main // afterEach + finally both clean this up
      try {
        await waitForPort()

        // --- 2. fake plugin: mirrors the REAL Browser Copilot plugin ------------
        // The real plugin sends `{ type: 'ping' }` on connect — no `id` field.
        // The adapter must still register this socket as "the plugin", otherwise
        // tools/list returns the static fallback and tools/call fails with
        // "Browser Copilot 插件未连接".
        const plugin = new WebSocket(`ws://127.0.0.1:${PORT}`)
        const pluginReady = new Promise<void>((resolve, reject) => {
          plugin.onopen = () => {
            plugin.send(JSON.stringify({ type: 'ping' }))
            resolve()
          }
          plugin.onerror = () => reject(new Error('fake plugin WS connection failed'))
        })
        plugin.onmessage = (event) => {
          let msg: { id?: unknown; type?: unknown; tool?: unknown }
          try {
            msg = JSON.parse(String(event.data))
          } catch {
            return
          }
          if (msg && typeof msg.id === 'string' && typeof msg.type === 'string') {
            if (msg.type === 'tool') {
              plugin.send(
                JSON.stringify({
                  id: msg.id,
                  ok: true,
                  data: { ok: true, result: `PLUGIN-EXEC:${msg.tool}` },
                }),
              )
            } else if (msg.type === 'tools.list') {
              plugin.send(
                JSON.stringify({
                  id: msg.id,
                  ok: true,
                  data: {
                    tools: [
                      {
                        name: 'open_url',
                        description: 'navigate',
                        inputSchema: {
                          type: 'object',
                          properties: { url: { type: 'string' } },
                          required: ['url'],
                        },
                      },
                    ],
                  },
                }),
              )
            }
          }
        }
        await pluginReady
        await sleep(500) // let the adapter process the id-less ping and register the plugin

        await rpc(proc, 300, 'initialize', {})
        // Once registered, tools/list must return the plugin's real (1-tool) list,
        // not the 23-tool static fallback — proving the plugin is actually attached.
        const list = (await rpc(proc, 301, 'tools/list', {})) as {
          result?: { tools?: Tool[] }
        }
        expect(list.result?.tools?.length).toBe(1)
        expect(list.result?.tools?.[0]?.name).toBe('open_url')

        const call = (await rpc(proc, 302, 'tools/call', {
          name: 'open_url',
          arguments: { url: 'https://www.baidu.com' },
        })) as { result?: { content?: { text?: string }[]; isError?: boolean } }

        expect(call.result?.isError).toBe(false)
        const text = call.result?.content?.[0]?.text ?? ''
        expect(text).toContain('PLUGIN-EXEC:open_url')
        expect(text).not.toContain('插件未连接')

        plugin.close()
      } finally {
        proc?.kill()
        proc = null
      }
    },
  )
})

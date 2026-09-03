# Browser Copilot — 本地 Agent MCP 适配器（mcp-server.mjs）

`mcp-server.mjs` 是一个**零依赖**的 Node.js 本地适配器：它一边作为 MCP stdio 服务端被编码 Agent（Claude Code / Trae / Codex）自动拉起，另一边作为 WebSocket 服务端（仅回环 `ws://127.0.0.1:8765`）接收 Browser Copilot 插件的主动连接。插件是 MV3 Chrome 扩展，无法监听 TCP 端口，所以它作为 WebSocket 客户端“向外拨号”连到本适配器；编码 Agent 的每一次浏览器工具调用（MCP 工具）都由适配器通过这条 WebSocket 连接转发给插件执行，结果再原路返回。

```
┌────────────────────┐  stdio (JSON-RPC 2.0)  ┌───────────────────────┐  WS JSON  ┌───────────────────────────┐
│   编码 Agent        │ ──── 工具调用 ───────▶ │  本地适配器             │ ────────▶ │   Browser Copilot 插件     │
│ Claude Code / Trae │ ◀─── 返回结果 ───────── │  mcp-server.mjs       │ ◀────────  │   (MV3 扩展，WS 客户端)    │
│ / Codex (MCP 客户端)│                        │  MCP stdio + WS 服务端 │           │   在浏览器中实际执行操作     │
└────────────────────┘                        └───────────────────────┘           └───────────────────────────┘
```

## 安装步骤

> ⚡ **想省事？** 把下面一行复制给你的编码 Agent（Claude Code / Codex / Trae 均可），AI 会自动读取 [MCP-SETUP-PROMPT.md](MCP-SETUP-PROMPT.md) 并完成下面的安装与验证：
>
> ```text
> 请阅读 examples/local-agent/MCP-SETUP-PROMPT.md，按其中的提示词完成 Browser Copilot 的 MCP 接入；需要我在浏览器里操作时先询问我。
> ```
>
> Claude Code 用户也可以用 Claude 专用版：[AUTO-SETUP-PROMPT.md](AUTO-SETUP-PROMPT.md)。

1. **安装并启用插件**：在 Chrome 中加载 Browser Copilot 扩展，打开设置，开启 **“本地 Agent 接入 / Local agent access”**（地址默认 `ws://127.0.0.1:8765`）。可选：在插件设置里配置一个**共享 token**，并把它同步到下面 MCP 配置的 `BROWSER_COPILOT_TOKEN`（token 会附加到每个转发给插件的请求上）。
2. **给编码 Agent 添加一条 stdio MCP 配置**，命令 `node`、参数指向本文件的绝对路径（见下方各 Agent 的配置片段）。
3. **启动编码 Agent**：它会通过 stdio 自动拉起本适配器；插件检测到地址可连接后会自动重连（带退避重试）到 `ws://127.0.0.1:8765`。之后浏览器工具就会以 MCP 工具的形式出现在你的 Agent 里。

> 无需手动启动本适配器进程，也无需 npm install / Python。

## 各编码 Agent 的 MCP 配置

### Claude Code

> 📖 完整使用手册见 [CLAUDE-CODE.md](CLAUDE-CODE.md)（环境要求、配置、验证、工具清单、示例指令、排查）。

在项目根目录（或 `~/.claude`）创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "browser-copilot": {
      "command": "node",
      "args": ["<绝对路径>/mcp-server.mjs"],
      "env": {
        "BROWSER_COPILOT_TOKEN": "your-token"
      }
    }
  }
}
```

### Codex

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.browser-copilot]
command = "node"
args = ["<绝对路径>/mcp-server.mjs"]

# 可选：共享 token
# [mcp_servers.browser-copilot.env]
# BROWSER_COPILOT_TOKEN = "your-token"
```

### Trae

打开 **MCP 设置面板 → 添加 stdio MCP server**：

- command：`node`
- args：指向 `mcp-server.mjs` 的绝对路径（例如 `["d:\\works\\...\\examples\\local-agent\\mcp-server.mjs"]`）
- （可选）环境变量：`BROWSER_COPILOT_TOKEN=your-token`

## WS JSON 协议（对称 JSON 文本帧）

任意一侧都可发送请求 `{ id, type, ... }`，另一侧必须回 `{ id, ok: true, data }` 或 `{ id, ok: false, error }`。配置了共享 token 时，每个请求额外带 `token: "<token>"`。

| 方向 | 请求 | 响应 |
| --- | --- | --- |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "ping" }` | `{ "id": "<uuid>", "ok": true, "data": { "pong": true } }` |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "tools.list" }` | `{ "id": "<uuid>", "ok": true, "data": { "tools": [ { "name": "...", "description": "...", "inputSchema": { ... } } ] } }` |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "tool", "tool": "<名称>", "args": { ... } }`（args 可选） | `{ "id": "<uuid>", "ok": true, "data": <任意结果> }` 或 `{ "id": "<uuid>", "ok": false, "error": "<错误信息>" }` |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "prompt", "prompt": "<自然语言指令>" }` | 同上 |
| 插件 → 适配器 | `{ "id": "hb-<n>", "type": "ping" }`（心跳） | `{ "id": "hb-<n>", "ok": true, "data": { "pong": true } }` |

MCP 侧的映射：Agent 的 `tools/list` → WS `tools.list`；Agent 的 `tools/call`（工具名 `name`、参数 `arguments`）→ WS `tool`（`tool` + `args`）。

## 注意事项

- **无需 Python**：本方案只用 Node.js 内置模块（`node:http` / `node:crypto` / `node:readline` / `node:process`），零外部依赖。
- **无需常驻服务**：适配器由编码 Agent 通过 stdio 自动拉起、随 Agent 退出而结束；插件侧会自动带退避重试，直到连上适配器。两个进程相互独立，谁先启动都行。
- **仅回环，安全**：适配器只绑定 `127.0.0.1:8765`，外部网络无法访问；配合可选共享 token，进一步防止本机其它进程随意驱动浏览器。
- 端口 `8765` 被占用时，先停止旧的适配器进程再重试。

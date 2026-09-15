# Browser Copilot — 本地 Agent MCP 适配器（mcp-server.mjs）

`mcp-server.mjs` 是一个**零依赖**的 Node.js 本地适配器：它一边作为 MCP stdio 服务端被编码 Agent（Claude Code / Trae / Codex）自动拉起，另一边作为 WebSocket 服务端（仅回环 `ws://127.0.0.1:8765`）接收 Browser Copilot 插件的主动连接。插件是 MV3 Chrome 扩展，无法监听 TCP 端口，所以它作为 WebSocket 客户端“向外拨号”连到本适配器；编码 Agent 的每一次浏览器工具调用（MCP 工具）都由适配器通过这条 WebSocket 连接转发给插件执行，结果再原路返回。

> 📦 **使用安装包（release zip），没有源码？** 无需克隆仓库：打开插件设置 →「本地 Agent 接入」卡片，点击**导出适配器**，适配器会保存到系统下载目录的 `browser-copilot/mcp-server.mjs`，各 Agent 配置片段中的绝对路径也会自动回填。下文中的 `public/mcp-server.mjs` 路径仅适用于源码用户，安装包用户请统一替换为导出文件的绝对路径。

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

## 可选：standalone 常驻模式（让插件保持“已连接”）

默认模式下，适配器进程由编码 Agent 会话拉起、**随会话结束而退出**，`8765` 端口随之下线——此时插件设置里会显示“**未连接**”，Agent 调用工具也会得到“插件未连接”。这是最常见的一类“连不上”，并非故障。

如果希望插件**随时保持连接**（插件状态常驻“已连接”，任何编码 Agent 会话即开即用），在一个独立终端运行：

```bash
# 源码用户：
node public/mcp-server.mjs --standalone
# 安装包用户：把路径换成设置卡片导出的文件，例如
# node "$HOME/Downloads/browser-copilot/mcp-server.mjs" --standalone
# 或用环境变量：BROWSER_COPILOT_STANDALONE=1 node mcp-server.mjs
```

- standalone 模式忽略 stdin 关闭：编码 Agent 退出、终端会话挂起都不会杀死 WS 服务端（`Ctrl+C` 手动停止）。
- 常驻主适配器占用 `8765` 后，之后编码 Agent 再拉起的 `mcp-server.mjs` 实例会**自动切换到代理模式**，把 MCP 请求转发给常驻主适配器执行——各 Agent 的 MCP 配置无需任何改动。
- 插件侧断线后会以退避重试自动重连（上限约 30 秒），所以适配器一上线，插件最多约半分钟就会恢复“已连接”。

## 多窗口 / 多 Agent 分配（让多个 AI 助手各操作各的窗口）

多个编码 Agent 会话（或多个 Agent 产品）可以同时接入：首个适配器实例占用 `8765` 成为主适配器，之后的实例自动以代理模式转发，插件设置卡片会列出全部已接入连接。

默认情况下所有连接共享同一个目标窗口。要让多个助手**并发操作不同的浏览器窗口且互不干扰**：

1. 在希望某个助手操作的浏览器窗口里打开 Browser Copilot 侧栏（或保持最小化浮窗）。
2. 打开该窗口的**设置 → 本地 Agent 接入**，在「将连接分配到窗口」区域把对应连接分配给**本窗口**。
3. 对每个助手 / 窗口重复以上操作。一个窗口可分配多个连接；一个连接同一时刻只属于一个窗口。

分配后的隔离语义：

- 该连接的所有操作（点击、填写、截图、`open_url`、标签页操作、CDP 附加等）都**严格限定在被分配的窗口内**，绝不会触及其它窗口（其它窗口也不会出现 Chrome 的“扩展正在调试此浏览器”提示条）。
- 每个窗口有独立的 `pin_tab` 钉选标签页，互不覆盖。
- 一旦存在任意一条分配，**未分配窗口的连接**发来的工具调用会被拒绝，错误信息会提示去面板完成分配（`ping` 和工具发现不受影响）；删除全部分配后恢复“所有连接操作最近使用的插件窗口”的开箱即用行为。
- 分配按**连接名**持久化（名称形如 `claude@项目目录名`），适配器重启、插件 service worker 回收后依然有效；绑定窗口关闭期间回退到默认窗口，重新打开即恢复。面板里也会列出已断开连接的残留分配，可一键移除。

> 💡 **同一项目目录开多个会话时请设置唯一连接名**：默认名称由 `启动方@当前目录名` 生成，同目录的两个会话会重名并共享同一条窗口分配。给每个会话设置不同的环境变量即可区分：
>
> ```bash
> BROWSER_COPILOT_AGENT_NAME=claude@proj-a node mcp-server.mjs
> ```
>
> MCP 配置里写在该 server 的 `env` 中（与 `BROWSER_COPILOT_TOKEN` 同级）。

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
- args：指向 `mcp-server.mjs` 的绝对路径（源码用户例如 `["d:\\works\\...\\browser-copilot\\public\\mcp-server.mjs"]`；安装包用户用设置卡片导出的路径，例如 `["C:\\Users\\you\\Downloads\\browser-copilot\\mcp-server.mjs"]`）
- （可选）环境变量：`BROWSER_COPILOT_TOKEN=your-token`

## WS JSON 协议（对称 JSON 文本帧）

任意一侧都可发送请求 `{ id, type, ... }`，另一侧必须回 `{ id, ok: true, data }` 或 `{ id, ok: false, error }`。配置了共享 token 时，每个请求额外带 `token: "<token>"`。

| 方向          | 请求                                                                                 | 响应                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "ping" }`                                                 | `{ "id": "<uuid>", "ok": true, "data": { "pong": true } }`                                                                 |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "tools.list" }`                                           | `{ "id": "<uuid>", "ok": true, "data": { "tools": [ { "name": "...", "description": "...", "inputSchema": { ... } } ] } }` |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "tool", "tool": "<名称>", "args": { ... } }`（args 可选） | `{ "id": "<uuid>", "ok": true, "data": <任意结果> }` 或 `{ "id": "<uuid>", "ok": false, "error": "<错误信息>" }`           |
| 适配器 → 插件 | `{ "id": "<uuid>", "type": "prompt", "prompt": "<自然语言指令>" }`                   | 同上                                                                                                                       |
| 插件 → 适配器 | `{ "id": "hb-<n>", "type": "ping" }`（心跳）                                         | `{ "id": "hb-<n>", "ok": true, "data": { "pong": true } }`                                                                 |

MCP 侧的映射：Agent 的 `tools/list` → WS `tools.list`；Agent 的 `tools/call`（工具名 `name`、参数 `arguments`）→ WS `tool`（`tool` + `args`）。

除心跳外，适配器在每个请求上还会附带连接身份字段：`agentId`（每个适配器进程随机生成的 UUID，仅存活于当前会话）与 `agentName`（`启动方@项目目录名`，或环境变量 `BROWSER_COPILOT_AGENT_NAME`）。插件用它们完成[多窗口分配](#多窗口--多-agent-分配让多个-ai-助手各操作各的窗口)；代理模式下转发实例会带上自己的身份，不会被主适配器覆盖。主适配器还会通过无 id 的 `{ "type": "agents.update", "agents": [{ "id": "...", "name": "..." }] }` 通知插件当前全部在线连接。

## 注意事项

- **无需 Python**：本方案只用 Node.js 内置模块（`node:http` / `node:crypto` / `node:readline` / `node:process`），零外部依赖。
- **适配器生命周期**：默认由编码 Agent 通过 stdio 自动拉起、随 Agent 退出而结束；插件侧会自动带退避重试，直到连上适配器。两个进程相互独立，谁先启动都行。想让插件保持常连请用 [standalone 模式](#可选standalone-常驻模式让插件保持已连接)。
- **仅回环，安全**：适配器只绑定 `127.0.0.1:8765`，外部网络无法访问；配合可选共享 token，进一步防止本机其它进程随意驱动浏览器。
- 端口 `8765` 被占用时，先停止旧的适配器进程再重试。

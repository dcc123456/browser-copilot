# Browser Copilot MCP 接入提示词（让 AI 自助安装）

把本文件的提示词交给你的编码 Agent（Claude Code / Codex / Trae 或其他支持 MCP 的
AI 编程助手），它会替你完成 Browser Copilot 的 MCP 接入：检查环境 → 写入 MCP 配置 →
引导你在浏览器里开启接入 → 验证链路。全程你只需要回答几个问题和在浏览器里点一次开关。

## 使用方法（二选一）

1. **整段粘贴**：复制下面「提示词」代码块里的**全部内容**，发送给你的 AI。
2. **让它自己读**：直接对 AI 说——

   ```text
   请阅读 examples/local-agent/MCP-SETUP-PROMPT.md，按其中的提示词完成
   Browser Copilot 的 MCP 接入，逐步执行并在需要我操作时先询问我。
   ```

> **前提**：Node.js ≥ 18；Chrome 已加载 Browser Copilot 插件。无需 Python、
> 无需 `npm install`、无需常驻服务。
>
> **相关文档**：[适配器说明](README.md) ·
> [Claude Code 专用提示词](AUTO-SETUP-PROMPT.md) ·
> [Claude Code 使用手册](CLAUDE-CODE.md)

---

## 提示词（中文，复制以下全部内容）

```text
请帮我完成 Browser Copilot 插件（一个 Chrome 扩展）的 MCP 接入，让你获得一组
browser-copilot 浏览器工具：打开网址、读取页面、点击、填表、按键、切换标签页、执行
JavaScript、识别图片/验证码文字、保存本地文件等。接入完成后，你就可以一边写代码、
一边亲自操作我本机的 Chrome 浏览器来验证效果。

整个过程只需要 Node.js 和已安装的插件：适配器脚本（examples/local-agent/mcp-server.mjs，
零依赖 Node 脚本）会在你启动时被自动拉起，随会话退出而结束，无需常驻服务。

请严格按下面的步骤执行，每步都告诉我结果；凡需要我在浏览器里手动操作的步骤，先把步骤
展示给我并等我确认，不要臆测我已完成。

## 第 0 步：确认环境与你的配置方式
1. 运行 node --version，确认 Node.js ≥ 18；缺失则提示我安装后停止。
2. 判断你自己属于哪种 MCP 客户端，并确定对应的注册方式（第 2 步使用）：
   - Claude Code：写 ~/.claude.json（用户级，等价 claude mcp add --scope user）或项目
     根目录 .mcp.json（项目级，等价 --scope project）；
   - Codex：编辑 ~/.codex/config.toml 的 [mcp_servers.*] 段；
   - Trae：在 MCP 设置面板手动添加 stdio MCP 服务（把参数准备好交给我填）；
   - 其他或不确定：按「stdio MCP 服务器：command=node，args=[适配器绝对路径]」给我
     通用指引。
3. 询问我 Browser Copilot 仓库/插件目录的绝对路径（其下应有
   examples/local-agent/mcp-server.mjs）；如果我本会话已提供过就直接使用，不确定就
   停下来问，不要乱猜路径。确认该文件存在，否则停止并报告。

## 第 1 步：确定共享令牌（可选，但建议设置）
1. 问我是否设置共享令牌（用于防止本机其他进程随意驱动浏览器）。
2. 选「是」：用 node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
   生成随机令牌并记录；选「否」：令牌记为空字符串 ""。
3. 把最终决定（是否启用令牌及令牌值）明确告诉我，因为第 3 步我需要手动填进插件设置。

## 第 2 步：注册 MCP 服务（服务名固定为 browser-copilot）
按第 0 步确定的方式写入配置，参数统一为：
- command：node
- args：mcp-server.mjs 的绝对路径（JSON 里 Windows 反斜杠要转义成 \\，TOML 里原样）
- env：BROWSER_COPILOT_TOKEN = 第 1 步的令牌或空字符串

参考片段——Claude Code（.mcp.json 或 ~/.claude.json）：
{
  "mcpServers": {
    "browser-copilot": {
      "command": "node",
      "args": ["<适配器绝对路径>"],
      "env": { "BROWSER_COPILOT_TOKEN": "<令牌或空字符串>" }
    }
  }
}

参考片段——Codex（~/.codex/config.toml）：
[mcp_servers.browser-copilot]
command = "node"
args = ["<适配器绝对路径>"]
（启用令牌时再追加：[mcp_servers.browser-copilot.env] 下
BROWSER_COPILOT_TOKEN = "<令牌>"）

Claude Code 也可以直接用命令：claude mcp add --scope user --transport stdio
browser-copilot -- node "<适配器绝对路径>"（项目级把 --scope user 换成 --scope project）。

注意：若配置文件中已有其它 mcpServers/mcp_servers，必须保留并合并，绝不能覆盖我已有的
MCP 配置。写完后校验 JSON/TOML 合法性。完成后提醒我：需要重启你（新开会话/重载 MCP）
才会加载新配置，等我重启并回来后再继续。

## 第 3 步：引导我在浏览器里开启接入（必须人工完成）
把下面步骤逐条展示给我，并等我回复「已完成」再继续：
1. 保持 Chrome 运行，Browser Copilot 扩展已启用。
2. 打开插件侧边栏 → 设置 → 「本地 Agent 接入」卡片，打开开关。
3. 适配器地址保持默认 ws://127.0.0.1:8765。
4. 若第 1 步设置了令牌，把令牌值填入「共享令牌（可选）」输入框。
5. 确认该卡片状态显示「已连接」（我重启你之后，插件会自动连上你拉起的适配器）。

## 第 4 步：验证链路
1. 确认你能看到 browser-copilot 的 MCP 工具（如 read_current_page、snapshot_page、
   click、fill、open_url、run_javascript 等；Claude Code 可用 /mcp 查看）。
2. 冒烟测试：调用 open_url 打开 https://example.com，再用 read_current_page 读取
   标题并返回给我。
3. 如果失败，按顺序排查并修复：
   a. 插件「本地 Agent 接入」卡片是否显示「已连接」（Chrome 是否在运行、开关是否打开）；
   b. 两边令牌是否一致（MCP 配置里的 BROWSER_COPILOT_TOKEN 与插件设置中的值必须完全
      相同，要么都有要么都空）；
   c. 端口 8765 是否被旧适配器进程占用（结束占用该端口的 Node 进程后重试）；
   d. args 里的适配器绝对路径是否正确；
   e. 我是否已重启你加载新配置。
   循环修复直到验证通过，或我要求停止。

## 交付说明
全部通过后，用几句话总结：① 注册的 MCP 服务名和写入/修改的配置文件路径；② 我需要保持
的状态（Chrome 运行 + 插件已开启本地 Agent 接入）；③ 邀请我直接下一条浏览器指令试试。
```

---

## Prompt (English — copy everything below)

```text
Please set up MCP access to the Browser Copilot Chrome extension for me, so you
gain a set of browser-copilot browser tools: open URLs, read pages, click, fill
forms, press keys, switch tabs, run JavaScript, recognize image/CAPTCHA text,
and save local files. Once connected, you can write code and verify the result
yourself in my Chrome.

Only Node.js and the installed extension are needed: the adapter script
(examples/local-agent/mcp-server.mjs, a zero-dependency Node script) is spawned
automatically when you start and exits with your session — no daemon required.

Follow the steps strictly and report each result. Any step I must do in the
browser: show me the steps and wait for my confirmation; never assume I already
did them.

## Step 0 — environment and your config style
1. Run `node --version`; require Node.js >= 18, otherwise stop and tell me to
   install it.
2. Determine which MCP client you are and how you register servers (used in
   step 2):
   - Claude Code: write ~/.claude.json (user scope, equivalent to
     `claude mcp add --scope user`) or .mcp.json in the project root
     (project scope, equivalent to `--scope project`);
   - Codex: edit the [mcp_servers.*] section of ~/.codex/config.toml;
   - Trae: I add a stdio MCP server in its MCP settings panel (hand me the
     values to paste);
   - Anything else / unsure: give generic stdio MCP guidance
     (command=node, args=[absolute adapter path]).
3. Ask me for the absolute path of the Browser Copilot repo/plugin folder (it
   must contain examples/local-agent/mcp-server.mjs); reuse it if I already
   gave it this session; if unsure, stop and ask — never guess the path.
   Verify the file exists, otherwise stop and report.

## Step 1 — shared token (optional but recommended)
1. Ask whether to set a shared token (it stops other local processes from
   driving the browser).
2. Yes -> generate one with
   `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
   and record it; No -> use the empty string "".
3. Tell me the final choice and value clearly — I must enter it in the
   extension settings in step 3.

## Step 2 — register the MCP server (name it browser-copilot)
Write the config using: command = `node`; args = absolute path to
mcp-server.mjs (escape backslashes as \\ inside JSON); env
BROWSER_COPILOT_TOKEN = the token or empty string.
- Claude Code (.mcp.json or ~/.claude.json):
  {"mcpServers":{"browser-copilot":{"command":"node","args":["<adapter path>"],
   "env":{"BROWSER_COPILOT_TOKEN":"<token or empty>"}}}}
- Codex (~/.codex/config.toml):
  [mcp_servers.browser-copilot]
  command = "node"
  args = ["<adapter path>"]
- Claude Code may also just run: claude mcp add --scope user --transport stdio
  browser-copilot -- node "<adapter path>"
Preserve and merge with any existing mcpServers/mcp_servers entries — never
overwrite my other MCP config. Validate the file afterwards. Then remind me to
restart you (new session / reload MCP) and wait for me before continuing.

## Step 3 — walk me through the browser switch (manual, I must do it)
Show each item and wait for my "done":
1. Keep Chrome running with the Browser Copilot extension enabled.
2. Open the side panel -> Settings -> "Local agent access" card, turn the
   switch on.
3. Keep the adapter address ws://127.0.0.1:8765.
4. If a token was set in step 1, enter it in "Shared token (optional)".
5. The card must show "Connected" (after I restart you, the extension
   auto-connects to the adapter you spawned).

## Step 4 — verify the chain
1. Confirm the browser-copilot MCP tools are visible (read_current_page,
   snapshot_page, click, fill, open_url, run_javascript, ...; `/mcp` in
   Claude Code).
2. Smoke test: call open_url on https://example.com, then read_current_page
   and report the page title to me.
3. On failure, troubleshoot in order: a) the extension card shows "Connected"
   (Chrome running? switch on?); b) tokens match on both sides (both set
   identically, or both empty); c) port 8765 held by a stale adapter (kill
   that Node process and retry); d) the adapter path in args is correct;
   e) I restarted you to load the new config. Iterate until it passes or I ask
   you to stop.

## Final report
Summarize: 1) the registered MCP server name and the config file(s) written;
2) the state I must keep (Chrome running + Local agent access on); 3) invite
me to try a browser command.
```

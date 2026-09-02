# 让 Claude Code 自动安装 Browser Copilot MCP（自安装提示词）

## 使用方法

1. 打开你的项目目录，启动 Claude Code（`claude`）。
2. 把下面「提示词」代码块中的**全部内容**整段粘贴给 Claude Code 并回车。
3. AI 会自动检查环境、询问插件路径与令牌、写入 MCP 配置，并一步步引导你在 Chrome 里开启插件接入，最后验证连通。

> 前提：已安装 Node.js ≥ 18，Chrome 中已加载 Browser Copilot 插件。无需 Python。

---

## 提示词（复制以下全部内容）

```text
请帮我自动安装并打通 Browser Copilot 插件的 MCP 接入，让本会话能直接调用插件去控制我的 Chrome 浏览器（读取页面、点击、填表、验证码识别、执行 JS 等）。整个过程只需要 Node.js 和已安装的插件，不需要 Python、不需要手动启动任何服务。

请严格按下面的步骤执行，逐步告诉我每步的结果；凡是需要我在浏览器里手动完成的步骤，先说明再做，并等我确认，不要臆测我已完成。

## 第 0 步：检查前置条件
1. 运行 `node --version` 确认 Node.js ≥ 18 已安装；如果缺失，提示我安装后停止。
2. 询问我 Browser Copilot 插件在磁盘上的目录绝对路径（该目录下应有 examples/local-agent/mcp-server.mjs）。如果本会话中我已提供过就直接使用；不确定就停下来问我，不要乱猜路径。
3. 确认 examples/local-agent/mcp-server.mjs 存在；不存在就停下并报告错误。

## 第 1 步：决定安装范围与共享令牌
1. 问我安装范围（二选一）：
   - 选「全局安装」：MCP 服务对这台机器上所有项目生效，配置写入 `~/.claude.json`（即 Claude Code 的 claude.json 配置文件，等价 `claude mcp add --scope user`）。
   - 选「项目安装」：只对当前项目生效，配置写入当前项目根目录 `.mcp.json`（等价 `claude mcp add --scope project`，会被 Claude Code 合并进 claude.json）。
2. 问我是否设置共享令牌：
   - 选「是」：用 Node 生成一个随机令牌（例如 `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`），记录该值，稍后同步填入插件设置和 MCP 配置。
   - 选「否」：后续 MCP 配置中的 BROWSER_COPILOT_TOKEN 写空字符串 ""。
3. 把最终决定（安装范围、是否启用令牌、令牌值）明确告诉我，因为第 3 步我需要手动把它填进插件设置。

## 第 2 步：注册 MCP 服务
按第 1 步选定的范围，在 `~/.claude.json`（全局，即 claude.json 配置文件）或当前项目根目录 `.mcp.json`（项目）创建/更新配置（若已存在其它 mcpServers，务必保留并合并，不要覆盖用户已有的 MCP 配置），内容形如（多行缩进，不要平铺成一行）：

{
  "mcpServers": {
    "browser-copilot": {
      "command": "node",
      "args": ["<mcp-server.mjs 的绝对路径>"],
      "env": { "BROWSER_COPILOT_TOKEN": "<令牌或空字符串>" }
    }
  }
}

注意：Windows 路径里的反斜杠在 JSON 中要转义成双反斜杠。写完后校验 JSON 合法性。

（也可以用命令达到同样效果：全局安装用 `claude mcp add --scope user --transport stdio browser-copilot -- node "<绝对路径>"`，项目安装用 `claude mcp add --scope project --transport stdio browser-copilot -- node "<绝对路径>"`。）

完成后务必提醒我：需要重启 Claude Code 才能加载这个新 MCP 服务。等我重启并重新进入会话后再继续下一步。

## 第 3 步：引导我在浏览器里开启插件接入（必须人工完成）
这一步你无法替我操作，请把下面步骤逐条展示给我，并等我回复「已完成」再继续：
1. 保持 Chrome 运行，并已加载 Browser Copilot 插件。
2. 打开插件侧边栏 → 设置 → 找到「本地 Agent 接入」卡片。
3. 打开「允许本地 Agent 接入」开关（适配器地址保持默认 ws://127.0.0.1:8765）。
4. 若第 1 步设置了令牌，把令牌值填入「共享令牌」输入框。
5. 确认该卡片状态显示「已连接」（而不是红色错误）。
6. 若该卡片列出了多个连接（多个 agent 同时接入），连接名由启动方与项目目录推导（如 `claude@<项目名>`），稳定可辨认；选择后若该连接断开，插件会自动回退到「全部连接」。

## 第 4 步：验证链路
1. 让我运行 /mcp，确认 browser-copilot 服务已连接且列出了工具（工具 schema 已净化为标准 MCP 格式：顶层 name/description/inputSchema，无 $ref/$defs/oneOf，所有工具可完整加载进会话）。
2. 做一次冒烟测试：调用工具打开 https://example.com 并读取页面标题，把标题返回给我。
3. 如果失败，按顺序排查并修复：
   a. 插件设置里「本地 Agent 接入」是否为「已连接」（浏览器是否在运行、开关是否开启）；
   b. 令牌是否一致（claude.json/.mcp.json 中的 BROWSER_COPILOT_TOKEN 与插件设置中的值必须完全相同，要么都有要么都空）；
   c. 端口 8765 是否被占用（找出占用该端口的 Node 进程并结束它后重试）；
   d. args 里的 mcp-server.mjs 绝对路径是否正确。
4. 循环验证直到通过，或我要求停止。

## 交付说明
全部通过后，用一两句话总结：① 注册的 MCP 服务名；② 写入/修改的配置文件路径；③ 我在浏览器里需要保持什么状态（Chrome 运行 + 插件已开启本地 Agent 接入）。
```

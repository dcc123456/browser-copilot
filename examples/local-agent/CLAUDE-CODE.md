# Claude Code × Browser Copilot 使用手册

> 让 **Claude Code** 直接调用你的 Chrome 浏览器——读取当前页面、点击、填表、验证码识别、执行 JS，然后自动继续改代码。**无需 Python、无需手动启动任何服务**，插件启用后自动连接。

---

## 1. 它能做什么

在 Claude Code 里，你会多出一批 `browser-copilot_*` 的 MCP 工具，例如：

- 打开网址、切换/关闭标签页、列出所有标签页
- 读取当前页面内容、获取可交互元素快照（按钮/链接/输入框）
- 点击、输入文字、选择下拉项、勾选复选框、按键盘键、滚动
- 识别图片/验证码文字
- 运行自定义 JavaScript
- 读取/填写用户资料与保存的凭证（不泄露值）
- 使用/创建可复用的技能、把内容保存为本地文件

典型工作流：**Claude Code 打开网页 → 读取页面 → 修改你的代码 → 回浏览器验证**。

---

## 2. 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | Claude Code 本身就需要，无需额外安装 |
| Chrome 浏览器 | 装了 Browser Copilot 扩展，且保持运行 |
| Claude Code CLI | 已安装并登录 |
| Browser Copilot 插件 | 已加载到 Chrome（开发模式加载或正式安装均可） |

---

## 3. 一次性配置

### 3.1 在插件里开启“本地 Agent 接入”

1. 打开 Chrome → 点击 Browser Copilot 图标 → 打开侧边栏 → **设置**。
2. 找到 **“本地 Agent 接入”** 卡片，打开开关 **“允许本地 Agent 接入”**。
3. 适配器地址保持默认 `ws://127.0.0.1:8765`（无需修改）。
4. （可选但**强烈建议**）设置一个**共享令牌**，例如 `my-browser-token`。设置了令牌后，只有携带相同令牌的请求才会被执行。

> 开启后，插件会以 WebSocket 客户端身份自动连接本机适配器。可在该卡片看到实时状态：**未连接 / 连接中 / 已连接**。
>
> 多个 agent 同时接入时，该卡片会列出各连接供选择；连接名由**启动方与项目目录**推导（如 `claude@<项目名>`），稳定可辨认。若你选中的连接断开，插件会自动回退到「全部连接」继续服务。

### 3.2 给 Claude Code 添加 MCP 服务

**方式 A（推荐）：直接写配置文件**

Claude Code 的 MCP 配置统一记录在 **`claude.json`**：用户级为 `~/.claude.json`，项目级则写在项目根目录的 `.mcp.json`（会被 Claude Code 合并读取）。二选一，写入以下多行 JSON（不要平铺成一行）：

```json
{
  "mcpServers": {
    "browser-copilot": {
      "command": "node",
      "args": ["<绝对路径>/examples/local-agent/mcp-server.mjs"],
      "env": {
        "BROWSER_COPILOT_TOKEN": "my-browser-token"
      }
    }
  }
}
```

把 `<绝对路径>` 替换为插件目录下 `examples/local-agent/mcp-server.mjs` 的完整路径，例如：

- macOS/Linux：`"/Users/you/projects/browser-copilot/examples/local-agent/mcp-server.mjs"`
- Windows：`"D:\\works\\browser-copilot\\examples\\local-agent\\mcp-server.mjs"`

> 若你在插件设置里**没有**配置令牌，就把 `env` 里的 `BROWSER_COPILOT_TOKEN` 留空字符串 `""`；配置了令牌则必须与插件设置中的值**完全一致**。

**方式 B：用命令添加（等效）**

```bash
claude mcp add --transport stdio browser-copilot \
  -- node "<绝对路径>/examples/local-agent/mcp-server.mjs"
```

### 3.3 启动 Claude Code

```bash
cd 你的项目
claude
```

Claude Code 启动时会通过 stdio 自动拉起 `mcp-server.mjs` 适配器（它是零依赖 Node 脚本，随 Claude Code 退出而结束，**无需常驻**）。插件侧会自动带重试连到 `ws://127.0.0.1:8765`。

---

## 4. 验证连接

1. 在 Claude Code 里输入 `/mcp`，应看到 `browser-copilot` 已连接。
2. 让 Claude 执行一次最简单的调用：

   ```
   打开 https://example.com 并告诉我页面标题
   ```

   若返回页面标题，说明整条链路（Claude Code → 适配器 → 插件 → 浏览器）已打通。
3. 也可以在插件设置页看“本地 Agent 接入”状态是否为**已连接**。

> **注意**：浏览器必须保持运行，且插件处于启用状态。若浏览器关闭或插件被禁用，工具调用会返回“Browser Copilot 插件未连接”的明确错误。

---

## 5. 常用示例指令

以下指令可直接复制给 Claude：

```text
# 读取页面
打开 https://news.ycombinator.com 并总结前 5 条新闻的标题

# 搜索并点击
在百度搜索 "Browser Copilot"，打开第一条结果，读取页面内容

# 表单填写 + 提交
打开 https://example.com/login，把用户名填为 demo、密码填为 123456，然后按回车提交

# 验证码识别
打开登录页，用识别图片工具读取验证码图片，填入验证码输入框，然后提交

# 遍历标签页
列出当前所有标签页，切换到第 2 个，读取它的内容

# 页面调试
打开 https://example.com，执行 JS 返回页面上所有 <h2> 的文本

# 修改代码后回浏览器验证
阅读当前页面的渲染结果，然后修复 src/App.tsx 里导致布局错乱的问题，改完再刷新页面确认
```

---

## 6. 可用工具清单

> **工具 schema 已净化为标准 MCP 格式**：所有工具均以顶层 `name` / `description` / `inputSchema` 暴露，不含 `$ref` / `$defs` / `oneOf` 等引用结构，可被 Claude Code 完整加载进会话，`/mcp` 中列出即为最终可用形式。

下表来自插件当前版本（工具会随插件更新而增减，`/mcp` 中展示的以实际为准）。

| MCP 工具名 | 作用 |
| --- | --- |
| `read_current_page` | 读取当前标签页的标题、URL、选中文本与可见文本 |
| `snapshot_page` | 读取页面**并列出可交互元素**（按钮/链接/输入框），点击/填表前先调用它 |
| `click` | 点击元素（按钮、链接、标签页等） |
| `fill` | 向输入框/文本域输入文字（替换原有内容） |
| `select_option` | 在下拉框中选择选项 |
| `set_checkbox` | 勾选/取消复选框，或选中单选按钮 |
| `press_key` | 按键盘键（Enter、Tab、Escape、ArrowDown 等） |
| `scroll` | 滚动页面或元素（按偏移 / 到底 / 到顶 / 进入视野） |
| `wait_for` | 等待某元素出现（如菜单展开后） |
| `open_url` | 让当前标签页跳转到指定 URL |
| `tab_new` | 新开标签页（可选导航到 URL）并切换过去 |
| `tab_switch` | 按索引切换到窗口中的另一个标签页 |
| `tab_close` | 关闭当前标签页 |
| `list_tabs` | 列出当前窗口所有标签页（索引、标题、URL） |
| `run_javascript` | 在页面里执行自定义 JS 并返回结果 |
| `recognize_image` | 识别图片/验证码文字（需在插件设置里配置图片识别模型） |
| `get_my_profile` | 读取保存的个人资料（姓名/邮箱/电话等，供填表） |
| `list_secrets` | 列出已保存的凭证条目与字段名（**不含值**） |
| `get_secret` | 用已保存的凭证直接填充字段（值不暴露给模型） |
| `use_skill` | 加载并执行一个已保存的技能 |
| `create_skill` | 创建/更新一个可复用技能 |
| `list_scheduled_tasks` | 列出已启用的定时任务 |
| `save_local` | 把内容保存为本地文件（报告/摘要/表格等） |

---

## 7. 安全说明

- **只有回环地址**：适配器只绑定 `127.0.0.1:8765`，外部网络无法访问。
- **共享令牌**：建议在插件设置中配置令牌，并同步到 `claude.json`（或 `.mcp.json`）的 `BROWSER_COPILOT_TOKEN`。令牌不一致的请求会被拒绝（`Invalid token`）。
- **启用即授权**：开启“本地 Agent 接入”后，本机上连接该适配器的程序可以驱动浏览器操作页面（等同用户本人操作）。请仅在可信环境开启，并保管好令牌。
- **凭证不泄露**：`get_secret` 填充密码时，密码值不会以明文形式进入模型上下文。
- **禁用工具仍被拦截**：你在插件设置中“禁用”的工具，即使 agent 请求也会被拒绝。

---

## 8. 常见问题排查

| 现象 | 原因与解决 |
| --- | --- |
| `/mcp` 里没有 browser-copilot | `claude.json`/`.mcp.json` 路径写错，或 `<绝对路径>` 未替换。用 `claude mcp list` 检查，路径务必为 `mcp-server.mjs` 的**绝对路径**。 |
| 工具返回“插件未连接” | 浏览器未运行 / 插件未启用 / 未开启“本地 Agent 接入”。**注意：工具列表能看到不代表插件已挂上**——插件离线时 `/mcp` 里显示的是适配器的内置兜底工具列表，工具一旦调用就会报“插件未连接”。打开插件设置确认状态为“已连接”；若插件显示已连接仍报此错，请**重新加载扩展**（`chrome://extensions` 里点刷新）并**重启 Claude Code 会话**，确保插件与适配器都运行新版本。 |
| 连接后立刻断开、反复重连 | 端口 8765 被旧适配器进程占用。结束占用 8765 的 Node 进程后重试。 |
| 返回 `Invalid token` | `claude.json`/`.mcp.json` 里的 `BROWSER_COPILOT_TOKEN` 与插件设置中的令牌不一致；或插件设置了令牌而 MCP 配置没带（或反之）。统一后重开 Claude Code。 |
| `/mcp` 已连接但工具没进当前会话 | 会话启动早于配置写入，或插件当时未连接。适配器在插件离线时会返回**内置兜底工具列表**，但已开始的会话不会自动刷新工具集——请**重启 Claude Code 会话**（或 `/mcp` 重新加载）再试；若仍为空，先让插件处于“已连接”状态再重开。 |
| 页面操作提示“需要批准” | 部分工具（点击/填表/执行 JS 等）在本机 bridge 下默认直接执行（开启接入即视为授权）；若插件侧对某些高危操作仍要求批准，请在弹出的侧边栏确认。 |
| 改完代码后页面没刷新 | 用 `tab_switch`/`open_url` 或 `run_javascript` 执行 `location.reload()` 刷新验证。 |

---

## 9. 架构速览

```
Claude Code (MCP 客户端)
     │  stdio · JSON-RPC 2.0（自动拉起适配器，退出即结束）
     ▼
mcp-server.mjs（本地适配器 · 零依赖 Node）
     │  WS JSON · ws://127.0.0.1:8765（仅回环）
     ▼
Browser Copilot 插件（MV3 service worker · WebSocket 客户端）
     ▼
在你的 Chrome 浏览器中实际执行操作
```

- 适配器由 Claude Code 自动拉起，无需手动运行、无需 `npm install`、**无需 Python**。
- 插件作为 WebSocket 客户端主动拨号连接适配器，带指数退避重连与心跳保活。
- 插件不可达时，工具调用会得到明确的中文错误信息，而不是静默失败。

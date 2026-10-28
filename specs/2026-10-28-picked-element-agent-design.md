# 拾取结果供本地 Agent 读取（无卡片选择）设计

- 日期：2026-10-28
- 状态：已实现（2026-10-28）
- 相关：`src/inpage/element-picker/**`、`src/inpage/element-picker-launcher.ts`、`src/background/element-selection-store.ts`、`src/background/agent.ts`、`src/lib/messages.ts`、`src/sidepanel/SettingsTab.tsx`

## 1. 背景与目标

本地 Agent（MCP 客户端）已经能通过 `click` / `fill` 等工具操作页面，但模型自己“看到”的页面是
`snapshot_page` 列出的可交互元素与 `read_current_page` 的文本。用户想表达的是：

> 我在页面上亲手选中了这个元素，你直接读它，然后照它来操作。

因此需要三件事：

1. 准星的 copy 模式不再显示左下角的拾取卡片：遮罩 + 跟随高亮就是全部交互，点击元素即按
   设置的格式复制，然后关闭。
2. 设置 →「元素选择器」新增开关 **`elementPickerSelectOnly`**：开启后点击不复制，只选中并
   记录元素，高亮保留在选中元素上，再次点击或 Esc 才关闭——方便用户先选中、再去本地 Agent
   对话让它读取。
3. 每次 copy 模式点击都把该元素的定位信息（唯一 CSS 选择器、标签、文本、HTML 片段、
   页面 URL/标题）记到后台；新增 Agent / MCP 工具 **`read_selected_element`** 读取这份记录，
   并直接给出可用的 `target`，模型可立刻用 `click` / `fill` 操作同一个元素。

非目标：

- 不改工作流编辑器的 `select` 模式拾取（它必须有卡片才能调父/子、切 XPath、校验）。
- 不新增第二套拾取器、第二条浏览器驱动或第二个 MCP 适配器（AGENTS.md §5.6）。
- 不让拾取结果自动进入聊天输入框；仍由用户/Agent 主动读取。

## 2. 选型与证据

| 决策点       | 结论                                                                       | 依据 / 否决理由                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拾取卡片     | copy 模式不再渲染 `.pick-card`，保留遮罩与高亮                             | 卡片位于 `left:16px; bottom:16px`（`element-picker/index.ts`）；无卡片时遮罩 + 跟随高亮足以标识“正在拾取”，且用户认可这种干净的外观。工作流编辑器的 select 模式仍需要卡片。                                             |
| 默认点击行为 | 点击（click 级）即复制 + 记录 + 关闭                                       | 不能在 pointerdown 提交：提交会 `cleanup()` 摘掉 window 级监听，随后的 mousedown/click 会落到页面上，可能打开链接或提交表单。现有拦截顺序正好在 click 阶段吞掉最后一个事件，所以在 click 里提交可保证页面一次都收不到。 |
| 仅选中模式   | `elementPickerSelectOnly`：首次点击只记录、不复制，高亮保留；再点/Esc 关闭 | 用户要先在页面上“标出”元素，再切到本地 Agent 对话；若点击即关闭，遮罩与高亮消失，用户无法确认自己选的是哪个元素。第二次点击不再重新锁定，避免高亮跳到关闭点击的位置。                                                   |
| 何时记录     | 两种 copy 行为每次点击都记录，与剪贴板成败无关                             | Agent 需要“用户最后一次拾取”；剪贴板失败也保留记录。                                                                                                                                                                    |
| 记录存哪     | `chrome.storage.session`，按 tabId 保存                                    | service worker 会被回收，模块内存会丢；会话存储随浏览器会话结束清空，正合“本次浏览的最后拾取”。会话存储在扩展页/worker 可用，内容脚本不需要直接访问。                                                                   |
| 谁来写记录   | 拾取器 `sendMessage({ type:'picker:selection' })` → worker 写入            | 拾取器已被注入到页面隔离世界，现有 `picker:result` 走同一条通道；worker 用 `sender.tab.id` 定键，不需要拾取器知道 tabId。                                                                                               |
| 过期判定     | 记录里带 `url`；工具执行时与当前标签页 URL 比较，返回 `stale`              | 页面跳转后旧选择器可能指向别的元素；不自动删除（用户可能只是切走了再回来），由模型看到 `stale` 后自行重新快照/请用户重选。                                                                                              |
| 载荷上限     | text ≤ 2000；html ≤ 20000；url ≤ 2000（记录端与存储端各截断一次）          | 工具结果每轮都会重发；整页 outerHTML 可达数 MB，data: URL 也可能极长。`htmlTruncated` 明确告知被截断。超长 URL 截断后可能被判 `stale`，属于保守处理。                                                                   |
| 工具分类     | 加入 `READ_TOOLS`（观察类，无副作用）                                      | 只读会话存储、不注入页面；无人值守回合可直接执行，semi 模式仍走用户批准卡（与 `list_tabs` 一致）。                                                                                                                      |
| MCP 暴露     | 加入 `TOOLS` 即由 `tools.list` 下发；`STATIC_TOOLS` 同步补一条兜底         | `public/mcp-server.mjs` 插件离线时回退静态清单，漏掉会让本地 Agent 启动时看不到该工具。                                                                                                                                 |

## 3. 数据流

1. launcher 启动/收到 `elementPicker.set` 时保存 `{ enabled, locale, format, selectOnly }`；
   点击准星 → `startPicker({ mode:'copy', copyFormat, locale, selectOnly })`。
2. copy 模式没有卡片：`card.style.display = 'none'`，只有遮罩 + 高亮；点击事件链照旧被吞，
   在 `click` 阶段调用 `commitCopy()`（Enter 走同一条路径）。
3. `commitCopy()`：
   - 默认：计算复制载荷 → `copyPlainText`；`reportSelection(el)` 发送 `picker:selection`；
     `cleanup()`；成功/失败都显示对应 toast。
   - `selectOnly`：首次按下只 `reportSelection(el)`，遮罩与高亮保留；再次按下/Esc 才 `cleanup()`，
     仍不写剪贴板、不再重新锁定。
   - `reportSelection` 载荷：`{ selector, tag, id?, classes?, text, html, htmlTruncated?, url, title, pickedAt }`。
4. worker 的单入口监听器把 `picker:selection` 交给 `handlePickerMessage(message, sender.tab.id)`，
   校验并写入 `chrome.storage.session` 的 `pickedElements`（键为 tabId，最多 20 条，超出按
   `pickedAt` 淘汰最旧）。
5. 本地 Agent 调 `read_selected_element`：按 `ctx.scope` 解析当前自动化标签页 → 读该 tab 的记录 →
   返回 `{ ok, selector, target: { primary: { how:'css', value }, fallbacks: [] }, tag, id, classes,
text, html, htmlTruncated, url, title, pickedAt, stale }`。无记录时返回可行动的英文错误，
   提示用户先在页面上点准星拾取。

## 4. 已知边界

- 拾取器只在顶层 frame 注入，iframe 内元素无法拾取（与既有拾取器一致）。
- copy 模式没有卡片，用户无法现场切换 id/class/nth-child 选项，使用设置里的默认组合。
- `selectOnly` 下不写剪贴板；需要复制时把开关关掉再点一次准星。
- 记录按标签页保存，不做跨标签页查找；Agent 要对同一个标签页操作才能读到。
- 页面跳转后记录仍在（返回 `stale: true`），由模型判断是否继续使用。
- 拾取器属于扩展自己的内容脚本；`picker:selection` 与其它扩展内消息一样由 worker 校验字段类型与长度。

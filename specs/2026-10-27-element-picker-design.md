# 页面元素选择器（复制 HTML）与设置分组设计

- 日期：2026-10-27
- 状态：已实现（2026-10-27）
- 相关：`src/inpage/element-picker/**`、`src/inpage/floating-button.ts`、`src/sidepanel/SettingsTab.tsx`

## 1. 背景与目标

设置里的「下载目录 / 本地 Agent 接入 / 团队共享」位于面板最底部，常用入口需要反复滚动；
同时希望有一个轻量的“取页面结构给模型看”的入口：在网页上点一个按钮、选一个元素，就能把
该元素及其子元素的 HTML 复制出来，用户自己粘贴到对话里。

目标：

1. 设置页把这四个模块（含新增的「元素选择器」开关）移到顶部，更新卡片保持最后。
2. 新增开关 `elementPickerEnabled`（默认关闭）。开启后，每个 http(s) 页面右侧出现一个十字准星图标按钮。
3. 点击按钮进入拾取：悬停高亮、点击锁定、可切父/子元素；确认后把 `outerHTML` 原样写入剪贴板，
   并给出“复制了多少字符”的反馈。
4. 关闭开关后已打开的页面立即移除按钮；页面刷新后按存储的设置恢复。

非目标：

- 不自动插入聊天输入框（用户明确要求自己粘贴）。
- 不为按钮做拖拽/位置持久化（保持最小实现）。
- 不把开放 Shadow Root 的内部结构内联进复制结果（复制所选元素自身的 `outerHTML`）。
- 不新增第二套浏览器驱动或第二个元素拾取器。

## 2. 选型与证据

| 决策点   | 结论                                       | 依据 / 否决理由                                                                                                                                                                                           |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拾取器   | 复用 `startPicker`，新增 `html` 模式       | 现有拾取器已实现悬停高亮、按下吞掉事件（弹出层不会被点关）、锁定、父/子导航、Shadow DOM 卡片。新写一套会复制这套易错逻辑，违反 §5.2/§5.5。                                                                |
| 按钮宿主 | 新增静态内容脚本 `element-picker-launcher` | 与 `floating-button.ts` 同属“页面常驻控件”，manifest 由 `CONTENT_SCRIPT_SOURCES` 同时供 Chrome/Firefox 构建；不复用最小化按钮的生命周期，避免两个状态机耦合。                                             |
| 配置读取 | service worker 回答 `elementPicker.status` | 设置可能存于用户选择的文件目录（File System Access），页面脚本读不到；沿用在用的 `floating.status` 模式。                                                                                                 |
| 触发注入 | 内容脚本直接调用 `startPicker`             | 内容脚本与 `chrome.scripting.executeScript({func})` 都在扩展隔离世界，行为一致；无需新增后台 picker 协议，避免第二条挂载路径。                                                                            |
| 剪贴板   | `document.execCommand('copy')`             | manifest 只授予 `clipboardRead`，没有 `clipboardWrite`；`src/lib/clipboard.ts` 已记录 `navigator.clipboard` 在扩展页可能挂起。拾取器是自包含函数不能 import，故在函数内内联同一实现（注释标明重复来源）。 |
| 复制内容 | 所选元素的 `outerHTML`，不截断             | 需求原文是“这个元素下的 html 元素都复制下来”。超过 10 万字符给出醒目提示但仍旧复制，避免静默丢数据。                                                                                                      |

## 3. 交互与数据流

1. 设置开关写入 `settings.elementPickerEnabled`，后台在 `settings.set` 后向所有标签页广播
   `elementPicker.set { enabled, locale }`；对没有内容脚本的旧标签页，开启时补注入 launcher 文件。
2. launcher 启动时询问 `elementPicker.status`，按 `{ enabled, locale }` 决定是否挂载；点击按钮
   → `startPicker({ mode: 'html', locale })`。
3. html 模式卡片只保留父/子与「复制 HTML」：悬停显示标签，锁定后显示标签 + 字符数；
   Enter/按钮提交，Esc/× 关闭。复制成功 → 关闭卡片 + 轻提示；失败 → 卡片保留并提示重试。
4. html 模式不发送 `picker:result` / `picker:cancel`，不进入工作流编辑器的监听扇出。
5. 拾取期间隐藏 launcher，`cleanup()` 恢复，避免“再次点击启动器”与页面按下拦截互相干扰。

## 4. 已知边界

- 扩展重载前就打开的标签页，要等下一次切换开关才会出现按钮（与最小化悬浮按钮一致，不做自愈轮询）。
- 跨域 iframe、`chrome://` 等不可注入页面没有按钮。
- 所选元素位于开放 Shadow Root 内时，复制的是该元素自身的 HTML，不含宿主边界。
- 超大元素复制可能被浏览器拒绝，此时卡片显示失败提示，不假装成功。

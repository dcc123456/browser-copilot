# 参数输入算子：运行时交互对话框（Automa 风格）设计

日期：2026-11-06
状态：已实现

## 1. 诉求

`parameter-prompt`（参数输入）算子目前只在运行时**静默**从变量作用域与声明的 `defaultValue`
取值；缺失的必填参数直接抛错。用户要求像 Automa 一样：执行到该算子时弹出交互对话框，让用户
填写声明的参数后再继续。

## 2. 外部语义取证（§7.1）

- Automa 官方文档对 Parameter prompt 块的描述是：该块**显示一个弹窗让用户输入**，并支持
  **timeout 跳过等待**（原文：“The block shows a popup for user input. It supports a timeout
  to skip waiting.”）。
- 本次无法取得 Automa 源码作为一手证据：raw.githubusercontent 抓取失败，本机也没有 `gh` CLI，
  检索结果噪声较大。因此行为语义以官方文档描述为准，不臆造源码细节。
- 据此确定的三条契约：
  1. 运行到该算子时暂停并请求输入；
  2. 等待有上限（`timeout`，0 表示不主动超时）；
  3. 超时后不失败，按默认值/已有值继续。

## 3. 决策

### 3.1 只有“有人看”的运行才弹窗

`WorkflowRunOptions.requestInput` 由集成层（`run-workflow.ts`）**仅在调用方带
`promptToken`** 时提供。编辑器工具栏运行、侧边栏“运行”都会带 token；Runner、定时任务、
触发器等无人值守路径不带，保持原有静默行为。理由：无头运行没有人能回答问题，挂起只会把
工作流拖死。

### 3.2 请求/应答通道：广播 + token 路由

- 发起页（编辑器 / 侧边栏）在发送 `workflows.run` 前生成 `promptToken` 并写入模块级会话
  （`src/ui/run-input-session.ts`），避免 React 状态更新与 worker 首次广播的竞态。
- 后台 `run-input-hub.ts` 维护 `requestId → Promise resolve` 表；收到执行器的请求后通过
  `chrome.runtime.sendMessage` 向所有扩展页广播 `workflows.runInputRequest`（带 token）。
- 只有 token 匹配当前会话的页面渲染对话框；回答走 `workflows.runInputAnswer`，后台按
  `requestId` 结算。结算后再广播 `workflows.runInputSettled`，让超时 / 其它窗口的残留
  对话框自动关闭。
- 等待期间 `retain()` 持有 keepalive，结算时 `release()`（包含超时、取消、回答三种路径）。

### 3.3 超时与取消

- `timeout` 沿用算子表单默认 60000ms；`0` 表示“不主动超时”，但 MV3 worker 不可能永久存活，
  因此映射为 `RUN_INPUT_MAX_WAIT_MS = 9 分钟`（keepalive 上限 10 分钟之内）。
- 超时：写一行 info，继续用默认值/作用域已有值；必填仍缺失则照旧失败。
- 用户点“停止运行”：执行器抛出 `name = 'AbortError'` 的错误，引擎把它记为 `cancelled`
  （与点击取消按钮一致），而不是一次“算子失败”。
- 对话框的 Escape / 点击遮罩**不关闭**：关闭一个阻塞式提问只可能意味着停止运行，误触不应
  杀掉流程；“停止运行”是显式按钮。

### 3.4 值的读写规则

- 预填优先级：作用域已有值 > 插值后的 `defaultValue` > 空。
- 对象值显示为格式化 JSON（不再出现 `[object Object]`）。
- 秘密字段（`secret: true`）不回传真实值，对话框始终空白；空白回答表示“沿用已保存的值”。
  对话框通过 `secretStored` 布尔值判断“空白是否可接受”。
- 回写时按参数类型 `coerceInputValue`（number / json / checkbox）。
- 运行日志里的结果行对秘密参数输出 `***`（复用 `execution-evidence.ts` 的 `MASK`），
  避免密钥进入可复制、可展示、可交给 AI 助手的运行日志。

### 3.5 面板预设值与 `/` 菜单（本次追加）

- **预设值存放位置**：`Workflow.parameterValues?: Record<string, string>`，保存的是表单原文，
  按声明类型在运行时用 `coerceInputValue` 转换。放在工作流顶层而不是算子 `data` 里，因为
  定时任务读取的是已保存的工作流，而不是编辑器画布。
- **优先级**：触发声明的默认值 < 面板保存值 < 调用方传入的 `variables`（触发查询、飞书参数）。
  后两者更具体，应覆盖默认值。
- **不再询问**：`executeWorkflow` 在启动时把预设值算成 `presetInputs` 同时传给作用域种子和
  引擎；`parameter-prompt` 只对 `presetInputs` 里没有名字的参数发问。全部已配置时只写一行
  info，不弹窗，因此定时/无人值守运行也能正常跑完。
- **密钥永不落盘**：`presetInputScope` 跳过 `secret: true` 的声明；面板也只列出、不可编辑。
  工作流定义会被导出、下载并交给 AI 助手，凭据写进去等于泄露。
- **独立保存命令**：`workflows.parameterValues` 只改这一个字段（`touchUpdatedAt: false`，
  不 bump revision）。编辑器的画布可能还有未保存改动，保存参数不能顺带提交它们，也不应让
  “未保存”圆点亮起。
- **`/` 菜单**：`collectSuggestions` 在触发输入之后追加“可达的”参数输入块声明（含分组子节点）。
  只算上游：另一条分支上的参数块还没运行，列出它会让用户写出运行时为空值的引用。
- **入口**：工作流列表每行的**参数**按钮与编辑器工具栏的**参数**标签页（仅当图上存在参数输入
  算子时出现），共用 `src/ui/WorkflowParametersDialog.tsx`；清空单个字段或全部字段都是显式按钮。

### 3.6 复用

- 模态外壳复用 `src/ui/FormDialog.tsx` 及其按钮。
- 字段预填/回写与分析逻辑放在 `src/lib/workflow/run-input.ts`（chrome-free，可被两侧 UI
  与测试共用）。
- 参数读取、必填判断、类型转换继续复用 `workflow-inputs.ts`，不新造解析层。

## 4. 改动范围

- 新增：`src/lib/workflow/run-input.ts`、`src/background/run-input-hub.ts`、
  `src/ui/RunInputDialog.tsx`、`src/ui/RunInputHost.tsx`、`src/ui/use-run-input-request.ts`、
  `src/ui/run-input-session.ts`、`src/ui/WorkflowParametersDialog.tsx`
- 预设值：`Workflow.parameterValues`、`storage.ts` 白名单、`workflows.parameterValues` 命令、
  `workflow-inputs.ts` 的 `parameterPromptInputsOf` / `presetInputScope`、`var-suggestions.ts`
  的可达上游参数、`run-workflow.ts` 的种子与 `presetInputs` 传递
- 引擎：`WorkflowRunOptions.requestInput`；`WorkflowExecCtx.requestInput`；子工作流透传
- 执行器：`parameter-prompt` 在存在 hook 时请求输入；无 hook 行为不变
- 运行路径：`executeWorkflow` 仅在 `promptToken` 存在时构造 hook
- 消息：`workflows.run.promptToken`、`workflows.resume.promptToken`、
  `workflows.runInputAnswer`、推送接口 `WorkflowsRunInputRequest/Settled`
- UI：编辑器 `handleRun` 与侧边栏 `runNow`/`resumeNow` 生成并清理 token；两端根节点挂载
  `RunInputHost`（portal 到 `document.body`，侧边栏隐藏 tab 也能显示）
- i18n：`src/lib/i18n.ts`（en + zh-CN）与 `src/workflow-editor/i18n.ts`（en + zh）
- 文档：`docs/workflow/operators-general.md` 与 `.zh-CN.md`

## 5. 测试

- `tests/parameter-prompt-interactive.spec.ts`：请求形状、类型回写、超时、取消、
  秘密不回传/日志遮蔽、必填失败、无 hook 路径。
- `tests/run-input.spec.ts`：超时解析（含 0 与空串）、字段预填、对象 JSON、秘密处理。
- `tests/run-input-hub.spec.ts`：广播、回答、超时、中止、keepalive 成对释放、重复回答无效。
- `tests/run-input-dialog.spec.ts`：必填 / JSON / 已存秘密的校验。
- `tests/run-input-session.spec.ts`：token 路由与过期清理。
- `tests/workflow-inputs.spec.ts`：参数块声明读取（含分组子节点、重名去重）、预设值类型转换、
  空白/未声明/密钥值跳过。
- `tests/parameter-prompt-interactive.spec.ts`：有预设值时只询问剩余字段；全部已配置时不发问。
- `tests/workflow-storage.spec.ts`：`parameterValues` 通过 `asWorkflow` 白名单，非法映射被丢弃。
- `tests/workflow-parameters-dialog.spec.ts`：表单字段构建与“只持久化已声明、非空、非密钥值”。
- `tests/var-suggestions.spec.ts`：参数块声明出现在下游 `/` 菜单。

## 6. 未覆盖 / 已知边界

- 调试（`workflows.debug`）与自动修复的验证运行不注入 hook，仍按默认值静默执行：它们由后台
  自行编排，中途插入人工问答会阻塞无人值守的修复循环。若后续需要，可复用同一 token 机制。
- 同一页面同时发起两个运行时，会话只记最近一次的 token；更早的提问会按超时处理。
- 扩展页 UI 的浏览器实证需手动加载 unpacked extension，本次以单元/引擎测试为准（见交付说明）。

# 设计：`ask_user` 澄清提问工具

日期：2026-09-19
状态：已确认（用户已批准实施计划与 v2 修订）

## 背景与目标

browser-copilot 的智能体（`src/background/agent.ts`）在需求模糊、缺少关键取值（选哪个选项、覆盖还是跳过、用哪个账号）时只能自行猜测。猜测错了会浪费多轮工具调用，甚至做出用户不想要的操作。

目标：新增智能体工具 `ask_user`——模型调用它时，工具循环暂停，侧边栏弹出提问卡片（结构化建议 + 自由文本回答 + 忽略），用户的回答作为工具结果返回给模型，回合继续。

**关键设计决策：**

1. 通道形态：完全复用 `confirm` 审批卡的请求/响应通道（worker 持 resolver Map → port 下发 request → 面板回发 answer），仅把布尔值换成 `{answer, cancelled}`。
2. 审批策略：`ask_user` **不**加入 `ACTION_TOOLS` / `READ_TOOLS`——提问本身就是交互，`modeAutoApproves` 在所有模式下都直接放行，绝不再套一层审批卡。
3. 无人值守行为：无 `askUser` 依赖时（定时任务 / 飞书 / 工作流 AI-agent 块 / local-agent bridge）返回 `{ok:false}` 并附「自行按合理默认值决策并声明假设」的指引，而不是挂死回合；且 schema 在无人值守回合**不下发**（`advertiseTools` 的 `hidden` 过滤），分派层拒绝仅作纵深防御。
4. 回答形态：纯文本（选中建议或自由输入）；不设超时，等待语义与 `confirm` 一致（取消 / 面板关闭即视为忽略）。

**v2 修订（用户确认的三条约束）：**

5. 建议强制结构化：`options` 为 `{label, pros, cons}` 对象数组，**至少 3 项、至多 6 项**，每项 label/pros/cons 必填（schema 与分派层双重校验，违反即返回可执行错误让模型补齐重调，绝不弹卡）；`question` 必须先说明情况与待决策点；**推荐项置顶**（无独立标记字段），面板默认选中第 0 项并打「推荐」徽标；用户可改选、可手输（手输优先），确认后提交。
6. 全自动模式节制：不硬禁用（必要场景仍可用），在 `buildSystemPrompt` 的 FULL AUTO 模式段落追加「仅当决策真正阻塞且难以回退（花钱 / 删数据 / 对外发送）时才用 ask_user，否则自行选择最优项并声明假设」。
7. 定时任务与工作流禁止：workflow 生成模式下 `advertiseTools` 不下发 schema，分派层对幻觉调用返回 `not available in workflow-generation mode`；无人值守路径同上（决策 3）。工作流的**重放执行**本就走无人值守 AI-agent 块，同样被覆盖。

## 方案取舍（已否决的备选）

- **方案 B（纯审批卡扩展：把 confirm 卡变成可输入文本）**：通道复用度最高，但把「审批一次性动作」与「澄清开放问题」两个语义压进一个消息类型，面板卡片状态机与历史兼容都会变复杂。否决。
- **方案 C（回复即答案：模型提问后等用户下一条聊天消息）**：无需新协议，但回合已结束，上下文（快照、refs、任务状态）全部丢失，模型只能重头再来。否决。

## 详细设计

### 2.1 线路协议（`src/lib/messages.ts`）

- `AgentServerMessage` += `{ type: 'ask_user.request'; requestId; question: string; options: Array<{label, pros, cons}> }`（v2：结构化建议，索引 0 为推荐项）
- `AgentClientMessage` += `{ type: 'ask_user.answer'; requestId; answer: string; cancelled: boolean }`

### 2.2 工具定义（`src/background/agent.ts` TOOLS）

```json
{
  "name": "ask_user",
  "description": "Ask the user to decide when the request is ambiguous or a required choice is missing. \"question\" must first EXPLAIN the situation and what exactly needs deciding; then \"options\" carries 3-6 candidate approaches, each with one-line \"pros\" and \"cons\", the RECOMMENDED one FIRST (the UI pre-selects it and the user confirms or types their own). NEVER call without options.",
  "parameters": {
    "type": "object",
    "properties": {
      "question": {
        "type": "string",
        "description": "Explain the situation and the decision needed, in the user's language."
      },
      "options": {
        "type": "array",
        "minItems": 3,
        "maxItems": 6,
        "items": {
          "type": "object",
          "properties": {
            "label": { "type": "string", "description": "The suggestion, one line." },
            "pros": { "type": "string", "description": "Its main advantage." },
            "cons": { "type": "string", "description": "Its main drawback or risk." }
          },
          "required": ["label", "pros", "cons"]
        }
      }
    },
    "required": ["question", "options"]
  }
}
```

- 不进任何 on-demand group（核心集，semi/full/readonly 直接可见）；**workflow 生成模式与无人值守回合不下发**（见决策 6/7）；用户可在设置中禁用（禁用后 schema 不再下发，幻觉调用由 `runOneToolCall` 的 disabled 检查拒绝）。

### 2.3 执行分派（`runOneToolCall` 专用分支）

位置：子代理白名单检查之后、readonly/chat 模式闸门之前——

- 尊重子代理白名单：专长子智能体只有勾选了 `ask_user`（或工具列表为空 = 继承全部）才能提问；
- 无视模式闸门：readonly/chat 下幻觉出的 `ask_user` 调用也能被优雅处理，而不是落进 `executeTool` 的 "Unknown tool"。

行为：

1. **workflow 模式拒绝**（`deps.getMode()`）：返回 `not available in workflow-generation mode`，summary `Blocked (workflow mode)`。
2. **结构化校验**（v2）：`question` 必填（trim 后非空，上限 2000 字符）；`options` 清洗为 `{label, pros, cons}` 均非空的对象，**≥3 项、≤6 项**，label ≤80、pros/cons ≤200 字符。违反 → 不询问用户，返回一条可执行错误（`requires "question" … 3-6 "options" … "label", "pros" and "cons"; put the recommended option first`）让模型补齐后重调。
3. 无 `deps.askUser`（无人值守）→ `{ok:false, error:'No interactive user is connected (unattended run)…'}`，summary `No interactive user (unattended run)`。
4. 调用 `deps.askUser({question, options})`：
   - `cancelled` → `{ok:false, cancelled:true, error:'The user dismissed the question…'}`，summary `User dismissed the question`；
   - 正常 → `{ok:true, answer}`，summary `User answered: "<前 80 字符>"`。
5. `recordAction` 记录问答明细（`action: 'ask_user'`，args 携带结构化 options）。`workflowFromHistory` 会跳过 `ACTION_TO_BLOCK` 之外的 action，因此不会生成伪工作流节点。

### 2.4 端口接线（`src/background/index.ts`）

- `pendingAskUser: Map<string, (answer: {answer, cancelled}) => void>` 与 `pending` 并列；
- `ask_user.answer` 消息 → resolve + 删除；
- `cancel` 与 `port.onDisconnect` → 全部 resolve 为 `{answer:'', cancelled:true}`（与 confirm 的「无人可答即拒绝」语义一致）；
- 面板回合的 `askUser` 依赖使用**端口级** `send`（与 `confirm` 相同，而非 `sendWithTracking`）：子代理的 muted `deps.send` 会丢弃进度消息，但提问卡必须送达面板——这是 orchestrator 中「confirm 原样复用、审批不被静音」同一不变量的延伸。

### 2.5 面板卡片（`src/sidepanel/ChatTab.tsx`）

- `PendingAskUser {requestId, question, options}` 状态数组 + `ask_user.request` case；
- `AskUserCard` 组件（v2）：复用 `.confirm-card` 外观；建议以 **radio 列表**呈现——索引 0 为推荐项，默认选中并带 `t.chatAskRecommended`「推荐」徽标，每项渲染 `✓ {pros}`（text-ok）与 `✗ {cons}`（text-warn）两行；点击仅选中（不再点击即答）；自由文本输入非空时提交优先于选中项（Enter 同逻辑，IME `isComposing` 防误发）；提交用 `t.dialogConfirm`（Confirm/确认），忽略用 `t.cancel`；样式全部使用 Tailwind 语义 token（`border-border` / `bg-sunken` / `text-ink` / `text-ok` / `text-warn` / `bg-accent-soft` / `placeholder:text-faint`），不新增 CSS class；
- 会话切换 / 新建 / 删除时随 `setConfirms([])` 一并清空。

### 2.6 目录与 i18n

- `tool-catalog.ts`：`ToolCategory` 新增 `'ask'`，`TOOL_META` 增加 `ask_user`（设置里可禁用、专长子智能体编辑器里可勾选）；
- `AgentEditDialog.tsx`：`CATEGORY_ORDER` 追加 `'ask'`；
- `i18n.ts`（封闭 `Messages` 类型强制 en + zh 对齐）：`toolAskUser` / `toolAskUserWarn` / `chatAskTitle` / `chatAskPlaceholder` / `chatAskRecommended`；按钮复用既有 `dialogConfirm`、`cancel`，不造重复 key。

### 2.7 local-agent bridge 防线

`tools.list` 原样下发 `TOOLS`，bridge 侧 `runToolStandalone` 显式拒绝 `ask_user`（明确报「需要交互面板」，优于通用 Unknown tool）。

## 测试与预算

- `tests/agent-ask-user.spec.ts`（11 用例）：往返、忽略、无人值守拒绝、缺 question、禁用拒绝、广告位（semi/full/readonly 可见；workflow 与 chat 不可见）、无人值守回合 schema 不下发（hidden 过滤）、`modeAutoApproves` 全模式放行、**<3 项拒绝且不弹卡**、**缺 pros/cons 拒绝**、**workflow 模式幻觉调用拒绝**。
- `tests/agent-payload-size.spec.ts`：`ask_user` 结构化 schema 与 FULL AUTO 节制句加入后，按该文件的惯例**有意**上调全部预算（advertised 20_000、catalog 25_500、workflow round-1 25_000、category 34_000、ALL 56_000、full 57_500、workflow/full 总量比 1.4）。

## 行为矩阵

| 场景                                 | 行为                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| 半自动 / 只读（面板）                | 弹提问卡（推荐项默认选中），回答回到模型                                |
| 全自动（面板）                       | schema 照常下发；FULL AUTO 提示要求仅在真正阻塞且难回退时使用（决策 6） |
| 工作流生成模式                       | **禁止**：schema 不下发，幻觉调用返回 not available（决策 7）           |
| chat 模式                            | 不下发 schema；幻觉调用被专用分支优雅处理                               |
| 委派的专长子智能体                   | 白名单勾选 `ask_user`（或继承全部）才可提问；请求经端口级 send 直达面板 |
| 定时任务 / 飞书 / 工作流 AI-agent 块 | **禁止**：schema 不下发（hidden 过滤）+ 无依赖时优雅 `{ok:false}`       |
| local-agent bridge                   | 显式拒绝                                                                |
| 设置中禁用                           | schema 不下发，幻觉调用被拒绝                                           |
| 调用缺建议 / 缺优缺点                | 不弹卡，返回可执行错误让模型补齐重调（决策 5）                          |
| 用户取消 / 关闭面板                  | resolve 为 cancelled，模型按「自定默认值并声明假设」继续或停止          |

## 边界情况

- 同一回合多个 `ask_user` 并发调用 → 卡片堆叠，按 `requestId` 独立 resolve。
- worker 在等待期间被回收 → 回合与其他回合一样结束；卡片状态为内存态（与 confirm 卡一致的既有限制）。
- 无超时：等待语义与 `confirm` 相同；面板 ping 维持 MV3 worker 存活。

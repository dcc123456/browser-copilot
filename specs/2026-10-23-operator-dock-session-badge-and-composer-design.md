# AI 算子助手：新建会话、用户编辑摘除 AI 标识、输入框拖动高度

- 日期：2026-10-23
- 范围：`src/workflow-editor/ai/OperatorChatDock.tsx`、`src/workflow-editor/App.tsx`、
  `src/lib/workflow/node-goal-contract.ts`、`src/workflow-editor/i18n.ts`
- 关联：`specs/2026-10-19-editor-operator-ai-chat-design.md`、
  `specs/2026-10-19-operator-ai-observe-and-edit-design.md`、
  `specs/2026-10-22-operator-assistant-thinking-output-vocabulary-and-pending-picks-design.md`

三个用户可见的缺口，各自独立、互不依赖：

1. 对话只能一直续下去，没有「新建会话」。
2. AI 添加的算子即使被用户改过参数，节点上仍挂着 AI 徽标，来源信息变成误导。
3. 输入框只有原生 `resize-y` 手柄，且被 `max-h-28`（112px）封顶，往上拖几乎立刻
   到底，看起来像「不能拖」。

## 1. 新建会话

**行为**：标题栏在关闭按钮左侧加一个图标按钮（`SquarePen`，`aria-label` / `title`
走 i18n），点击后清空本次对话：`turns`、`input`、`picked`、`stream`、流式缓冲；
`readPage` 属于用户偏好，保留。

**在途请求**：新会话可能发生在模型仍在生成、或页面观察仍在执行时。

- 若 `busy`，先复用现有 `stop()` 发出取消（后台已经支持两种取消命令）。
- 新增 `sessionGenerationRef` 代际计数，新会话自增；`send()` / `actOnce()` 在
  `await` 之后、任何 `pushTurn` / `resolveTurn` / `setBusy` 之前核对代际，代际变了
  就整体丢弃该回复（含 `catch` 与 `finally`）。流式监听本来就按
  `activeSessionRef` 过滤，新会话把它置空即可。

**否决**：

- 只在 `!busy` 时允许新建：用户会被一次卡住的请求困住，且取消设施已经存在。
- 给新会话加确认弹窗：对话仅是组件内存状态，不是持久数据，弹窗成本大于收益。

**空对话时**按钮 `disabled`（`turns.length === 0 && !busy`），不隐藏——按钮位置稳定。

## 2. 用户编辑后摘除 AI 标识

**现状**：`withNodeAddedByAi` 写入 `data.__workflowAi.addedBy = 'ai'`；`BlockNode`
据此渲染徽标。AI 自己写入的路径（`installPatchedNode`）不经过用户编辑，不能动。

**做法**：在 `node-goal-contract.ts` 增加纯函数 `withoutNodeAddedByAi(data)`：

- 没有 `__workflowAi` 或没有 `addedBy`：原样返回同一个对象（不制造无意义的新引用）。
- 有 `addedBy`：只摘掉这一个字段；同命名空间里的 `goalContract` 原样保留。
- 摘完后命名空间为空：连命名空间一起删掉，不留 `{}` 垃圾。

**接线点**：`App.tsx` 的 `patchNode` —— 所有用户编辑算子的表单（块编辑表单、设置
模态、分组改名、凭证生产者的变量回写）都走它。AI 的落地路径走
`installPatchedNode`，不经过 `patchNode`，因此不会被误摘。

**语义**：徽标回答的是「这个节点是不是助手放上去的、还没被用户接管」。用户一改
参数，该节点就是用户的作品；保留徽标会让用户误以为内容仍归助手所有。

## 3. 输入框拖动高度

**做法**：去掉原生 `resize-y` 与 `max-h-28` 上限，改用输入框上沿的拖动条：

- 组件状态 `composerHeight`（默认 52px），clamp 在 52–240px（`COMPOSER_MIN_HEIGHT`
  / `COMPOSER_MAX_HEIGHT`）。
- 拖动条：`role="separator"`、`aria-orientation="horizontal"`、
  `aria-valuemin/max/now`、`tabIndex=0`、`cursor-ns-resize`，一条细握把线；`mousedown`
  记录起点与起始高度，`window` 上监听 `mousemove`（向上拖 = 变高）/ `mouseup` 解绑。
- 键盘：`ArrowUp` / `ArrowDown` 每次 16px，`preventDefault`。
- 高度通过内联 `style={{ height }}` 下发——这是运行时值，符合 AGENTS §2 对内联样式
  的例外；其余样式仍用 Tailwind token。
- 面板高度固定（`min(560px, 70vh)`），输入框变高只压缩上方可滚动对话区。

**否决**：

- 只把 `max-h-28` 调大、继续用原生手柄：手柄在右下角、和发送按钮挤在一起，仍然
  不可发现；且原生拖动不受组件控制，无法测试。
- 自动随内容长高：用户明确要求「手动拖动增加高度」，自动长高会在长文本时抢走
  对话区，且与手动拖动叠加会互相打架。

## 测试

- `tests/node-goal.spec.ts`（或同层纯测试）：摘除后 `nodeAddedByAi === false`、
  `nodeGoalContractOf` 仍返回原契约；无标识时返回值 === 入参；命名空间只剩
  `addedBy` 时命名空间整体消失。
- `tests/acceptance-operator-chat-dock.spec.tsx`：
  - 新建会话清空对话与输入框，且不调用 `onApply`；
  - 在途回复在新会话之后到达时被丢弃（代际守卫）；
  - 拖动条 `mousedown` + `mousemove` 改变 `textarea.style.height`，上下越界时分别
    clamp 到 52 / 240；
  - 空对话时新建按钮 disabled。

## 未覆盖 / BLOCKED

- 真实浏览器中的手感（拖动是否跟手、Grip 是否可见）需要加载 unpacked extension
  手工确认；`chrome-extension://` 页面无法被 MCP 驱动，本轮标记 BLOCKED。

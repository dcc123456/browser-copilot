# 工作流失败重试（循环语义补齐）设计

- 日期：2026-09-04
- 状态：已评审通过（用户确认）
- 范围：`src/background/workflow-engine/engine.ts`、`src/background/workflow-engine/executors.ts`、新增 `src/background/workflow-engine/loop-breakpoint.ts`、测试、README 文档

## 1. 背景与目标

用户需要在工作流中实现"整组步骤失败重试"：以登录工作流为例，登录失败时刷新
验证码、重新输入验证码、重新登录，最多重试 5 次。

现状盘点：

- **单块重试已存在**：每个块可配置 `onError`（重试 N 次 + 间隔），但只能重试
  同一个块，无法表达"一组步骤 + 失败检测 + 条件重试"。
- **引擎缺口一（end 分支失效）**：循环块（`repeat-task`/`while-loop`/
  `loop-data`/`loop-elements`）的 output-2 "end" 出口在编辑器中可见、可连线，
  但 `runLoop` 在迭代结束后直接 `return null`，"end" 分支永远不会被执行，
  导致"循环之后继续后面的步骤"无法表达。
- **引擎缺口二（断点块是空操作）**：`loop-breakpoint` 在执行器注册表中是
  `noop`，成功时无法提前跳出循环。
- **隐患**：循环体入口取 `outEdges[0]`（第一条连出的边），与出口句柄无关；
  若用户先连 "end" 再连 "loop"，循环体会错误地指向 end 分支。

目标：补齐上述语义，让"失败重试"用现有块（`repeat-task` + `element-exists` +
`loop-breakpoint` + `set-variable` + `conditions`）即可搭建，不需要新增专用块。

非目标（YAGNI）：专用"重试组"块、人工输入验证码的交互式暂停、
`parameter-prompt` 块的真实交互化。

## 2. 方案选型（已确认）

- **方案 A（采纳）**：补齐引擎循环语义（end 分支 + loop-breakpoint），用现有
  循环块组合实现整组重试。一次改动，所有组重试场景受益；Automa 标准用法；
  改动集中在纯函数引擎层，可直接单测。
- 方案 B（否决为产品方案，降级为文档应急用法）：零引擎改动，用反向连线 +
  `increase-variable` + `conditions` 手工成环。图乱、不可复用、易搭错。
- 方案 C（否决）：新增专用"重试组"块。概念贴合但需要新 UI + 分组执行语义 +
  分组失败检测，工作量数倍，且失败检测仍要靠 element-exists，没有省事。

## 3. 详细设计

### 3.1 新增 `loop-breakpoint.ts`（哨兵模块）

```ts
export class LoopBreakpointError extends Error {
  constructor(public loopId?: string) {
    super('loop-breakpoint')
    this.name = 'LoopBreakpointError'
  }
}
```

独立小模块的原因：`engine.ts` 导入 `EXECUTORS`（来自 `executors.ts`），若
`executors.ts` 再从 `engine.ts` 导入哨兵类会形成循环依赖；独立模块被两端导入，
依赖图保持无环。

### 3.2 引擎语义变更（`engine.ts`）

**end 分支生效**

- `runNode` 中循环块分支改为：
  `return runLoop(current, params, bodyStart, endId)`，其中
  `bodyStart = outputs['loop'] ?? outputs['output-1'] ?? defaultNext`
  （按句柄语义取循环体入口，消除连线顺序敏感），
  `endId = outputs['end'] ?? outputs['output-2'] ?? null`。
- `runLoop` 四个循环分支在迭代自然耗尽（或被断点跳出）后返回 `endId` 而非
  `null`；`endId` 未连线时为 `null`，行为与现状一致（向后兼容）。
- 运行失败/取消路径不变：迭代中出现块失败（`outcome !== 'ok'`）仍直接返回
  `null`，整个运行按失败/取消结算。

**loop-breakpoint 语义**

- `executors.ts` 中 `'loop-breakpoint'` 执行器改为：抛出
  `LoopBreakpointError`（节点数据 `values.loopId` 为非空字符串时携带，
  用于定向往外跳层）。
- 哨兵传播与捕获的位置：`runNode` 只负责原样上抛；每个循环分支对
  `runSegment(...)` 的调用点捕获哨兵，由拥有该循环体的 `runLoop` 判定是否
  跳出：
  - 无 `loopId` → 跳出最内层包含它的循环（最内层 `runLoop` 先捕获，天然生效）；
  - 有 `loopId` → 依次匹配循环节点的 `data.values.loopId`、`data.loopId`、
    节点 id，命中才跳出；不命中则重新抛出，交由外层循环判定；
  - 传到最外层仍无循环捕获（断点不在任何循环内，或 `loopId` 永不匹配）→
    benign：在 `runCore` 顶层捕获，记录 info 日志（"loop-breakpoint: 不在
    循环内，已忽略"），运行在该处收尾、`outcome` 为 `ok`，不判失败。
- `runNode` 的执行器 catch 在进入 onError 重试/回退/失败结算**之前**先识别
  哨兵并原样上抛（与 `AbortError` 的处理先例一致）。效果：断点块自身配置了
  onError 重试也不会被吞掉、不会被重试、不会触发 fallback/失败。

**取消语义**

- abort 优先于断点哨兵：`runNode` 的 catch 中保留现有的 `isAbort` 判定在前，
  哨兵上抛在后；两者共存时按既有取消语义结算为 `cancelled`。

### 3.3 执行器变更（`executors.ts`）

仅一处：`'loop-breakpoint': noop` → 真执行器。其余块零改动；
OCR（写入 `lastOcrText`）、`element-exists`（exists/notExists 分支）、
`set-variable`、`conditions` 均已具备登录示例所需能力。

### 3.4 参考接法：登录 + 验证码重试（写入 README 的示例）

```
[repeat-task ×5]
   ├ loop → [点"刷新验证码"] → [OCR: 验证码图片元素 → lastOcrText]
   │        → [填表单: 验证码框 ← {{lastOcrText}}]
   │        → [点"登录"] → [等待 2s] → [element-exists: 错误提示选择器]
   │                                        ├ 存在(失败) → 连回 repeat-task 节点（下一轮重试）
   │                                        └ 不存在(成功) → [set-variable loginOk=true] → [loop-breakpoint]
   └ end → [conditions: loginOk 存在?]
              ├ 成立 → [登录后步骤…]
              └ 不成立 → [重试 5 次均失败的处理（notification 通知，或 javascript-code
                          throw new Error('登录重试 5 次均失败') 使运行判失败）]
```

要点：成功与"5 次耗尽"共用 end 出口，用 `loginOk` 变量 +
`conditions` 区分两种结局；这是 Automa 兼容的做法，不需要给循环节点加第三个
出口。

### 3.5 测试设计（扩展 `tests/workflow-phase4.spec.ts`，必要时新 spec）

1. 四种循环块迭代耗尽后走 "end" 分支，且 "end" 目标节点**只执行一次**
   （回归：现状是 "end" 不执行，而 "end" 前挂的块会被误当成循环体尾每轮执行）。
2. `while-loop` 条件首轮即为假（0 次迭代）→ 直接走 "end" 分支。
3. `loop-breakpoint` 在体内 → 提前跳出，从 "end" 继续；断点节点以哨兵上抛、
   不计入 `completedNodeIds`，后续迭代不再执行。
4. 嵌套循环：内层断点只跳内层，外层继续；带匹配 `loopId` 的断点跳出外层。
5. 断点在循环外 → 运行 `ok` 结束，info 日志出现"不在循环内"。
6. 断点块配置 `onError.enable + retryTimes` → 不被重试、不判失败（哨兵优先于
   onError 结算）。
7. 连线顺序回归：先连 "end" 后连 "loop" 时循环体仍从 "loop" 分支进入。

### 3.6 文档（`README.md` + `README.zh-CN.md`）

- Workflows 章节新增"失败重试"小节：区分**单块重试**（已有 onError）与
  **整组重试**（本次新增能力），给出登录验证码示例的搭建步骤与要点。
- 提及应急用法（方案 B 手工成环）一段。

## 4. 兼容性

- "end" 未连线的工作流：行为不变。
- "end" 已连线的工作流：以前被忽略、现在会执行——这是对编辑器已展示语义的
  修正，不是破坏；发布说明中提一句即可。
- 循环体入口按句柄取值：只影响"先连 end 后连 loop"这种此前必然错误的图，
  修正方向与用户意图一致。
- 无句柄裸边 + 已连 end 出口的图：裸边不再被当作循环体（有 end 出口时）。
  存量已保存的工作流在加载时经 `migrate.ts` 归一化为标准句柄，不受影响；
  仅未经过迁移的图会受影响（终审 F2）。
- 旧版 `breakpoint` 块（migrate 将其映射为 `loop-breakpoint`）：以前是
  noop，现在会真正跳出所在循环；不在循环内时就地收尾（运行仍为 ok，info
  日志）。发布说明中提一句（终审 F3）。
- 编辑器/引擎参数形状漂移（既有问题，本次只修 repeat-task）：编辑器
  repeat-task 只能编辑 `repeatFor`，引擎已兼容读取 `count ?? repeatFor`；
  while-loop 编辑器写 `conditions` 组、引擎读 `code` 表达式——编辑器搭建的
  while-loop 条件恒为假（0 次迭代，现会走到 end 分支）。该漂移超出本特性
  范围，未在本次修复（终审 F1）。

## 5. 交付物清单

- `src/background/workflow-engine/loop-breakpoint.ts`（新增）
- `src/background/workflow-engine/engine.ts`（end 分支 + 哨兵捕获 + 入口修正）
- `src/background/workflow-engine/executors.ts`（loop-breakpoint 真执行器）
- `tests/workflow-phase4.spec.ts`（新增用例）
- `README.md` / `README.zh-CN.md`（失败重试小节）

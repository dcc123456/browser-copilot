# 批量填表 / Batch form fill — 设计与选型

日期：2026-11-12。范围：对话模式下的 agent 工具面（`semi` / `full` / 无人值守复用同一
`runAgentTurn` 的路径）。**不含**工作流生成模式的算子面（见「不做什么」）。

## 1. 问题：填一个字段要花多少钱

现状（`pnpm` 代码路径逐条核对过，非推测）：

模型每填一个字段就消耗**一个模型轮**，而一个 `fill` 工具调用在页面侧的成本是：

| 步骤               | 位置                                   | 代价                                                                    |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------- |
| actionability 预检 | `driver.ts:571` `waitForActionable`    | 1 次注入轮询                                                            |
| 真正的写           | `driver.ts:604` → `kernel.ts:2427`     | 1 次 `executeScript`（全 frame）                                        |
| 自动观察           | `agent.ts:4851` → `captureObservation` | `waitForPageStable` 轮询 + `snapshotActiveTab(1500, 40)`（又 1 次注入） |
| 观察进历史         | `afterAction` 把整页快照塞进 tool 结果 | 之后**每一轮**都重发这份快照                                            |

即 **N 个字段 = N 个模型轮 + 约 4N 次页面注入 + 逐轮增长的 transcript**。用户的描述
「先看 → 再填 → 再验证 → 下一个」正是这个结构，而且它不是模型的坏习惯，是工具面只给了
单字段写入这一种形状。

已存在的半成品（重要，决定了方案的取舍）：

- `run_plan`（`agent.ts:4027`）已经能在**一个模型轮**里跑最多 16 步，但它内部仍然调用
  `executeTool('fill')`，于是每步各自做一遍完整观察——而 `run_plan` 只解析
  `{ok, error}`（`agent.ts:4076-4082`），**观察结果被整个丢弃**。也就是说批量入口已经
  存在，浪费的是页面侧延迟，且丢弃的观察纯属白花的时间。
- 内核有批量**读**：`read_form`（`kernel.ts:2013`，只回 name→value，没有 ref，模型拿它
  没法操作）；snapshot 的 `forms[]`（`kernel.ts:1578`）**只覆盖有 `<form>` 标签的表单**，
  div 假表单只能从 `elements[]` 里凑。
- 内核**没有任何批量写 op**：`ActionName`（`lib/ops.ts:129`）里没有 fill-many，全仓
  `fill_form` / `fillForm` 零匹配。

## 2. 目标流程

```
form_fields  →  一次拿到整表字段（ref/label/type/required/options/当前值）
fill_form    →  一次注入写完所有字段
（等页面稳定）→ 一次读回所有目标值，逐字段比对
failed[]     →  只把失败的字段交回模型，下一轮只重试这几个
```

10 个字段的成本：**1 个模型轮 + 2 次字段注入 + 1 次观察**，量级上等于今天填 1 个字段。

## 3. 选型与证据（含否决理由）

| 候选                                                  | 结论                         | 理由                                                                                                                                                                                           |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 新增 `fill_form` 工具 + 内核批量 op                | **采用**                     | 唯一能把「N 次注入」真正降成「2 次注入」的形状；写/读回都在一次注入内完成，语义清楚（一次调用=一次表单级操作），审计与历史可按字段落条目。                                                     |
| B. 给现有 `fill` 加 `fields[]` 参数                   | 否决                         | schema 成本略低（约 350 字符），但同一个工具名承载两种入参形状，`describeAction` / `hydrateRecordArgs` / 录制→工作流编译 / 风险分类全都要按形状分支，属于 §5.2 禁止的「同一逻辑第二次出现」。  |
| C. 只优化 `run_plan`（批量步跳过 `afterAction` 观察） | 否决为主方案、保留为后续可做 | 零 payload 成本，且确实该修（现在纯属浪费）。但它修不掉每字段一次 actionability 预检 + 一次注入，页面侧延迟只降一半左右，仍然给不出「整表一次写完、一次校验」的语义。                          |
| 整表读取复用 `snapshot_page`                          | 否决                         | `forms[]` 要求 `<form>` 父节点（`kernel.ts:1579` `safeQuery('form')`），现代 div 表单直接不在里面；而 snapshot 还带整页正文 prose，读字段时纯属 token 浪费。用户明确要「一个专门的列字段读」。 |

用户裁决记录（2026-11-12）：批量写放内核新 op（A）；**只读回比对，不做工具内自动重试**
（失败交回模型）；新增专门的列字段读；范围仅对话模式 agent 工具；**一次任务要写 ≥3 个字段值
就必须用批量工具**（门槛落点见 §4.7）。

### payload 预算（实测，非估计）

`npx vitest run tests/agent-payload-size.spec.ts`：

- 全自动首轮 `system=4570 tools=8061 total=12631`，天花板 `MAX_ADVERTISED_PAYLOAD_CHARS = 12_700` → **只剩 69 字符**。
- 全量目录 `32142`，天花板 `32_300` → 158 字符。
- 工作流首轮 `63697 / 63_700` → **3 字符**。

所以两个新工具必须同时加进 `WORKFLOW_WITHHELD_TOOLS`（`agent.ts:1855`，`fill` 已在其中），
否则工作流天花板立刻爆。加进 withheld 后工作流的三个天花板不受影响；首轮与目录两个天花板
按仓库惯例记录实测数字后上调。比例型护栏（workflow/full）只会因为分母变大而更宽松，无需改动。

## 4. 设计

### 4.1 读：`form_fields`

- 内核 op `form_fields`：`safeQuery('input, select, textarea')`（`safeQuery` 已经穿透
  open shadow root，见 `kernel.ts:389`）→ 过滤 `isVisible`、`type=hidden`、以及不是真正
  可填的控件（`file` 保留并标注，`button`/`submit` 之类剔除）→ 每项产出
  `{ref, label, tag, type?, required?, disabled?, value?, placeholder?, options?}`，
  ref 用与 `buildSnapshot` 相同的 `e${n+1}` 规则，target 用现成的 `targetFor()`。
- `value` 走 `readControlValue`（`kernel.ts:1083`），**password 字段不回值**（与
  `SnapshotElement` 的既有约束一致，`kernel.ts:1555`）。
- background 侧把 ref→target 注册进 `ctx.snapshotTargets`：复用并泛化
  `rememberSnapshotTargets`（`agent.ts:2664`），不新建第二套 ref 表（§5.6）。
- 语义与 `snapshot_page` 一致：**它替换掉上一份快照的 ref**，工具描述里写明。

### 4.2 写：`fill_form`

工具入参（尽量瘦，模型只需 ref + 值）：

```jsonc
{
  "fields": [
    { "ref": "e3", "value": "张三" },
    { "ref": "e7", "value": "杭州" },
  ],
}
```

- **不要求模型声明 kind**：内核按元素实际类型分派——`HTMLSelectElement` → 选择逻辑，
  `input[type=checkbox|radio]` → 勾选逻辑，`input/textarea` → 文本逻辑。这样
  `select_option` / `set_checkbox` 两个 schema 的副本成本一分都不用花。
- `value` 允许 `string | boolean | string[]`（多选）。
- 字段数上限 40（与 `SNAPSHOT_ELEMENT_LIMIT` 同量级），超限直接拒绝并说明拆分。
- 实现约束（§5.2 / §5.6）：把 `kernel.ts` 现有 `fill`（2427）、`select_option`（2472）、
  `set_checkbox`（2522）三个分支的**写入体**抽成 `runOp` 内的嵌套 helper
  （内核只能有 `runOp`/`runExecJs`/`runWorkflowJs` 三个导出，且函数体内不得引用模块作用域，
  见 `lib/ops.ts:4-7` 与 `pnpm verify:injected`），单字段 op 与批量 op 共用同一份实现。
  **禁止**复制一份批量写入逻辑。
- 单字段失败不影响其它字段：每项产出 `{i, ok, error?}`，整体 `ok = 全部成功`。

### 4.3 校验：读回比对（不自动重试）

写入完**不能**在同一次注入里读回判定成败：React 受控组件的重渲染是异步的，同步读回对
「写进去又被组件清空」只会给出虚假成功。所以：

1. `fill_form` op（1 次注入，同步写，不做读回）
2. `waitForPageStable`（`agent.ts:4718`，复用）
3. `verify_fields` op（1 次注入）：按**同一批 durable target** 重新解析，并在**页内**比对，
   只回传判定 `{i, ok, kind, secret?, error?, expected?, actual?}`。用 target 而不是 ref
   读回，是因为第 2 步之后页面可能已经增删节点、重新编号——ref 对齐会给出假失败。
   比对放页内而不是 background：password 的原文因此永远不进 transcript / 审计 / 确认卡，
   且 `<select>` 可以直接用选中项的可见文案比对（模型常传 label、页面存 value）。
4. background 汇总，产出 `filled: n / failed: [{i, ref, label, stage, error, expected, actual}]`，
   最后附**一份**观察（与今天的单字段 `fill` 同价）。

比对规则（`src/inpage/kernel.ts` 的 `fieldMatchesWanted`；未单独建 `lib/form-fill.ts`——
比对必须与写入同处注入上下文，抽成 chrome-free 模块反而无法被内核调用，单测由
`tests/kernel-fill-form.spec.ts` 在 jsdom 里覆盖）：

| 控件             | 判等                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| 文本/textarea    | 两端折叠空白后相等                                                    |
| select           | 回读 `value` ∈ 期望，**或** 回读可见文案 ∈ 期望（模型常传可见 label） |
| 多选 select      | 期望集合逐项按 value / 可见文案匹配（`every`，缺一个即失败）          |
| checkbox / radio | 布尔相等（`checked === (value === true \|\| 'true')`）                |
| password         | 同上按文本比对，但只回传长度（`N chars (hidden)`），原文不出页        |

宁可**误报失败**（多花一轮重试）也不放过静默漏填——静默空字段是用户投诉的源头。

### 4.4 边界（明确报给模型的拒绝，不静默）

- **contenteditable / 富文本**：批量侧拒绝并提示改用 `fill`。原因：`fill` 对 DraftJS 这类
  有状态编辑器有 CDP 逐键升级路径（`driver.ts:687`+，依赖 `data.registered === false`），
  批量 op 拿不到这条通道；且逐键打字是异步长任务，多个富文本字段会撞
  `OP_INJECTION_TIMEOUT_MS = 30_000`（`driver.ts:364`）。富文本字段退回单填是可接受的
  退化，不是失败。
- **closed shadow root 内的控件**：批量没有 `op.target`，走不到 CDP 坐标通道；这类 target
  在内核里本来就不可解析（`kernel.ts` 的 `resolveSpec` 对 `cdp-shadow` / `closedShadow`
  直接返回空），所以按字段报「解析不到」，模型退回单字段 `fill` 才有 CDP 路径。
- **file input**：扩展本来就填不了，`writeTextControl` 照抄单字段 `fill` 的同一句文案
  （「File inputs cannot be filled by an extension.」），不另写一套。
- **跨 frame**：op 仍然 `allFrames: true`，每个 frame 只报告自己解析到的字段；合并沿用
  driver 既有的最佳 frame 排名（`driver.ts:683`，`found`+`ok`+`isTopFrame` 打分），**没有**
  新增 `mergeFieldResults()`——批量结果按 `(found, ok)` 计分后，赢家恰好是「写进最多字段
  的那个 frame」，与单 target 的行为一致，再造一套合并属于 §5.2 禁止的第二次复制。
  代价：字段分散在多个 frame 时只有最佳 frame 的批次可见，其余字段由模型退回单字段 `fill`。
- **stale ref**：与 `resolveTargetFrom`（`agent.ts:2629`）同样的文案，但按字段粒度报告，
  并把「整批都失效」直接升级成「请重新 `form_fields`」。

### 4.5 门控与登记（一处不漏）

| 登记点         | 位置                                                                      | `form_fields`      | `fill_form`                                                       |
| -------------- | ------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| 工具 schema    | `agent.ts` `TOOLS`                                                        | 新增               | 新增                                                              |
| 只读模式可见   | `READ_TOOLS` / `ACTION_TOOLS`（`agent.ts:222,249`）                       | 进 READ            | 进 ACTION（readonly 自动隐藏）                                    |
| 工作流模式屏蔽 | `WORKFLOW_WITHHELD_TOOLS:1855`                                            | ✅                 | ✅                                                                |
| 半自动风险判定 | `lib/action-risk.ts:153`                                                  | 无需（读）         | 仿 `run_plan`：遍历 fields，任一命中 CREDENTIALS/PAYMENT 即 risky |
| 计划门         | 经 `isPageAction`                                                         | 否                 | 是（随 ACTION_TOOLS 自然生效）                                    |
| 审计/历史 chip | `describeAction` / `describeDetail`                                       | 加 case            | 加 case                                                           |
| 设置页可关     | `lib/tool-catalog.ts` + i18n label/warning（en+zh，封闭 `Messages` 机检） | ✅                 | ✅                                                                |
| 内核版本       | `inpage/kernel-version.ts` `KERNEL_VERSION 5 → 6`                         | ✅（新增 op 词汇） | ✅                                                                |
| server 镜像    | `server/src/driver.ts` 按 `op.action` 分发，非穷举 switch；内核两侧共用   | 无需改             | 无需改（记录于此，避免被当作漏改）                                |

### 4.6 历史记录：批量调用落 N 条单字段动作

`run_plan` 已经立了这个先例（`agent.ts:4086` 内部逐步 `recordAction`）。批量填表同样
**按字段**各记一条 `fill` / `select_option` / `set_checkbox`，args 用 hydrate 后的
durable target：这样「从历史生成工作流」与 AI 预填（`lib/workflow/ai-prefill.ts`，靠
`blockId:'forms'` + `generated` 判定）完全不受影响。工具级 `generated` 布尔照抄 `fill` 的
语义并广播到每条记录。

### 4.7 触发门槛：一次任务要写 ≥3 个字段就必走批量（裁决 2026-11-12 补充）

「一个页面有 3 个字段」不等于「这次要写 3 个字段」，所以门槛**不能**由代码判定：
用户只要改一个手机号时，页面上有 20 个字段也该单字段 `fill`。「本次要写几个值」只有模型
自己知道，因此门槛只写在**模型做选择的那一刻能看到的地方**——四个工具描述：

- `fill_form`：`Use it for 3+ field values;`
- `form_fields`：`When the task needs 3+ values, call it first, then write them all with one fill_form;`
- `fill`：删掉原来的 `Preferred for ALL text entry`（这句是反向激励：它明确把模型推回逐字段
  填写），改成 `Type text into ONE input/textarea/contenteditable … For 3+ values use fill_form.`
- `select_option` / `set_checkbox`：各加一句 `For 3+ values use fill_form.` 混合表单
  （两个文本 + 一个下拉 + 一个勾选）正是「≥3 个值」的典型形态，少了这句就退化成 4 次调用。

共享 prompt 的规则 13 不再重复这个门槛（`lib/system-prompt.ts` 文件头的约定：同一条规则不在
两处解释；且 prompt 每轮全量重发，规则文字会同时顶高工作流的三个天花板）。
实测代价：首轮 `14_203 → 14_210`（天花板 14_250；`select_option` / `set_checkbox` 在按需
`forms` 组里，不进首轮菜单），全量目录 `33_702 → 33_800`（实测 33_767，按仓库惯例记录实测后
上调），工作流首轮 `63_709 / 63_750` 不变。
门槛文字由 `tests/agent-fill-form.spec.ts` 的 `batch threshold in the advertised schemas`
锁住——这段文字本身就是行为，被改回去不会有任何测试变红，所以必须有断言。

## 5. 不做什么（本次切片）

- **工作流侧的批量填表算子**：涉及 block 目录、编辑器 UI、双端 executor、history 编译与
  两侧 i18n，用户已明确排除在本次范围外。工作流生成模式继续用逐字段 `wf_op_forms`。
- **工具内自动重试**：按裁决只做读回比对，失败交回模型下一轮。
- **`run_plan` 丢弃观察结果的浪费**：本次不修（不同主题，另开一轮）。
- **server 无头 agent 的工具面**：不加 `fill_form`，内核能力两侧共用即可。

## 6. 验收

自动门禁：`pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm build`；
新增/改动的 `executeScript({func})` 内联函数体：`pnpm verify:injected`（不在 CI，手跑）。

新增测试：`tests/kernel-fill-form.spec.ts`（`form_fields` 列字段 + `fill_form` 批量写 +
`verify_fields` 页内比对，含 password 不回传原文）、
`tests/agent-fill-form.spec.ts`（ref 解析、一次写注入 + 一次读回注入、逐字段失败与 stage、
逐字段历史记录、未知 ref 不碰页面）、`tests/confirm.spec.ts` 的
`fill_form inherits the risk of its fields`（批量继承最危险字段的风险），并更新
`tests/agent-payload-size.spec.ts` 的实测天花板。

人工怎么测（真实 Chrome，unpacked 扩展）：

1. 打开一个普通多字段表单页（例如某注册页 / 后台新建表单，≥5 个字段，含 1 个下拉）。
2. 切到「全自动」模式，输入「把这个表单按 <数据> 填好，先不要提交」。
3. 预期现象：侧栏工具流水里出现**一次** `form_fields`，随后**一次** `fill_form`
   （而不是逐条 `fill`），面板上整表在极短时间内一次性出现全部值。
4. 故意给一个不存在的下拉选项值，预期 `fill_form` 结果里该字段进 `failed` 并带
   `expected/actual`，其余字段仍在页面上；模型下一轮只重试该字段。
5. 富文本字段（如存在）预期在 `failed`/`note` 里看到「改用 fill」的明确提示，而不是静默跳过。
6. 保存为工作流：预期历史里是 N 条单字段表单动作（不是 1 条未知工具），AI 预填勾选列表照常出现。

浏览器实证若拿不到，按 §8.6 标 BLOCKED 并写明原因。

## 7. 浏览器实证（已拿到）

上面的 1–6 步没有靠侧栏手工点，而是用一次性 spike 在真实 Chrome 里跑通了同一条链路
（spike 只留在 `tmp/`，不入主干，遵循 §7.3）：headless Chromium + `--load-extension=dist`
（unpacked 新构建）+ 本地 http fixture 页面，fixture 是**真 React 19 受控组件**
（`esm.sh/react@19.2.8`），op 通过与 driver 完全相同的常驻内核跳板注入
（`globalThis.__browserCopilotKernel` + `__browserCopilotKernelVersion === 6`）。
12 条断言全绿（`tmp/batch-fill-probe.mjs`，2026-11-12）：

| 断言                                    | 观察到的事实                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `form_fields` 一次列出 6 个控件         | `note: "6 fillable fields"`，`submit` 按钮不列出；无 `<form>` 标签的 React 渲染同样能列                                         |
| password 只列字段不列内容               | `type: "password"`，`value` 缺席                                                                                                |
| 一次注入写完整个批量                    | `note: "6/6 fields written"`，results 里 kind 分别为 text/select/checkbox/text                                                  |
| **写进的是 React 的 state，不只是 DOM** | 页内 `window.__state()` 回读：`name/bio/plan/agree/pw` 全部为期望值（`plan` 存的是 `pro_1`）                                    |
| 「写进去又被组件清空」不放过            | 受控组件把非白名单值在下一次 render 清成 `''`，`verify_fields` 报 `expected "Shanghai" / actual ""`，note `5/6 fields verified` |
| select 按模型传的 label 判等            | 页面存 `pro_1`、调用传 `"Pro"` → `ok: true`                                                                                     |
| password 原文不出页                     | 判定项只带 `secret: true`，整包结果里搜不到 `hunter2`                                                                           |
| 失败字段可单独重试                      | 用允许值重试同一字段：`1/1 fields written` → `1/1 fields verified`，state 变成 `Nanjing`                                        |

注入次数实测：6 字段表单 **4 次**（列字段 / 批量写 / 读回比对 / 单字段重试）；
旧流程按字段「填+看」要 12 次以上注入外加同等轮次。

未取证项：**侧栏 UI 与工具流水显示**（`form_fields` / `fill_form` 两个 chip、半自动确认卡、
历史记录里落 N 条单字段动作）——这些要真实 LLM 轮次才能触发，本次只由
`tests/agent-fill-form.spec.ts` 与 `tests/confirm.spec.ts` 离线锁定，人工验证请按上面 1–6 步。

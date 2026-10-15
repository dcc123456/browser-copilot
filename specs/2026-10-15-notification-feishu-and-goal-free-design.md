# 通知算子：飞书通道 + 免目标契约 · Notification block: Feishu channel and no goal contract — design

日期 / Date: 2026-10-15
涉及模块 / Areas: `lib`（workflow/operator-registry、workflow/node-goal-instantiation、feishu）、`background`（workflow-engine/executors、workflow-engine/engine、goal-verification）、`workflow-editor`（blocks/catalog、blocks/batchD/EditNotification、sidebar/BlockEditForm、i18n）、`runner`（server/src/executors）

关联计划 / Plan: `specs/2026-10-15-notification-feishu-and-goal-free-plan.md`

## 1. 需求原文 · Requested behaviour

dcc 的命题：**通知算子节点需要支持勾选飞书通知，并且通知算子不需要有目标和成功条件。**

两点分别对应两个真实痛点：

- 通知算子目前只会调 `chrome.notifications` 弹一次桌面通知（`src/background/workflow-engine/executors.ts:1837-1851`），跑在工作流里的"通知"到不了人手上——桌面通知会被忽略，而定时任务那条链路早就有飞书 webhook 出口（`src/background/task-runner.ts:436-467`）。算子层缺一个勾选开关。
- 编辑器给**每一个**算子都挂上「目标与成功条件」区（`src/workflow-editor/sidebar/BlockEditForm.tsx:175-179`），通知/Webhook/导出这类"动作做完就结束"的算子没有页面状态可验收：它没有定位器，成功条件只能靠模型编，编出来的行反过来卡认证（本项目已知的"the one row left barring certification"失效形态）。

裁定（AskUserQuestion，2026-10-14/15，已定，不再讨论）：

| 项       | 决定                                                                  |
| -------- | --------------------------------------------------------------------- |
| 飞书失败 | **只记警告，节点保持成功**（与 `task-runner.notifyOutcome` 同一口径） |
| AI 修复  | 无目标算子的「AI 修复」入口**一并隐藏**（修复引擎硬要求目标契约）     |
| 豁免范围 | **notification + webhook + export-data**（"外部副作用/输出型"这一类） |

## 2. 现状取证 · Evidence about the current code

以下均由代码位置支撑（改动前的行为），不是推测。

- **节点目标契约的唯一产生处**是 `resolveNodeGoalContract`（`src/lib/workflow/node-goal-instantiation.ts:109-149`）：① 模型自带的契约优先（`:112-113`）；② 算子注册表的 `buildGoalContract`（`:119-122`）；③ 否则用 `DEFAULT_GOAL_TEMPLATES[blockId]`（`:44` 有 `notification: 'Show a desktop notification'`）套一句话，再用 `fallbackCriteria`（`:151-200`）凑成功条件——`variableName` → 变量存在，定位器 → 元素存在，两者都没有 → `[]` → `:140` 直接返回 `undefined`。
  推论：notification / webhook **今天已经拿不到契约**（无 `variableName`、无定位器），但编辑器仍然把目标区摊给用户填；export-data 在 `dataToExport:'variable'` 时会拿到一条真实的「变量存在」行。
- **契约缺失在各消费方都是干净跳过**，没有一处硬要求（除 AI 修复）：`engine.ts:762-763` `if (!contract) return`；`goal-verification.ts:172,176` `if (contract)`；`BlockNode.tsx:209` 徽标 `{nodeGoal && …}`；`reliability.ts:421` `intentOf` 回落空串；`workflow-health.ts` 完全不读契约；`save-gate.ts:131-141` 只看工作流级 `goalSpec`。
- **生成校验的判定与产生用的是同一个函数**：`generated-validation.ts:530` 的 `NODE_GOAL_MISSING` 只在 `resolveNodeGoalContract(blockId, params, undefined) !== undefined` 时要求该行。因此"不再自动编造"与"不再要求"天然一致，不需要另开豁免清单。
- **工作流级 goal 的派生不走节点契约**：`deriveGoalSpecFromNodes`（`src/lib/workflow/goal.ts:58-82`）读的是 `nodeReliabilityOf` 的 `postconditions`（`reliability.ts:202-217`，独立于契约）。去掉契约不会影响 `settings.goalSpec` 的派生与不可逆动作门禁。
- **AI 修复硬依赖契约**：`NodeFixModal.tsx:273` `hasContract = !!nodeGoalContractOf(data)`，缺契约时 `node-fix-engine.ts:188-195` 直接 `success:false` 并回"请先填写目标"。若只藏目标区不藏按钮，点下去就是死路。
- **注册表没有"是否携带目标"的表达位**：`OperatorRegistryEntry`（`operator-registry.ts:41-70`）只有 `allowGeneration` / `sideEffect` / `buildGoalContract?`；`notification`、`webhook`、`export-data` 都不在 `OVERRIDES`（`:82-252`）。今天唯一能让算子不产生目标的路径是"没有模板且 `fallbackCriteria` 返回空"，属于巧合而非声明。
- **飞书出口是现成的、且 chrome-free**：`sendWebhookText(webhookUrl, text, secret='')`（`src/lib/feishu.ts:113-148`）纯 `fetch`，URL 非法或 HTTP/`code` 非 0 一律 **throw `FeishuError`**，成功返回 `{ok:true,status,body}`；配置读 `getFeishuConfig()`（`src/lib/task-store.ts:471-474` → `{webhookUrl,webhookSecret,…}`）。注意该配置在扩展侧存 `chrome.storage.local`（`fs-store.ts:106-113`），Node Runner 里读到空对象，Runner 自己那份在 `config.feishu`（`server/src/config.ts:55,68`）。
- **两个宿主的 notification 执行器是两份实现**：扩展 `executors.ts:1837` 走 `chrome.notifications`；Runner `server/src/executors.ts:1087-1093` 是刻意的 log-only（无桌面通知能力），二者同处 `createExecutors` 工厂作用域，Runner 侧 `config` 在 lexical scope 里（`:366`）。

## 3. 设计 · Design

### 3.1 目标契约：新增"是否携带目标"这一位，而不是加黑名单

在 `OperatorRegistryEntry` 加 `goalBearing: boolean`（派生默认 `true`），`OVERRIDES` 给 `notification` / `webhook` / `export-data` 置 `false`，并导出 `operatorCarriesGoal(id)` 供编辑器与校验复用。理由：豁免清单必须和算子分类同源，否则编辑器一份、注册表一份，第三处再来一份就违反 AGENTS.md §5.6。

`resolveNodeGoalContract` 的改动只有一处语义：**注册表说该算子不携带目标时，不再"编造"契约**（②③ 路径短路），但**模型自带契约仍然优先**（① 保持不变）。这样 export-data 在 `dataToExport:'variable'` 时那条真实的「变量存在」证据不会被丢弃——丢证据比多条空目标危险得多（见 §2 关于 certification 的失效形态）。

`DEFAULT_GOAL_TEMPLATES` 里这三个 id **保留**：该表还被 `trial-run.ts:539` 的 `isGenericStepProse` 用来识别"套话步骤"，删掉会让套话检测失效。

运行时对**历史数据**里已经存在的契约不做追溯清理：编辑器不再展示目标区（`BlockEditForm` 用同一谓词），但 `engine.ts` / `goal-verification.ts` 仍按既有契约验收——那是用户或模型当初真实写下的断言，静默失效比保留更糟。新录制/新生成的节点不再自动带上。

### 3.2 飞书通道：一个布尔开关，失败只报警

- 数据：`notification` 块 `data` 新增 `notifyFeishu: false`（`catalog.ts:1409-1416`）。不进 `refDataKeys`——它是开关，不是可插值文本。
- 表单：`EditNotification` 在 Message 之后加一个 `Checkbox`「Send to Feishu」，按现有约定 `bool(data,'notifyFeishu')` 读、`onChange({ notifyFeishu: v })` 写。
- 执行（扩展宿主）：桌面通知逻辑不动（失败仍抛，见 `:1841-1845` 的注释）；其后若 `notifyFeishu`，读 `getFeishuConfig()`：未配置 webhook → `ctx.emit('error', …)`；已配置 → `sendWebhookText(url, title+"\n"+body, secret)`，`try/catch` 后失败同样 `ctx.emit('error', …)`。**两条都不 throw**（按裁定）：`emit('error')` 在本项目语义里就是"可见但不判失败"，`task-runner.ts:455-466` 是同一口径。正文用已经 interpolate 过的 title/body。
- 执行（Runner 宿主）：镜像同一条规则，用 `config.feishu.webhookUrl/webhookSecret`，失败同样只 `ctx.emit('error', …)`。§5.6 要求驱动镜像双侧同步，算子行为同理——一个只在扩展里生效的开关会让人以为工作流发了飞书。
- 复用优先：发送走 `src/lib/feishu.ts` 既有 `sendWebhookText`，不新造第二套 HTTP 签名/发送逻辑。

## 4. 不做 · Out of scope

- 不改 `settings.notification`（工作流级"完成时通知"，`storage.ts:116`），它与算子无关且当前无消费方。
- 不给通知算子加"通知对象/收件人"字段：飞书侧的收件人就是配置里的 webhook 群，本项目没有 IM 联系人体系。
- 不动 upload-file 的既有豁免（它是"只选定位器和文件"的特殊表单，不是"无目标"类算子）。
- 不改 block 的 en/zh 描述文案（`catalog.ts:1399` / `block-i18n.ts:143`），勾选框自带说明，避免动到 catalog 快照断言。

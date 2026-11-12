# 移除「运行期接管 / 自动修复」两个开关

日期：2026-11-12 · 主题：用户要求删除模型设置页底部「AI 接管模型（AI 调试）」配置；经在场澄清后确定范围为**只删两个开关，保留模型选择器**

## 1. 前提校正（为什么不是整卡删除）

用户原话是「AI 修复功能已经删除了，这个配置也不需要了」。实测不成立：`465cbc4` 只删了工作流卡片上的修复按钮（`WorkflowsTab.tsx` −42 行），修复/接管引擎仍是活的——`workflows.debug` 仍被 `ChatTab.tsx:3431/:3491` 调用，`workflows.repair` / `workflows.autoRepair` 仍是 MCP `repair_workflow` 的通路，二者都用 `takeoverProviderOf(settings)` 取模型。

因此 `Settings.takeoverModel`（卡片里的 provider/model 选择器）**不能删**：它是「把看图干活的模型与聊天模型分开」的唯一入口，也是 §7.4 调试成功率口径的取值来源。本次只删同卡片里那两个默认关闭、触发面极窄的开关：

- `settings.takeoverOnRun` — 只影响「面板手动运行」这一条路（`index.ts:2148-2151` 的注释明说该 gate 仅在用户发起的运行上）。
- `settings.autoRepairOnRun` — 只在「由生成流程产出的工作流手动跑失败」时触发后台修复。

两者默认均为 `false`（`storage.ts:130-131`、`providers.ts:733-734`），即今天绝大多数用户的实际行为就是「关」。删掉的等价物是：手动运行不再可能挂一次自动接管、也不再可能在后台自动进修复循环；调试会话、失败中心手动修复、MCP 修复、生成桥自测链路全部不受影响。

## 2. 全量引用盘点

命中源码 8 个文件 + 测试 6 个 + 文档 4 处。`server/`、`website/`、`release-notes/`、README **无命中**。

| 文件                                                         | 作用                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `src/lib/types.ts:238-249`                                   | 两个字段 + JSDoc                                                                                                    |
| `src/lib/storage.ts:130-131,295-296`                         | 默认值 + 白名单归一化                                                                                               |
| `src/lib/providers.ts:628-629,733-734`                       | 载荷类型 + 归一化                                                                                                   |
| `src/lib/i18n.ts`                                            | `settingsTakeoverOnRun(Intro)`、`settingsAutoRepairOnRun(Intro)` × 3 处（interface / en / zh-CN）                   |
| `src/sidepanel/ModelsTab.tsx:1050-1072`                      | 两个 `Switch` 块 + 两条 hint；删后该文件 `Switch` import 失去唯一用途                                               |
| `src/background/index.ts:2153-2179,2188,2196-2234,2243,2325` | `workflows.run` 里的接管构造、`aiTakeover` 透传、自动修复分支、`!repairStarted` 守卫、`autoRepaired: repairStarted` |
| `src/lib/workflow/ai-takeover.ts:58-72`                      | `takeoverAutoRunBudget()`（唯一调用点是 `index.ts:2167`）                                                           |
| `src/background/workflow-generation-bridge.ts:711`           | 注释把修复编排器描述成「在 `settings.autoRepairOnRun` 之后」，需改写                                                |

### 连带清单（删完必然变死的东西）

- `takeoverAutoRunBudget` 与 `BC_TAKEOVER_AUTORUN_BUDGET`：只服务被删的那次接管预算 → 按 §5.4 连导出带 `index.ts:221` import 一起删；`docs/ai-debug-success-rate-v3.md:156` 的 M1-10(c) 行同步注明该预算随开关移除。
- `isGeneratedStrict` 在 `index.ts` 内只出现在 `generatedRun`（:2203）→ 连 import（:284）一起删；该函数本身在别处仍有用，模块保留。
- `const settings = await getSettings()`（:2157）在本 case 内只服务两个分支 → 删。

### 刻意保留

| 保留项                                                                                                                                                            | 理由                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReplayFirstRunRecord.autoRepaired` + `replay-metrics.ts:289` + `WorkflowHealthView.tsx:82`                                                                       | 历史运行记录里已经存过 `true`，这两个读取点仍要能解释旧数据；本次只是新运行不再写该字段（调用点省略可选入参）。删掉会让健康视图对既有记录读数失真。                                                                          |
| `WorkflowSettings.takeoverOnRun`（`src/lib/workflow/types.ts:264`、`workflow/storage.ts:187-188`）                                                                | 那是工作流记录里的一份**独立持久化镜像**，走 §5.7 的 shape 白名单，现存工作流 JSON 里带着这个键；它与全局设置无读写关系，本次不动。                                                                                          |
| `takeoverModel` 卡片（provider/model 选择器、`settingsTakeoverModel*` 文案）                                                                                      | 见 §1，仍是 `workflows.debug` / `workflows.repair` / 生成桥 / `agent-api` 的模型来源。                                                                                                                                       |
| 历史文档 `docs/ai-debug-success-rate-plan.md:183`（G5-11 行）、`specs/2026-10-19-*:31`、`specs/2026-10-26-*:32`、`specs/2026-10-20-*:21`、CHANGELOG/release-notes | 它们是当时的记录，不是现状说明书；改写会把删除痕迹抹平。只在口径文档 `docs/ai-debug-success-rate-v3.md`（§7.4 唯一事实源）追加更新日期注记，并在 `docs/workflow-ai-architecture-audit.md` 的「手动运行」行标注该分支已移除。 |

被否决的候选：

| 候选                                     | 否决理由                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整卡删除（连模型选择器）                 | 会让调试/修复静默退回聊天模型，直接压低需要视觉模型的调试成功率；用户要删的是配置入口，不是能力。                                                                                         |
| 只删模型选择器、留两个开关               | 与用户意图相反：两个开关才是默认关闭、几乎无人使用的部分。                                                                                                                                |
| 连 AI 接管/修复引擎一起删                | 涉及 `workflows.debug`、`workflows.repair`、MCP `repair_workflow`、`bench:debug` 基线与 `src/lib/workflow/ai-takeover.ts`，属按天计的大工程，且会破坏 selftest 链路；需要单独设计与取证。 |
| 保留死代码（`takeoverAutoRunBudget` 等） | §5.4 明确禁止留未被调用的导出。                                                                                                                                                           |

## 3. 验收

- ① `pnpm typecheck` ✅、`TZ=UTC pnpm test` = **5951 passed / 7 failed**、`pnpm build` ✅、`eslint`（本次 14 个改动文件）✅、`prettier --write` 后 `--check` ✅。7 个失败是 main 自 `9839fe8` 起的既有 ratchet 红项（`agent-payload-size` ×4、`skills` ×2、`operator-param-coverage` ×1），已在干净 HEAD worktree 里复现同数值，本主题**未新增失败**；测试总数 5961 → 5958 是删除 `takeoverAutoRunBudget` 的 3 个用例。
- ② 未改 Runner 侧（`server/` 无命中），不适用。
- ③ 动了 `src/lib/workflow/ai-takeover.ts`：BLOCKED，本机 `pnpm bench:debug` 需要真实 Chrome + 模型额度，未跑。判断依据：只删除了 `takeoverAutoRunBudget()`，它在删除前唯一的调用点就是本次移除的接管分支（`index.ts:2167`），接管/调试判定路径与 `takeoverMaxAttempts()` / `takeoverToolRounds()` 一行未动，成功率口径不可能变化。
- ⑤ 浏览器实证 ✅（Playwright + Chrome for Testing 加载 `dist/`，`tmp/probe-models-tab.mjs`，截图 `tmp/models-tab-after.png` / `tmp/models-tab-dialog.png`）：
  - 更多 ▾ →「模型设置」页，标题为「AI 接管模型（AI 调试）」的卡片内 `[role=switch]` 计数 = **0**，卡片文本只剩说明 + 「当前：自动（使用当前对话模型）」+ 一个「修改…」按钮（原先的两个开关与其 hint 全部消失）。
  - 「修改…」弹窗照常打开：2 个 `select`（模型提供商 / 模型）、「获取模型列表」「取消」「保存」三个按钮，弹窗内开关计数 = 0。
  - 注：同一次读取里 `panelSwitches` = 4 属于其他仍然挂载的面板（App 用 `display:none` 保留各 tab），不是这张卡片。
- ⑥⑦ 收尾检索：`takeoverOnRun|autoRepairOnRun|takeoverAutoRunBudget` 在 `src/lib/{types,storage,providers}.ts`、`src/sidepanel/`、`src/background/index.ts`、`src/lib/workflow/ai-takeover.ts` 与全部测试里归零，仅剩 §2「刻意保留」列出的 `WorkflowSettings` 镜像与历史文档；无未调用导出（`Switch`、`isGeneratedStrict`、`takeoverAutoRunBudget` 三个 import 同步删除）。
- ⑧ 只删文案：4 个 key × 3 处移除，`settingsTakeoverModelIntro` 两侧仍成立（实测渲染见 ⑤）。
- ⑨⑩⑪⑫ 探针与截图只留在 `tmp/`；英文 Conventional Commit 单独提交推送 `main`；交付说明见对话。

# 检索式种子生成 · Retrieval-seeded generation — plan

日期 / Date: 2026-10-14
设计 / Design: `specs/2026-10-14-workflow-seed-recall-design.md`
批准来源 / Approved: `~/.qoder-cn/plans/tranquil-delta-linnet.md`

## 0. 目标 · Goals

| #   | 目标                                                            | 判定口径（不自造，见设计 §7）                                               |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| G1  | 生成前召回**已验证**的历史工作流，把步骤证据作为 offer 交给模型 | E1–E4 + Round B 观察到 `seededFrom` 非空                                    |
| G2  | "是否被种子化"成为可归因维度，能回答"有没有推动 fresh-gen L3"   | `settings.seededFrom × certificationStatus` 落进 `tmp/selftest-report.json` |
| G3  | 降级路径逐字节等于今天的行为                                    | 无候选时 prepare 返回 deep-equal 今天的形状，既有测试零修改通过             |
| G4  | 不稀释"只有执行成功过的一步才进图"这条硬不变量                  | 新增路径零 `appendOperatorNode` 调用；E6 桩驱动验证                         |

非目标：embedding 检索、新增 MCP 工具、生成期修复的确定性纠偏（另立一片）、修 `asPersistedDraft` 既有丢字段缺陷、Runner 镜像（`server/src/**` 零生成路径代码）。

## 1. 前置冒烟（先证伪，再写产品代码）

| 假设                                                      | 手段                                                                                                                                                       | 状态                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 冷启动：真实 profile 里存在 certified 工作流           | 全目录 `grep -a certified` + 明文对照组                                                                                                                    | **已证伪（真没有）** → Round A 定为 bootstrap，属上线流程而非缺陷                                                                                                                                                                                                                                  |
| A3 排序表：双语词面能把真命中顶过门槛、把跨站噪声挡在门外 | 先建 fixture 再接线，人工读排序表（6 条候选 × 3 条近邻 goal）                                                                                              | **已过，但改了两处**：Jaccard 换成 goal 侧覆盖率（`lexiconMax` 0.25→0.35、`MIN_SHARED_TOKENS=3`），跨站冲突从"靠门槛"升级为资格否决。表留在 `tests/seed-recall.spec.ts` 的 `ranking table (A3 falsification)`，4 行断言按名字锁顺序；0.60 纯文本门槛**保持不降**，实测其含义是"近乎逐字复述才召回" |
| A2 模型是否真会用 offer（inline selector 可脱快照执行）   | **零产品代码**：按 `src/background/index.ts:3192-3206` 既有 prepend 先例手工把一份 `seeds` JSON 贴进用户消息，看 chat 模式 `wf_op_*` 是否复用种子 selector | **未证，需真实浏览器 + provider，由 dcc 跑**（Round B 即该证据）；未过则只改措辞不改机器                                                                                                                                                                                                           |

## 2. 实施步骤

> 落地状态（实现后回填）：1–7 已完成并过 `pnpm typecheck`；步骤 8 的离线部分（收尾门禁）在跑，
> 真实浏览器 Round A / Round B 待 dcc。与设计文档的两处偏差已写进 design §4.1/§4.2（词面度量、
> 定位器资格、跨站否决、按步截断），没有静默改动。

1. 设计与计划文档（本两份）
2. `src/lib/workflow/seed-recall.ts`：`rankWorkflowSeeds` + `buildSeedOffer` + `tests/seed-recall.spec.ts`
   （先写夹具与断言，人工读排序表 = A3）
3. `src/lib/workflow/workflow-health.ts`：导出 `newestCountedRunOf(runs, workflowId)`，
   `summarizeWorkflowHealth` 与 `seed-recall` 共用（Step 2 之后确认真的用到两处才抽）
4. `WorkflowDraft.seededFrom` / `WorkflowSettings.seededFrom` + 两个白名单（`draft-storage.ts:93-119`、
   `storage.ts:112-168`）+ 往返测试
5. `src/background/agent.ts:4304-4321` 注入缝：`seeds` + `note` 追加 + 独立 try/catch + 写 `draft.seededFrom`
6. compose 侧（`src/background/operator-tool-handler.ts:652-768`）写 `settings.seededFrom` + prepend
   `SEED_RECALL` 阶段；`generation-report.ts` 阶段 id/order；`GenerationStages.tsx` label；`i18n.ts` 双语 key
7. `workflow-generation-bridge.ts:850` 摘要加 `seededFrom`；`tests/acceptance-seed-recall-v93.spec.ts`
8. 收尾自检（§3）+ 双层取证（Round A / Round B）

## 3. 逐项验收列表 · Acceptance checklist

### A. 门禁（机检，必须贴命令与输出）

- [x] A1 `pnpm typecheck` 绿（含 `tsconfig.tests.json`） — `tsc --noEmit && tsc --noEmit -p tsconfig.tests.json` 无输出
- [x] A2 `pnpm test` 全量绿（沙箱对单次长跑有 SIGTERM 限制，分批跑，贴各批输出） — 356 files / 4092 tests passed
- [x] A3 `pnpm lint` 0 error、`pnpm format:check` 绿 — `npx eslint $(changed)` 0 problem；`npx prettier --check $(changed)` 全绿（`pnpm lint`/`format:check` 全仓仍因**未跟踪**的 `tmp/**`、`server/data/**` 红，与改动无关，见 memory『Lint/format baseline』）
- [x] A4 `pnpm build` 绿（动了 `src/sidepanel/`） — `✓ built in 2.33s`
- [x] A5 Runner 侧 N/A（`server/**` 无改动；若 `server/tsconfig.json` 白名单被触碰则补 `pnpm server:typecheck` + `pnpm server:test`） — 已核对：`git status` 无 `server/**` 改动
- [x] A6 `bench:debug` N/A（未改 `src/lib/workflow/ai-takeover.ts` 与 `src/background/workflow-engine/**`） — 已核对：`ai-takeover.ts` 与 `workflow-engine/**` 无改动
- [x] A7 `pnpm verify:injected` N/A（未新增/修改 `executeScript({func})` 内联函数体） — 已核对：diff 里 `executeScript` 0 处

### B. 不变量与回归

- [x] B1 无候选时 `prepare_workflow_goal` 返回 JSON **deep-equal 今天的形状**（`seeds` 键缺席、`note` 逐字节相同），断言 prepare 返回的既有测试**一条都不改**即通过 — `tests/acceptance-seed-recall-v93.spec.ts` V93b 断言无候选时 keys 恰为 `ok,name,goalSpec,requiredCapabilities,note` 且 `note` 逐字节等于旧文本；既有 prepare 测试一条未改，全量绿
- [x] B2 新增路径零 `appendOperatorNode` 调用（代码走查 + grep 证明） — `grep -n appendOperatorNode src/lib/workflow/seed-recall.ts src/background/agent.ts` 零命中
- [x] B3 `pnpm bench:workflow-generation` 与 `tests/bench/baseline-report.spec.ts` 期望**未变**；若变了即为缺陷，禁止 `UPDATE_BASELINE=1` 掩盖 — `pnpm bench:workflow-generation` 与 `tests/bench/baseline-report.spec.ts` 均通过，`tests/bench/baseline.json` 无 diff，未用 `UPDATE_BASELINE`
- [x] B4 `tests/generation-stages.spec.tsx`、`tests/acceptance-generation-phases.spec.ts` 的 6→7 阶段期望是**显式改写**的，改写理由写进测试头部注释（不得放宽断言或 skip） — 两处都写了理由注释：phases 断言 `GENERATION_STAGE_ORDER[0] === SEED_RECALL`，v93 断言 7 阶段完整顺序，panel 新增 label 用例
- [x] B5 `tests/agent-payload-size.spec.ts` 未因本改动被抬预算（offer 走工具结果，不进 advertised payload） — `tests/agent-payload-size.spec.ts` 未改且通过

### C. 真实浏览器双层取证（dcc 跑 `pnpm selftest`）

- [ ] C1 Round A（bootstrap，预期**无候选**）：完整 `build → reload → generate → verify`，默认小红书草稿 goal；`tmp/selftest-report.json` 落 `goal.certified / goal.level / goal.unmet`，且该工作流 `certificationStatus === 'certified'`
- [ ] C2 Round B（预期出现种子）：同 goal，代码未变则 `--skip-build`。可证伪链条完整：saved workflow 带 `seededFrom:[A]` + `generationStages` 含 `SEED_RECALL:ok` + `goal.certified === true`
- [ ] C3 对照 ≥4 轮 seeded / ≥4 轮非 seeded，观察 `selftest.mjs:636` "RAN CLEAN, GOAL NOT CERTIFIED" 分支的占比下降
- [ ] C4 结论只声明方向性（更少轮次达成 certification），**不声明百分比**；拿不到证据的项如实标 BLOCKED 与原因

### D. 复用与简洁（纪律项，无工具兜底）

- [x] D1 未新增相似度子系统/embedding；意图重叠用 `semantic-intent.ts`，窗口筛选复用导出的 `newestCountedRunOf`，定位器与凭据筛复用 `target-to-selector.ts:584/229/486` 与 `secret-guard.ts:55` 既有导出 — 复用 `semantic-intent` / `newestCountedRunOf` / `target-to-selector` / `secret-guard`；零 embedding
- [x] D2 未新增第三个持久化账本（`seededFrom` 挂既有 settings；`generation-metrics.ts` 未扩成账本） — 归属只挂 `draft.seededFrom` 与 `settings.seededFrom`，`generation-metrics.ts` 未动
- [x] D3 无未调用导出、无注释掉的代码；命名自证（`rankWorkflowSeeds`/`buildSeedOffer`/`SEED_MAX_AGE_DAYS`）；注释全英文且只写为什么（含"为何 offer 走 tool result 而非系统提示"、"为何召回异常要单独兜住"） — 逐常量核对导出被使用（`SEED_FLOOR_*`/`SEED_MAX_CANDIDATES`/`SEED_MAX_AGE_DAYS` 由测试按名引用，`countedWindowOf` 收回为文件内私有）
- [x] D4 UI：阶段 label 走 Tailwind + 既有 token，不新增 class、不内联静态样式 — 未新增 class、未内联静态样式，只加了一条 label 映射
- [x] D5 i18n：`generationStageSeedRecall` 在 `en` 与 `zh-CN` **双侧**赋值（封闭 `Messages` 接口机检）；flat camelCase，无重复 key — en `Seed recall` / zh-CN `种子召回`，封闭接口机检通过
- [ ] D6 暂存区无测试临时产物：`tmp/selftest-report*.json`、`tmp/n8n-mcp-tree.json` 只留在 `tmp/`，禁止 `git add -f`
- [ ] D7 提交为英文 Conventional Commits，拆 3 条：`feat(workflow): recall certified workflows as generation seeds` / `feat(workflow): attribute seeded generation in draft, settings and stage report` / `test(workflow): cover seed ranking and offer caps`；本轮不打 tag（§4 不适用）

### E. 功能验收（逐行可测）

- [x] E1 未 certified / 无 goalSpec / 最新计入运行失败 / >90 天且零通过 → 四种情况均不进候选（`no-data` **不排除**，否则 bootstrap 条目自己永远当不了种子） — `tests/seed-recall.spec.ts` describe『eligibility (E1)』
- [x] E2 跨站不串：`siteHints` 为空时只有 ≥0.60 强文本命中才 offer；中文新 goal vs 英文 saved summary 要么诚实过槛、要么诚实拒绝，不许蒙 — describe『floors and cross-site safety (E2)』含跨站否决与逐字复述两行
- [x] E3 offer ≤3 KB，溢出顺序确定（丢步 → 降到 1 候选 → 整块丢） — describe offer budget（含"丢一条过肥的步而不是作废整块"）
- [x] E4 offer 不含 `ref`、不含凭据字段、不含 >120 字符字面量；`{{ref}}` 原样透传 — describe offer scrub
- [x] E5 `seededFrom` 在 `asPersistedDraft` 与 `asWorkflow` 两条往返中存活（service worker 回收场景） — `tests/workflow-draft-storage.spec.ts` + `tests/workflow-storage.spec.ts` 两条往返
- [x] E6 种子选择器失效时，失败经既有结构化错误回给模型且 draft 未被污染（桩驱动 acceptance） — V93d（桩驱动，断言错误形状逐字节相同、draft 零动作节点、归因仍在）

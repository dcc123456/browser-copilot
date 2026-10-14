# 检索式种子生成 · Retrieval-seeded generation — design

日期 / Date: 2026-10-14
涉及模块 / Areas: `background`（agent 的 `prepare_workflow_goal` 回合、operator-tool-handler 的 compose）、`lib`（workflow/seed-recall、workflow/workflow-health、workflow/draft-types、workflow/storage、i18n、generation-report）、`sidepanel`（GenerationStages）、`workflow-generation-bridge`（摘要）

关联计划 / Plan: `specs/2026-10-14-workflow-seed-recall-plan.md`
评审来源 / Provenance: 本文是 `~/.qoder-cn/plans/tranquil-delta-linnet.md`（2026-10-14 批准）的落库版本。

## 1. 需求原文 · Requested behaviour

dcc 的命题：调研 `github.com/czlonkowski/n8n-mcp`，判断它靠什么策略生成稳定可用的工作流，以及能否用来提高本项目的**工作流生成成功率**。

调研结论（详见 §3）：n8n-mcp 的静态校验体系对本项目**不可用**；它唯一比本项目强的结构性能力是**模板检索复用**。本项目唯一还开着的生成质量指标是 **fresh-gen L3**——模型从自然语言任务生成的图，必须在**无 AI 接管**的普通运行中达成它自己声明的 goal（口径唯一事实源 `docs/ai-debug-success-rate-v3.md` §4.1：verified = takeover-free 验证运行通过且 goal 达成）。本设计把"检索复用已验证证据"这一条搬进本项目的 execution-first 架构。

期望结果：同站点同任务的第二次生成，模型不再从零现编定位器、等待与 goal 措辞，而是拿到一份**来自已验证工作流的步骤证据**作为建议；每一步仍然由模型自己 `wf_op_*` 真实执行、由真实浏览器裁决。

裁定（AskUserQuestion，2026-10-14，已定，不再讨论）：

| 项         | 决定                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| 召回资格   | **只认 `certificationStatus === 'certified'`**；不加"多次 ok"弱证据档       |
| 冷启动     | selftest 轮次即 bootstrap：第一轮把某站点做成 certified，第二轮才允许出种子 |
| 切片范围   | **单片**：只做种子召回；"生成期修复在 AI 补丁前加确定性纠偏"另立一片        |
| 浏览器证据 | dcc 本人跑 `pnpm selftest`，离线层与真实浏览器层双层验收                    |

## 2. 现状取证 · Evidence about the current code

以下均由代码位置支撑（改动前的行为），不是推测。

- **生成是执行优先的**：`src/background/operator-tool-run.ts:347-499` 的顺序是 JS 逃生门 →
  `hydrateDraft` → `stripDraftOnlyKeys` → `resolveOperatorLocator`(`:373`) → 空定位器拒绝(`:392-407`)
  → 活页探针 `countSelectorMatches`(`:414-426`) → 凭据路径 → ai-prefill → bulk-data → required-params →
  **执行**(`:499`)；失败即不写 draft。因此 n8n-mcp 靠静态校验拦下的那一类错误（参数缺失/枚举非法/
  连接断裂），在本项目**根本进不了图**——执行本身就是校验器。
- **每一步都是现编的**：录制进 draft 的定位器来自 `resolveOperatorLocator` 当回合的快照
  （`operator-tool-run.ts:291-298` `withLocator`），等待来自 `applyDefaultWaits`，节点 goal 来自
  `withNodeGoalContract`(`:665-666`)。三者的来源都只有"当前页面 + 当前模型回合"，**没有跨会话通道**。
  `src/lib/workflow/storage.ts:112-168` 的 `asWorkflow` 白名单里没有可被下一次生成读回的"步骤证据"字段，
  只有站点标识与契约。这是 fresh-gen L3 的直接来源。
- **已验证证据其实已经落盘，只是没人读**：`settings.certificationStatus`
  是封闭联合 `'unverified' | 'certified'`（`src/lib/workflow/types.ts:231`），只有 takeover-free 且 goal
  达成的验证运行才写 `'certified'`（`src/background/index.ts:1800`；桥 `src/background/workflow-generation-bridge.ts:631`），
  失败与自愈路径写回 `'unverified'`（`index.ts:1774 / :1811 / :1822`）。站点标识：`settings.generationOriginUrl`
  (`types.ts:184`)、`settings.pageContext`（origin ∪ additionalOrigins ∪ pathnamePattern，`page-context.ts:40-62`）、
  `trigger.urlPattern`。运行账本：`TaskRunLog[]`（`src/lib/task-store.ts:37`，key `scheduledTaskRuns`，cap 100 条/1.5MB），
  聚合器 `summarizeWorkflowHealth(runs, workflowId)`（`src/lib/workflow/workflow-health.ts:69-107`，窗口 10）
  已给出 `status / passedRuns / totalRuns / lastVerifiedAt`。**不需要新造成功账本。**
- **`L3` 已在运行期判定**：`src/background/workflow-engine/run-workflow.ts:922-954` 在 `outcome==='ok'`
  之后跑 `verifyGoalSpec(goalSpecOf(...))`，未达成即改写为 `'failed'`。推论：**有 goalSpec 时落盘的 `ok:true`
  已经蕴含 goal 达成**，所以 `TaskRunLog.ok` 是可用信号，不必另存 goalAchieved。
- **可复放的定位器形态已确定**：录制节点存的是 `selector`/`target`（`withLocator` 会删掉 `ref`），
  `ref` 只在同会话快照内有效。`operator-tool-run.ts:392-407` 的拒绝文案本身就要求"提供非空的
  target / selector"，即 inline 形态可脱离快照执行——种子只有以这种形态给出才可能跑通。
- **注入缝只有一个，且已有同类先例**：`wf_op_*` 有硬门槛，必须先 `prepare_workflow_goal`
  （`src/background/agent.ts:4363-4370`，`FIND_WORKFLOW_OPERATORS_TOOL` 分支 `:4331-4336` 同样要求）。
  它的成功返回在 `agent.ts:4304-4321`，`note` 字段已经在承载"带轮次编号的模型指令 + 为什么"
  （round-22 的"必须以保存草稿那步结尾"、round-50 的"证据要在运行结束的那一页读"）。chat
  （`src/sidepanel/ChatTab.tsx:2722-2732` → `src/background/index.ts:3174-3190`）与 unattended
  （`workflow-generation-bridge.ts:942-949` → `src/background/agent-unattended.ts:93`）**两条路径都必经此处**。
- **系统提示有字节闸**：`tests/agent-payload-size.spec.ts:155` 断言 `system.length + tools.length
≤ MAX_ADVERTISED_PAYLOAD_CHARS`，历史上每加一块内容都要显式抬预算（`:92-113` 的注释链）。所以种子
  以**工具结果**下发，不动系统提示。
- **两个持久化白名单会静默丢字段**：`asPersistedDraft`（`src/lib/workflow/draft-storage.ts:93-119`）
  只回灌 `conversationId/name/nodes/edges/tail/source/pendingBranch/variables`——今天它已经在丢
  `goalText/originUrl/actedOrigins`；`asWorkflow`（`storage.ts:121-127` 的注释明写"白名单漏一个键就静默降级"）。
  新增字段必须显式进这两处。
- **生成阶段契约是封闭的**：`GenerationStageId` 六值联合 + `GENERATION_STAGE_ORDER`
  （`src/lib/workflow/generation-report.ts:20-48`），面板 `src/sidepanel/GenerationStages.tsx:22` 有
  `STAGE_LABEL_KEY: Record<GenerationStageId, keyof TFn>`（穷尽映射）。`generationStages` 已落盘
  （`storage.ts:150`）并已渲染（`ChatTab.tsx:3583`）。锁死 6 阶段契约的测试有两个：
  `tests/generation-stages.spec.tsx`、`tests/acceptance-generation-phases.spec.ts`。
- **本项目已有的召回惯例是"确定性缩列表 + 模型自选"**，不是相似度打分服务：
  `src/lib/skills.ts:149-180` `renderSkillCatalogue` 把 `name: description` 列进提示，由模型 `use_skill` 挑；
  `src/lib/workflow/operator-discovery.ts:67-135` 用单一 `WEIGHTS` 常量 + `reasons[]` 证据 + `Math.min` 封顶
  做确定性排序。**全仓库没有 embedding/向量/词面相似度代码**（`embedding|cosine|levenshtein|jaccard` 零命中）。
- **双语意图检测已经存在且够用**：`detectSemanticIntents(text)`（`src/lib/workflow/semantic-intent.ts:445`）
  的词表是 13 个**控制流/能力类**意图（`:17-30`：`for-each / pagination / interaction-fill / storage-output /
verification` …），其匹配逻辑对 CJK 用子串、对英文用带边界空格（`:456-459`），因此**天然双语**。
  它不含业务域信息，所以必须与词面重叠联用。

### 2.1 现场取证（冷启动是否成立）

- **真实 profile 里当前没有任何 certified 工作流**：在 `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/fpnpagphilpolgbgmonhldjcnmdjncok/`
  全目录 `grep -a "certified"` **零命中**；对照组成立——同一批 `.ldb` 里 `goalSpec`(4)、`blockId`(6)、
  `label`(30)、`createdAt`(5) 均明文可见，所以这不是压缩读不到的假阴性。
- **仓库里也没有任何 certified 测试夹具**：`grep -rl "certificationStatus: 'certified'" tests/ src/ specs/` **零命中**，
  只有 `tests/workflow-generation-bridge.spec.ts` 与 `tests/workflow-storage.spec.ts` 碰过该字段。
- 结论：资格过滤压在一个**生产点很少（3 处）且测试覆盖近零**的字段上。因此 §5 的降级契约与
  §7 的自测 bootstrap 是设计的一部分，不是兜底话术；新增测试必须自己造 certified 夹具。

## 3. 选型与证据 · Options considered（§7.1）

一手来源：`github.com/czlonkowski/n8n-mcp` 仓库文件树（经 GitHub trees API 落盘 `tmp/n8n-mcp-tree.json`，
339KB）、其 README 的稳定性策略小节、本机对候选方案的代码可行性核对。

| 候选                                                                                      | 处置               | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 照搬它的 schema 库 + 巨型静态校验器                                                    | **否决**           | 它的资产是 `data/nodes.db`(69MB，`src/parsers/property-extractor.ts` 从官方包含肉收割) + `workflow-validator.ts`(115KB) + `node-specific-validators.ts`(118KB) + `enhanced-config-validator.ts`(56KB)。n8n 的节点是数据管道、失败模式静态可判定；本项目只在真实执行成功后记录（§2 第一条），执行即校验器。且我们的必填契约来自**执行器自己用的同一张表**（`src/lib/workflow/block-requirements.ts`，621 行，被记录闸/工具 schema/运行闸三处共读），天然零漂移；它必须靠 CI 重收割对抗上游漂移。 |
| B. 它的"不信任默认参数值"（README：default values are the #1 source of runtime failures） | **已等价存在**     | 我们的 required-params 闸 + `resolveOperatorLocator` + 探针已经在记录前拒绝空/缺参数。                                                                                                                                                                                                                                                                                                                                                                                                          |
| **C. 它的模板检索复用（`data/templates.db` + `search_templates → get_template → 改`）**   | **采纳（本设计）** | 这是它唯一比我们强的结构性能力。本项目 `Skill` 只有 `instructions: string`（`src/lib/types.ts:38-50`），是纯 prose，不带图；`specs/reliability-fixtures/` 只在 `tests/` 被引用，从不进运行时。所以"召回可复用的已验证图证据"在本项目是**结构性空白**。                                                                                                                                                                                                                                          |
| D. 把召回改成"工作流转成 skill"                                                           | **否决**           | skill 是 prose、种子是结构化参数/定位器；转换会产生同一内容的第二种表示，正是 AGENTS.md §5.6 禁止的再加一套。                                                                                                                                                                                                                                                                                                                                                                                   |
| E. 引入 embedding/向量检索                                                                | **否决**           | 项目已有确定性缩列表 + 模型自选的惯例（§2 倒数第二条）；召回质量靠"只从 certified 里选 Top-2"就已收敛，不需要新子系统。且 §2.1 显示候选池极小，向量检索是用大炮打空膛。                                                                                                                                                                                                                                                                                                                         |
| F. 在记录闸就用种子拦模型                                                                 | **否决**           | 记录闸报错会诱导模型放弃；种子应作为**参数建议**在计划期给出（`prepare_workflow_goal`），执行判定权仍归浏览器。                                                                                                                                                                                                                                                                                                                                                                                 |

被否决的第二个采纳项（"生成期修复在 AI 补丁前加一层确定性纠偏"，对标它的 `workflow-auto-fixer.ts` 46KB）：
按裁定属于另一片，本设计不含。

## 4. 设计 · Design

四个触点，一个新增纯模块，零新增工具、零新增基础设施。

### 4.1 召回纯函数 `src/lib/workflow/seed-recall.ts`（新增）

chrome-free、无 I/O，惯例照抄 `operator-discovery.ts`：单一 `WEIGHTS` 常量、`reasons[]` 证据、`Math.min` 封顶。

导出两个函数：

- `rankWorkflowSeeds(input)` → 候选 + 分数 + reasons。入参全部由调用方以纯数组/纯对象传入
  （`workflows: Workflow[]`、`runs: TaskRunLog[]`、`goalSummary`、`requiredCapabilities`、`siteHints: string[]`），
  因此可用夹具纯测。
- `buildSeedOffer(candidates)` → 下发给模型的 `seeds` 结构，负责截断与筛除。

**资格硬过滤（全满足才进池）**

1. `settings.certificationStatus === 'certified'`（§2：唯一落盘的 takeover-free + goal 达成证据）
2. `settings.goalSpec` 存在（certified 是相对它度量的）
3. ≥1 个动作节点带**录制定位器**（`selector` 或 `target`）——只有业务参数不够：没有定位器的步骤 offer 出去
   模型也无从复放；这条把"offer 内容必须可复放"写进资格，而不是留到打分阶段用分数近似
4. **站点冲突即排除**：候选自己记录的站点（`pageContext` / `generationOriginUrl` / `trigger.urlPattern`）与
   本次任务的 `siteHints` **都有值且不相交** → 排除。这不是加分项而是否决项：已知在别的站点上证明过，
   本身就是"不要把它拿过来"的证据。`siteHints` 为空时该规则不生效（生成前 origin 常常未知）
5. **毒化防护**：该工作流**最近一次计入的运行失败** → 排除，不看徽章（挡"几个月前 certified、昨天已坏"）
6. **新鲜度防护**：`updatedAt` 超 `SEED_MAX_AGE_DAYS = 90` **且** 窗口内 `passedRuns === 0` → 排除

> 第 5/6 条必须与 §2.1 的现场事实共存：verify 路径写 `settings.trialRun` 而不保证产生 `TaskRunLog`，
> 所以**新 certified 的工作流常常是 `no-data`**。规则是"`no-data` 不排除"——否则 bootstrap 出来的那一条
> 自己永远当不了种子，Round B 必然失效。第 5 条只在"确实有 run 且最新一条是失败"时才生效。

**打分（0..1）**

| 信号                                | 权重  | 依据                                                                                                           |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| 主 origin 命中 siteHints            | 0.40  | `URL.origin` 精确相等（复用 `originOfUrl`，`page-context.ts:60`）                                              |
| additionalOrigins / urlPattern 命中 | 0.25  | 上一行未命中时                                                                                                 |
| 意图形状                            | ≤0.25 | `detectSemanticIntents` 的加权 Jaccard（复用，不新建词表）                                                     |
| 双语词面                            | ≤0.35 | **goal 侧覆盖率**：共享 token 数 / 新 goal 的 token 数，latin 小写 token + **CJK bigram**；共享 < 3 个词直接 0 |
| 能力 ↔ blockId 重叠                 | ≤0.10 | 经 `operator-registry.ts`                                                                                      |
| 新鲜度                              | ≤0.05 | `lastVerifiedAt` / `updatedAt`                                                                                 |

> 校准记录（实现期实测，非事后补写）：词面原设计为 Jaccard(≤0.25)，实测中文新 goal 对英文已存
> summary 的 Jaccard 上界极低（两边 token 集不对称），会把真命中压在门槛之下；改为**以新 goal 为分母
> 的覆盖率**并把上限抬到 0.35，同时用 `MIN_SHARED_TOKENS = 3` 防"碰巧共享两个词"。抬上限换来的召回
> 由两条规则兜住风险：覆盖率是单侧度量（长 goal 不会靠自身体量得分），且跨站在资格阶段就被否决。

门槛：有站点信号 0.45；`siteHints` 为空或未命中时提高到 **0.60**。那个更高门槛就是"别把小红书种子塞进 GitHub 任务"的实现——实测下来 0.60 意味着**只有近乎逐字复述同一目标**才能在无站点信号时被召回，这正是想要的行为，因此保持不降。Top K = 2。

运行窗口的"最新计入运行"判断从 `workflow-health.ts` 导出 `newestCountedRunOf(runs, workflowId)` 复用
（`isRunOf/isCounted/runTime` 现为 private，`summarizeWorkflowHealth` 自己也要这段 sort-and-window），
不在 `seed-recall.ts` 复刻第二份——AGENTS.md §5.2。

### 4.2 offer 下发：`prepare_workflow_goal` 的成功返回

`src/background/agent.ts:4304-4321` 的返回对象上新增 `seeds`（无候选时**整个键缺席**），并沿 `note`
既有格式追加一段模型指令（英文，面向模型，含"仅建议、仍须逐步真实执行、执行失败就丢掉种子回到正常发现"）。

每步字段全部来自既有工具，不新写提取逻辑：`blockId`；`__workflowAi` 的 goal + 前两条 successCriteria
（`node-goal-contract.ts:19-35`）；可复放定位器经 `reliabilityLocatorOf`/`selectorCandidatesOf`/
`recordedTargetChainOf`（`target-to-selector.ts:584/229/486`），**永不 offer `ref`**；业务参数；`wait`/`elementWait`。

**Token 预算**：工具结果随每一轮重发、接管轮次上限 40（`takeoverToolRounds`，`docs/…v3.md` §M3-18），
故 offer 硬顶 **3 KB**：≤8 步/候选、selector ≤200 字符、goal ≤160 字符、≤2 候选；溢出按"丢步 → 降到 1 候选
→ 整块丢"的**确定顺序**截断。截断以**单个步的 JSON 体积**为单位：一条超过整块预算的步（批量数据类节点）
直接不参与 offer，而不是把它连同整块一起作废——一条过肥的步不该让整次召回变成 no-op。
历史压缩丢掉 offer 不影响归因（归属落 `draft.seededFrom`）；压缩不得删
`role:'user'` 轮（`specs/2026-10-14-user-turn-spine-design.md` 既有红线），种子活在 tool result 侧，安全。

### 4.3 归属与度量（四处显式触点）

1. `WorkflowDraft.seededFrom?: string[]`（`draft-types.ts`）+ **进 `asPersistedDraft` 白名单**
2. `WorkflowSettings.seededFrom?: string[]`（`types.ts`），compose 时由 draft 写入 + **进 `asWorkflow` 白名单**，沿用兄弟键的逐键类型守卫（`Array.isArray && filter(is string)`）
3. `GenerationStageId` + `GENERATION_STAGE_ORDER` 加 `'SEED_RECALL'`，compose 在 pipeline 阶段前 prepend `stageReport('SEED_RECALL', seeded?'ok':'skipped', …, {candidates, steps})`；面板 `STAGE_LABEL_KEY` 一条 + `Messages` 两个 flat camelCase 双语 key
4. 桥摘要在 `certificationStatus` 旁加 `seededFrom`（`workflow-generation-bridge.ts:850`），让 `tmp/selftest-report.json` 自带 join key

成效表 = `seededFrom × certificationStatus`。**不新建计数器存储**（`generation-metrics.ts` 是纯内存、零持久化，不扩成第二套账本）。

### 4.4 凭据与字面量：只复用既有谓词

录制时 `redactRecordedParams`（`operator-tool-run.ts:564-567`）已脱敏、compose 时 Generalize 已泛化，
召回读到的绝大多数本就是 `{{ref}}`（**原样 offer**，由模型自己的变量解析，不会冻结生成期数据）。
`buildSeedOffer` 再加三道，谓词全部已存在：① `forms` 参数字段类型过 `isCredentialFieldType`
（`secret-guard.ts:55`）的丢弃，并提示"照旧用 get-secret / 输入供给"；② >120 字符字面串丢弃（bulk-data 类）；
③ 节点带 `credentialFillPath` 的参数不 offer 字面量。不碰 `forgetGenerationSecrets` / 内存 secret bag——
召回只读 storage，那里按构造不含凭据字面量。

## 5. 降级契约 · Degradation must equal today

- 无候选 → `seeds` 键缺席、`note` 与今天**逐字节相同**：所有断言 prepare 返回的既有测试**不改即通过**，
  这条本身就是降级测试。
- 种子定位器过期 → 模型带着种子 selector 调 `wf_op_*` → 执行失败 → 走既有结构化错误
  （`operator-tool-run.ts:509-517`）→ 回落 `snapshot_page` + 正常发现。**不新增可达失败模式**：offer 只提供
  参数值，不做任何闸口已经没做过的决定。
- 召回计算异常 → 单独 try/catch 记日志并省略 `seeds`。理由：goal 契约门槛住整条生成链
  （`agent.ts:4363-4370`），召回绝不能把契约弄丢。这是本设计唯一的系统边界防护，写进注释。
- **结构上不变量零风险**：新增路径不调用 `appendOperatorNode`、不写 draft 节点，只写 `seededFrom`
  元数据和一个提示块。"只有执行成功过的一步才进图"没有被稀释一寸。

## 6. 回滚 · Rollback

offer 是唯一行为变更面：`buildSeedOffer` 返回空即逐字节等于今天。回滚 = 关掉 `rankWorkflowSeeds` 的
一个调用点；`seededFrom` 字段与 `SEED_RECALL`（`skipped`）保留不影响任何既有运行。

## 7. 验收口径 · Acceptance（逐条见 plan 文档）

度量只用既有仪器，不自造口径（AGENTS.md §7.4）：

- 离线：`pnpm typecheck/test/lint/format:check/build`；`pnpm bench:workflow-generation` 与
  `tests/bench/baseline-report.spec.ts` **期望必须不变**（基线语料无 certified 夹具，动了就是本改动的 bug，
  不许 `UPDATE_BASELINE=1` 掩盖）。
- 真实浏览器：`pnpm selftest`（`scripts/selftest.mjs`，`PHASE_ORDER = build/reload/generate/verify`，
  产物 `tmp/selftest-report.json` 的 `goal.certified / goal.level / goal.unmet`；`:636` 的
  "RAN CLEAN, GOAL NOT CERTIFIED" 分支**消失**就是本设计要杀的那个失败模式）。Round A bootstrap（预期无候选）
  → Round B seeded（预期 `seededFrom:[A]` + `SEED_RECALL:ok` + `goal.certified=true`），双向各 ≥4 轮。
- 诚实边界：N 轮 selftest 是**弱统计仪器**，只允许声明方向性结论（更少轮次达成 certification），
  不得声明百分比提升。

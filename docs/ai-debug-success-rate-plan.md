# AI 调试成功率提升方案

> 目标：提高「AI 调试」（失败节点 AI 接管）的成功率，并缩小"调试成功 → 日常运行仍失败"的落差。
> 状态：**已实施**（typecheck / 全量测试 / build 通过）。落地清单见文末 §6。

## 0. v2 重定义（对话式复演 + 图审计，已实施）

实测表明：仅靠"节点级接管 + 参数修复"对结构性坏图（节点多余/缺失/顺序错）无能为力。因此调试升级为三段式：

1. **复演（replay）**：节点级循环失败后，一个 FULL 模式智能体拿到工作流的《目标与执行步骤说明》，
   像第一次在聊天里那样在页面上**真实完整地执行**整个任务（snapshot → 操作 → 验证，不许干跑），
   记录实际工具轨迹。
2. **图审计（audit）**：一次模型调用对照"复演实际做成的过程"与工作流图，逐节点判定
   `ok / wrong(给 paramsPatch) / missing / redundant / fallback(需 onError 兜底)`，
   输出中文诊断 + 变更清单 + **修正后的完整图**（nodes/edges）。
3. **验证 + 待确认**：修正图通过严格校验（合法算子、有 trigger、连边可解析、节点数上限）后
   以"无接管"独立跑一次验证；**验证通过才**存为待确认的整图重写（`takeoverApply` 时整体替换
   流程图），验证失败则只报告诊断与逐节点审计，不落盘任何修改。

配套：对话生成工作流时自动把目标（会话标题）+ 各节点 description 组装成《目标与执行步骤说明》
（`Workflow.plan`），复演与审计都以它为任务简报；生成器技能同时要求 description 必须自足。

### 0.1 上游根因溯源（已实施）

报错节点 ≠ 根因节点。节点级接管与图审计都按"向前溯源"设计：

- **证据链进提示词**：接管时把实际执行过的上游链路（节点 id + 描述 + 参数）和当前变量
  实际值一起给到模型——变量值错/空就是上游产错值的指纹。
- **修复可指向上游**：verdict 的 `fix` 增加可选 `nodeId`；模型判断根因在上游时直接指名
  那个节点，runtime 校验该节点真实存在（否则回退到失败节点）后生成修复建议，日志明确
  写出"根因定位：失败源头在上游节点「…」"。
- **图审计同规则**：复演后的审计被明确要求"从复演轨迹找第一个做错的环节"，wrong 判给
  产出错误值的上游节点。

### 0.2 目标达成判定（已实施）

成功的标准不是"没有报错"，而是"工作流是否完成了目标"。引擎运行无错 ≠ 目标达成
（可能读错元素、填错框、提交到空处）。因此调试会话对**每一次 ok 运行**（首轮通过、
修复验证轮、重建版验证轮）追加一次目标判定：

1. **证据**：引擎运行结果新增 `variables`（节点最终产出的变量值）与 `steps`（运行步骤尾部）；
   调试运行的 run 闭包把它们解析成人类可读的证据链回传。
2. **判定**：一次模型调用（`buildGoalCheckPrompt`/`parseGoalVerdict`），对照 `Workflow.plan`
   的《目标与执行步骤说明》判定 `{"achieved":bool,"reason":"中文依据"}`——变量值为空/错、
   计划要求的步骤没跑、该发生的提交没发生都判"未达成"；排版/措辞差异宽容，实质错误严格。
3. **后果**：未达成 ⇒ 视为失败——首轮未达成直接转入复演+图审计；验证轮未达成不落盘、
   继续下一轮（轮次用尽则升级复演）；重建版未达成不保存。结果新增
   `goalAchieved/goalNote` 字段。判定不可用（无 provider/超时/解析失败）时退回
   旧的"无报错"标准，行为不变。

## 1. 现状链路（一句话版）

调试 = 带接管的运行：`workflows.debug` 给引擎挂 `aiTakeover` 钩子（`src/background/index.ts`）→ 节点失败时引擎把该节点交给 `createAiTakeover`（`src/background/workflow-engine/ai-takeover.ts`）→ 最多 3 次全新代理对话（`runUnattendedPrompt` FULL 模式，25 轮工具预算）→ 代理用页面工具（snapshot/click/fill/…）完成该步骤 → 成功则运行继续；代理提议的 `paramsPatch` 只存为**待确认修复**（`takeover-pending`），用户在面板确认后才落盘。

已完成的第一轮改进（本次方案的地基）：跨尝试工具轨迹回喂、宽松 verdict 兜底、下游边界声明、输出变量强制、快照 `loc` 定位提示、更丰富的锚点。

## 2. 失败模式分类（按代码推断，建议先用 §4.4 的埋点验证占比）

| 类别 | 典型表现 | 当前代码事实 |
|---|---|---|
| A. 时序类 | 慢页面/懒加载导致"元素未找到" | 交互块的轮询等待**默认关闭**：只有块参数 `waitForSelector === true` 才启用（`withWait`，`src/background/workflow-engine/executors.ts:1641`），录制/生成的块大多没开 |
| B. 定位类 | 选择器过期、元素在 iframe/Shadow DOM/长列表尾部 | 快照元素上限 120（kernel）/80（summarize），目标可能不在快照里 |
| C. 环境类 | 登录墙、验证码、反爬、404 | 无快速失败路径：不可恢复错误照样烧满 3 次尝试 |
| D. 语义类 | AI 理解错步骤目的、做错/做多了 | 已有下游边界声明缓解；模型能力是天花板 |
| E. 配置类 | 未配模型、多窗口 snapshot 到错窗口 | 无模型已有快速失败；scope 错误无专门检测 |
| F. 闭环缺失 | 调试成功但下次普通运行还失败 | 修复只 pending，确认后无验证重跑；且**只有调试运行**有接管（手动/定时/Feishu 触发都没有，`aiTakeover` 仅在 `workflows.debug` 传入） |

## 3. 方案目录（按"确定性加固 → 接管更强 → 修复闭环 → 度量"分组）

### G1 不花模型钱的确定性加固（优先做，收益/成本比最高）

**P0-1 调试运行自动启用元素等待**
- 做法：debug 会话启动时对工作流做一次浅拷贝，把所有交互块（click/forms/press-key/hover）临时打上 `waitForSelector: true`（3~5s，可配），不改原工作流。
- 改动点：`src/background/index.ts` debug case + `withWait` 逻辑；约 30 行。
- 原理：A 类失败根本不该由 AI 接管处理——等待 3 秒就能解决的"失败"浪费 3 次代理对话。
- 预期：直接消灭时序类失败的大部分；接管次数显著下降。

**P0-2 失败预分类 + 快速失败（省时间也省成功率虚耗）**
- 做法：接管 verdict 增加可选字段 `reasonKind: 'auth' | 'captcha' | 'notfound' | 'timeout' | 'network' | 'other'`；runtime 遇到 `auth`/`captcha` 立即终止重试（这类重试不可能成功），并给出明确的中文结论（"该页面需要登录，请先登录后重试"）。
- 改动点：`src/lib/workflow/ai-takeover.ts`（schema + prompt 一行）+ `ai-takeover.ts` runtime（break 条件）。
- 预期：C 类失败从"3 次尝试 × 25 轮工具"降到 1 次；同时把失败原因说清楚，用户知道该干什么。

**P0-3 scope 自检**
- 做法：接管开始前校验 `request.scope`/tabId 与引擎运行的 `targetTabId` 一致（engine 已传 `tabId`，`AiTakeoverRequest` 已有该字段但 runtime 未使用）；不一致时把接管代理钉到运行所在的 tab 而不是默认窗口解析。
- 改动点：`src/background/workflow-engine/ai-takeover.ts`（把 `request.tabId` 传给 `runUnattendedPrompt` 的 scope 解析或工具上下文）。
- 预期：消灭"多窗口用户 snapshot 到错误页面"这一整类静默失败。

### G2 接管本身更强（模型层）

**P1-4 接管专用模型**
- 做法：settings 增加 `takeoverModel: { providerId, model }`（完全仿照现有 `imageModel` 的 v3 迁移模式，`src/lib/storage.ts:137`），Settings UI 加一行；接管 runner 用它解析 provider。
- 理由：接管是"看页面 + 多轮工具调用"的硬任务，用户可给调试配更强模型而不影响日常聊天成本。
- 改动点：storage 迁移 + Settings UI + `createAiTakeover` 的 provider 解析；未配置时回落当前模型。

**P1-5 尝试间冷却与强制重观察**
- 做法：失败的尝试之间加 1.5s 延迟（页面状态稳定）；prompt 已要求重新 snapshot——runtime 在第 2、3 次尝试的 prompt 开头追加一行"先重新 snapshot_page 再行动，页面可能已变化"。

**P2-6 快照覆盖增强（仅在接管场景）**
- 做法：接管代理首次 snapshot 后若判断"目标不在列表"（prompt 引导），先 `scroll` 到底再 snapshot 一次对比；或 snapshot 工具在 takeover 上下文里提高 `maxElements`（120 → 200，token 成本换覆盖率）。默认不改全局行为。

**P1-7 失败原因分类引导（配合 P0-2）**
- 做法：prompt「How to work」前置一步："先判断失败类型：元素不存在？页面没加载完？需要登录？验证码？——分类决定策略（等待重试 / 找新元素 / 直接放弃并报告）"，避免对登录墙瞎点 25 轮。

### G3 修复闭环（治"调试成功、下次还坏"）

**P0-8 调试会话内自动应用修复 + 验证重跑（本方案核心结构改动）**
- 现状缺口：fix 只是 pending，用户确认后没有验证；且"调试"只验证了"AI 能救"，没验证"修完以后不需要 AI 也能跑"。
- 做法：`workflows.debug` 改成会话循环（最多 2 轮，可配）：
  1. run（带接管）→ 收集 reports + fixes；
  2. **把本轮 fixes 自动应用到内存副本**，立即重跑一次**不带接管的验证 run**；
  3. 验证通过 → 修复落盘为 pending（或按开关直接保存），会话成功；验证失败 → 新错误进入下一轮接管上下文。
- 改动点：`src/background/index.ts` debug case（循环 + 临时应用 + 验证 run）；`patchNodeParams` 已具备（`src/lib/workflow/auto-debug-patch.ts`）。
- 语义变化：调试结果从"AI 这次救活了"升级为"修复已被验证有效"。原工作流仍不动（落盘依旧走用户确认），风险可控。
- 预期：这是"成功率"用户体感的最大杠杆——用户要的是**以后能跑通**，不是这次被 AI 救活。

**P1-9 修复类型扩展**
- 做法：verdict 的 `fix` 除了 `paramsPatch`，允许 `enableWait: true`（给该块加 waitForSelector）与 `onError` 策略建议（retry×N）——这两类是 AI 修不好但确定有效的"非定位修复"。
- 改动点：`TakeoverFix` 类型 + 确认 UI 文案 + `applyTakeoverFixes` 的应用逻辑。

### G4 度量（没有数据就无法继续优化）

**P1-10 接管结果埋点**
- 做法：每次接管 episode 追加一条本地记录（workflowId、nodeId、blockId、attempt、completed、reasonKind、耗时），按 workflow 聚合，History/调试报告显示"近 10 次接管成功 7 次，失败原因：登录墙 ×2、定位 ×1"。
- 改动点：`TakeoverReport` 已有全部字段，只需持久化 + 一个聚合查询 + 一小块 UI。
- 价值：验证本方案各项的真实收益，找出剩余失败的 top 原因。

### G5 环境与覆盖面

**P2-11 普通运行可选接管**
- 做法：设置开关"运行失败时尝试 AI 接管（消耗模型调用）"，默认关；开启后手动运行/定时任务也传入 takeover hook（`src/background/workflow-engine/run-workflow.ts` 已支持透传）。
- 注意成本：定时任务无人值守时失败重试要克制（建议只允许 1 次接管）。

**P2-12 编辑器内"易失败块"提示**
- 做法：workflow-review 已有算子指南（`src/lib/workflow/operator-guide.ts`）；在生成的块缺 `waitForSelector`/缺 `description` 时提示补齐，从源头减少失败。

## 4. 推荐实施顺序

| 阶段 | 内容 | 理由 |
|---|---|---|
| **P0（先做，1~2 天量级）** | G1-1 自动等待、G1-2 快速失败、G1-3 scope 自检、G3-8 自动应用+验证重跑 | 前三个是零模型成本的确定性修复；G3-8 直接改变"成功率"的用户体感 |
| **P1（其次）** | G2-4 专用模型、G2-7 分类引导、G2-5 冷却、G3-9 修复类型、G4-10 埋点 | 模型层增强 + 建立数据回路 |
| **P2（视数据决定）** | G2-6 快照增强、G5-11 普通运行接管、G5-12 编辑器提示 | 等 P1 埋点说明剩余瓶颈再投入 |

## 5. 明确不建议做的

- **盲目加尝试次数**（3 → 5+）：无记忆改进前边际收益极低、成本线性涨；现在有轨迹回喂，3 次是合理上限。
- **每次尝试都带截图多模态**：贵、慢、多数场景 snapshot+loc 已够；保留为 `screenshot` 工具按需调用。
- **把修复静默写入原工作流**：此前已与用户确认"修改需确认"；自动应用只在调试会话的**临时副本**上做，落盘仍走确认。

## 6. 验收标准（P0 完成后）

1. 同一工作流连续调试 3 次，至少 2 次出现"验证运行通过（无 AI 参与也能跑完）"的结果。
2. 登录墙/验证码场景：调试在 ≤1 次尝试内结束并给出明确中文原因，不出现 25 轮工具空转。
3. 多窗口环境：接管代理操作的 tab 与运行日志中的 targetTabId 一致。
4. 埋点上线后能回答："剩余失败里，定位类/环境类/语义类各占多少？"

## 7. 实施记录（全部落地）

| 项 | 落点 |
|---|---|
| G1-1 自动等待 | `debug-session.ts` `withWaitFor()`：调试运行对交互块强制 `waitForSelector:true`（4s），不改原工作流 |
| G1-2 快速失败 | `ai-takeover.ts`（lib）`reasonKind` 白名单 + `classifyReason` 关键词兜底；runtime 遇 `auth`/`captcha` 第 1 次尝试后立即终止 |
| G1-3 scope/tab | runtime `pinTab` 依赖：接管开始前把运行 tab 置前台 + 窗口聚焦（`index.ts` 实现） |
| G2-4 专用模型 | `settings.takeoverModel`（Settings 卡片，imageModel 同款交互）+ `takeoverProviderOf()` 解析；`agent.ts` `getProvider` 依赖逐层穿透 |
| G2-5 冷却 | 尝试间隔默认 1.5s（`attemptDelayMs` 可注入，测试传 0） |
| G2-6 快照提示 | prompt 要求长页面传 `maxElements: 200` + `loc` 提示复用 |
| G2-7 分类引导 | prompt "先分类再动手"：登录墙/验证码立即放弃；修复建议可含 `waitForSelector/waitSelectorTimeout` |
| G3-8 自动应用+验证 | `debug-session.ts` `runDebugSession()`：运行→收集修复→应用到内存副本→**无接管验证运行**→通过才算 `verified` 并存待确认修复；最多 2 轮；面板横幅显示"已验证/未验证" |
| G3-9 修复类型 | prompt 修复指引覆盖等待参数；`patchNodeParams` 保护 blockId/disableBlock 不变 |
| G4-10 埋点 | `takeover-stats.ts`（本地 200 条/30 天）+ `workflows.takeoverStats` 命令 + 调试弹窗成功率/失败原因行 |
| G5-11 普通运行接管 | `settings.takeoverOnRun`（默认关）开启后手动运行失败节点获得一次接管 |
| G5-12 编辑器提示 | `operator-guide.ts` 增加"可靠性要求"：稳定选择器、导航后交互块写 waitForSelector、element-exists 分支 |

测试：`tests/debug-session.spec.ts`（会话循环全流程）、`tests/takeover-stats.spec.ts`、`tests/ai-takeover.spec.ts` 扩展（快速失败/分类/专用模型/tab 钉定/verdict reasonKind）。`pnpm typecheck`、`pnpm test`（1098 通过）、`pnpm build` 全绿。

# JS 原生阶梯回退 · Native-rung evidence unlocks the JS escape hatch — design

日期：2026-10-15。范围：`src/lib/workflow/capability-gap.ts` 与其三个调用点。
关联：`docs/ai-debug-success-rate-v3.md`（verified 口径），`specs/2026-10-14-workflow-seed-recall-design.md`（同期改动，无耦合）。

## 1. 需求原文 · Requested behaviour

真实生成中遇到：页面元素**无法用声明式 click 触达**（React 合成事件 / shadow DOM / 只监听
`mousedown` 的自定义组件）。模型改用 `wf_op_javascript-code`，但该步 description 里带"点击"二字，
于是被 native-first 闸直接拒绝：

```text
A native operator exists for "click"; use it instead of JavaScript.
```

结果是生成失败。dcc 的裁定：**A + B 合起来**——先用既有证据判定原生阶梯到底可不可用（B），
再对"确认不可用"的场景走 sanctioned gap（A）。

## 2. 现状取证 · Evidence about the current code

1. 拦截点有两处、逻辑重复（AGENTS.md §5.2 的"第二次出现"）：
   `capability-gap.ts:190-202`（`evaluateCapabilityGap`）与 `:285-295`（`evaluateJsPermission`）。
   两处都是 `NATIVE_INTENT_MAP.find(...)` 命中就 `allowed:false`，**完全不看已提供的 `gap`**：
   `validateGapRecord` 在 `:204` 才执行，即原生意图命中即早退。
2. 报错文案只说"用原生算子"，没有任何解锁条件；模型除了放弃或换个更差的算子没有第二条路
   （模块自己在 `:10-13` 已经写过这个教训："asking the model to re-derive a standing policy each
   time only produced refused calls"）。
3. **仓库里已经有"原生算子在本页确实跑过且失败"的证据**，只是这个闸没读它：
   `generation-coverage.ts:76` `failedBlockIdsOf(conversationId)` 返回本会话生成期间失败且未重试成功的
   blockId；写入点 `operator-tool-run.ts:514`（执行失败），清除点 `:694`（同名算子后来执行成功）。
   也就是说：`event-click` 真跑了、页面拒了 → `event-click` 在这个 set 里；模型后来点成功了 → 自动移出。
   这是**真实浏览器给的证据**，不是模型的自述。
4. 与 3 对照，现状里**任何一句非空 `justification` 都能放行 JS**（`capability-gap.ts:312-313`
   `scriptJustification` → `{allowed:true}`，不做任何事实校验）。
5. 三个调用点都已持有 `conversationId`，因此读证据零新增依赖：
   `agent.ts:4464`、`operator-tool-handler.ts:349`、`operator-tool-run.ts:363`。

## 3. 选型与证据 · Options considered（§7.1）

| 候选                                                                            | 处置                     | 理由                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 给"点击/填写"这类意图整体放开 JS                                             | **否决**                 | 等于拆掉 native-first 策略。声明式算子可读、可修、可回放；`javascript-code` 是整图里唯一不可分解的一步。                                                                                   |
| B. 要求模型必须补齐四字段 `capabilityGap` 才解锁                                | **否决（作为唯一路径）** | 与现状 `justification` 一条空话即可放行相比，它**更严**，但对本 bug 的场景仍是"让模型重新论证一件机器已经知道的事实"——而事实已经在 `failedBlockIdsOf` 里。模块 §1 已明令避免这种重复论证。 |
| C. 新增一条 `SANCTIONED_JS_GAPS`（用脚本体正则识别 shadow DOM / dispatchEvent） | **否决**                 | 正则读代码判"够不够特殊"会随写法漂移；且对**任何**含 `.click()` 的脚本开口，比按实际执行结果放行更松。                                                                                     |
| **D. 用既有执行证据判定原生阶梯不可用，命中即合成 sanctioned gap**（本设计）    | **采纳**                 | 证据来自真实执行（比 §2.4 的 prose 校验更强），零新数据、零新存储、零新算子；且**只放宽"已经有证据"的情形**，无证据时拒绝依旧。                                                            |

被否决后仍保留的一处：**报错文案必须写清解锁条件**（今天不写，是本轮失败的直接放大器）。

## 4. 设计 · Design

### 4.1 判定顺序（唯一变更面）

```text
sanctioned gap（已认定：产出图片类）        → 放行
原生意图命中，且该意图的原生算子**没有**失败记录 → 拒绝（文案含解锁条件）
原生意图命中，且其原生算子在本会话真跑过并失败   → 合成 sanctioned gap，放行
其余（无原生算子的意图）                     → 现状不变：四字段 gap 或 justification
```

"原生算子在本页不可用"= `nativeOperatorsForIntent(stepIntent)` ∩ `failedBlockIdsOf(conversationId)` 非空。
交集非空即证据成立——不要求模型再解释一次页面为什么点不动，因为**已经点过并且失败了**。

### 4.2 合成的 gap 记录（可审计）

```ts
missingCapability: 'reach the element the native "click" operator could not (event-click failed in this session)'
triedOperators: ['event-click'] // 来自证据，不是模型自述
whyInsufficient: 'the native operator ran on this page and the page refused it (generation coverage record)'
expectedResult: 'the same effect as the native step, produced by a script because no declarative rung reaches it'
```

它沿既有路径写进节点（`justification` → 记录到 canvas 卡片），用户仍读得到"为什么有个代码节点"。
`triedOperators` 写的是 blockId 而非算子名：与 `coverageBlockName` 的展示口径不同，但它是 join key，
`generationStages` / 诊断里按 id 读。

> 落地时核对到的既有优先级（`operator-tool-run.ts:647-654`，本次不改）：节点已有 `description` 时
> 以模型写的描述为准，`justification` 只在描述缺失时顶上。所以证据文本必然出现在工具结果的
> `scriptJustification` 里，是否成为卡片描述取决于模型有没有写描述——这与今天"自带 justification 的
> 脚本"完全同规则，不是本设计新增的分支。

### 4.3 重复逻辑收敛（§5.2）

抽出内部 `nativeRungFor(stepIntent)`（返回 `{label, blockIds}`，`blockIds` 已在
`generationOperators()` 里过滤）：`hasNativeOperator` 与两处判定共用同一份 `NATIVE_INTENT_MAP`
扫描。`evaluateJsPermission` 不再自己写原生早退，改为把证据转交给 `evaluateCapabilityGap` 并映射它的
decision（`nativeBlockIds` 非空 ⇒ 拒绝仍优先于 `justification` 兜底），拒绝文案由单一
`nativeRefusalReason(rung)` 产出。**不导出 `nativeOperatorsForIntent`**：没有调用方就需要它，
按 §5.4 属于死导出。

### 4.4 调用点

`evaluateCapabilityGap` / `evaluateJsPermission` 新增可选入参
`nativeAttemptFailedBlockIds?: readonly string[]`。三个调用点传 `failedBlockIdsOf(conversationId)`。
**不传即等于今天的行为**（纯函数保持无副作用、可夹具测；Runner 侧无生成路径，`server/**` 零改动）。

## 5. 降级契约 · Degradation must equal today

- 证据 map 是内存态（`generation-coverage.ts:34-37` 注释已说明），service worker 被回收后证据丢失 →
  回到"拒绝 + 文案给解锁条件"，即今天的行为。不做持久化（不新增第三套账本，AGENTS.md §5.6）。
- 无原生算子的意图：判定顺序完全不变。
- 已认定缺口（图片类）：判定顺序完全不变，仍在最前。

## 6. 风险 · What this makes easier

放宽的是"有真实失败证据时不用写说明"。反向风险是模型**故意先让原生算子失败一次**换取 JS 通行证；
但失败会被 `coverageWarningLines` 记成保存卡上的"生成覆盖缺口"警告（`generation-coverage.ts:100-107`），
且失败的节点不会进图——用一次失败换一步 JS，代价已经显示在用户面前。

## 7. 验收口径 · Acceptance

见 `specs/2026-10-15-js-native-fallback-plan.md` 的逐项列表（含不得改动的既有断言清单）。

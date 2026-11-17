# 工作流生成选择器模板 / Workflow generation selector template

把"列表采集类"工作流从"生成后试跑就挂"变成"一次生成就通过"的可复制 prompt 模板。
来源：2026-11-16 在小红书真实页面上的两次对照实验，详见 `specs/2026-11-16-xiaohongshu-follow-workflow-split-design.md` 的"实测验证"章节。

## 为什么要固化这个 / Why this exists

同一段"采集小红书笔记三列数据"的需求，两次无人值守生成（`generate_workflow`）结果完全相反：

| 轮次 | prompt 是否约束选择器 | 结果                                                                                                                                                                          |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 否（只说"采集三列"）  | 模型自主选 `section:nth-of-type(N) > div > div` 位置选择器 → 试跑第 2/7 步读不到（元素隐藏/遮挡），4 处 `LOCATOR_POSITIONAL` 警告，`parse-excel` 失败被丢弃，`verified:false` |
| 2    | 是（套用下面模板）    | 选 `a.author .name` / `.like-wrapper .count` / `a.title[href*="/explore/"]` 语义+属性选择器 + `wait-connections`/`waitForSelector` → 试跑 6/6 全过，`verified:true`           |

结论：**成败主因是选择器质量，不是工作流大小**。把选择器约束写进生成 prompt 的收益，大于单纯把流程拆细。这条规则应固化进所有"列表采集/逐条操作"工作流的生成请求。

## 可复制 prompt 模板 / Copyable template

生成任何"从页面列表采集数据"的工作流时，在需求描述后附上这段约束（方括号内容按实际页面替换）：

```
选择器硬性要求（非常重要）：
- 只用稳定属性选择器：带语义的 class（如 [a.title]）、属性包含（如 [a[href*="/xxx/"]]）、
  [data-testid]、[name]、#id、稳定可见文本；绝对不要用 nth-of-type、nth-child、:eq() 等
  按位置的选择器——它们会让重放失败，且生成时会报 LOCATOR_POSITIONAL 警告。
- 不要读取被隐藏或遮挡的元素；优先选可见、带文本的链接/元素。
- 导航（new-tab）或跳转之后，先接 wait-connections（timeout 10000），再读取；
  每个读取/点击节点开 waitForSelector:true，等元素真正出现再操作。
- 采集前先用 snapshot_page / 读 DOM 确认选择器命中数；整列采集时命中多个
  同构元素是正常的（配 multiple:true + saveData:true + dataColumn），
  但单个操作节点若命中多个不同元素就是歧义，要收紧选择器。
- 每一列用一次 get-text(multiple:true, saveData:true, dataColumn:'列名') 整列采集，
  或 attribute-value(attributeName:'href', ...) 读属性列；多列用相同序号自然对齐，
  不要手动展开 N 个节点。
- 若某步骤确实无法用声明式算子表达再考虑 javascript-code，并写明 justification；
  不要用代码节点绕过选择器问题。
```

## 已验证的站点选择器 / Verified selectors

在小红书探索页（`https://www.xiaohongshu.com/explore`）实测有效（2026-11-16，登录态）：

| 目标             | 选择器                       | 命中 | 说明                                                 |
| ---------------- | ---------------------------- | ---- | ---------------------------------------------------- |
| 笔记卡片作者昵称 | `a.author .name`             | 多篇 | 语义 class 稳定，整列采集                            |
| 笔记点赞数       | `.like-wrapper .count`       | 多篇 | 点赞区文本，整列采集                                 |
| 笔记链接         | `a.title[href*="/explore/"]` | 多篇 | 标题链接 href，可见带文本；读 `attributeName:'href'` |
| 笔记列表根容器   | `#exploreFeeds`              | 1    | 可作为 scope 前缀缩小范围                            |

反例（实测导致失败，禁止再用）：

- `div[id="exploreFeeds"] > section:nth-of-type(1) > div > div > div > a` — 位置选择器，重放失效
- `... > span > span:nth-of-type(2)` — 既位置选择又命中隐藏元素，get-text 读空
- 无 `waitForSelector` 紧跟 `new-tab` 的读取节点 — 页面脚本未渲染完就读

## 与 operator-guide 的关系 / Relationship to the built-in guide

`src/lib/workflow/operator-guide.ts` 的"可靠性要求"章节已经讲了稳定选择器原则，但**不足以阻止**模型在无人值守生成时选位置选择器——第一次实验就是在加载了该 guide 的情况下仍失败。区别在于本模板把规则写成了**生成请求里的硬性约束 + 具体正例/反例**，模型才会照做。

`operator-guide` 受 `MAX_INSTRUCTIONS_LENGTH = 9600` 限制且实测余量仅 62 字符（`tests/skills.spec.ts:212`），无法再塞入这段内容。因此固化路径是：

1. 本文作为仓库内可 review 的模板源（代码可追溯）。
2. 配套的运行时 skill `workflow-selector-discipline`（通过 `create_skill` 创建，按需加载，不占 guide 字数预算），在生成列表采集类工作流时自动匹配。

## 验收 / Verification

判断一条生成工作流是否遵守了本模板：

- 保存结果里 `saveWarnings` 不应出现 `LOCATOR_POSITIONAL` / `Ambiguous locator`。
- `verification` 应为 `passed (N/N steps)`，而非 `failed (M/N steps) — get-text 没有读到任何内容`。
- 若仍失败，按 trialRun.reason 的四步排查（选择器 / 渲染时机 / 标签页 / iframe）逐项对照上表。

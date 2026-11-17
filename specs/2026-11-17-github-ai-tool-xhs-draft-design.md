# GitHub AI 工具 → 小红书图文草稿工作流设计

## 目标 / Goal

用户要一个工作流：去 GitHub 发现好用的 AI 工具，生成一篇小红书图文草稿，说明这个工具的作用与适合人群，排版整洁；把工具名称/地址记录到本地配置的下载目录下的文件；下次运行按该文件过滤掉已发布过的工具。

**安全边界**：只生成图文草稿并写入本地文件，**不公开发帖、不发布**。这是用户明确选择的"生成内容存草稿"方案。

## 选型与证据 / Evidence (实测 2026-11-17)

| 决策 | 证据（一手实测 / 源码） |
| --- | --- |
| 用 `save_workflow` MCP 直接提交 JSON | `specs/2026-11-16-manual-workflow-authoring-mcp-design.md`；本轮实测 `save_workflow` 保存成功、0 warning |
| 真实测试走 `verify_workflow`（扩展侧桥接，真实 Chrome） | `list_tabs` 返回真实标签页；探针工作流 3/3 步通过（`verified:true`） |
| AI 用 `ai-agent(actOnPage:false)` 生成文案 | 探针中 ai-agent 步骤通过；扩展侧有免密钥 provider，无需 BC_LLM_* |
| 文件落"下载目录"用 `save-local` / `export-data`，读回用 `parse-excel(file-path)` | 探针 `save-local` 写入 `browser-data/bc-download-probe.txt` 成功；`docs/workflow/concepts.md`§Files |
| 下载目录 = `browser-data/` | 探针文件实测落点；同目录已有 `xhs-candidates.csv` |
| 去重台账用固定 CSV 文件名 | 与 `specs/2026-11-16-xiaohongshu-follow-workflow-split-design.md` 的台账闭环一致；`export-data` 覆盖写 + `parse-excel` 读回 |
| `javascript-code` 需在 http(s) 页上下文 | 探针首次失败原因："插件窗口内没有可操作的网页标签页"，加 `new-tab` 打开 GitHub 后通过 |
| Trending 采集选择器 | 实测 `article.Box-row`、`h2 a[href]`、`p.col-9`（描述）、`a[href$="/stargazers"]`（star）；`p` 会命中模板空节点，必须用 `p.col-9` |
| GitHub 搜索页作为第二来源做容错 | 搜索页是 React 新版、DOM 用 `_R_` hash class 且对 `run_javascript` 报 CSP；不放进主关键路径，采不到自动跳过 |
| 代码节点必须在触发 post 动作前 | 见节点顺序 |

## 数据流 / Data flow

1. Trending 页采集 → `candidateRows`（name/url/desc/stars/lang/source）
2. 搜索页采集（容错）→ 合并进 `candidateRows`
3. `parse-excel(file-path, ai-tools-ledger.csv)` → `publishedRows`（历史已发布）
4. JS 合并去重：按规范化 URL + 名称排除已发布 → 按标注 star 与描述质量打分 → 选 1 个 `selectedTool`
5. `ai-agent(prompt 注入工具信息, actOnPage:false)` → `xhsDraft`（小红书图文草稿）
6. `save-local` 写草稿 `xhs-drafts/<工具名>.md`
7. JS 生成新台账行 → `mergedLedger`（历史 + 新增）
8. `export-data(csv)` 覆盖写回 `ai-tools-ledger.csv`
9. 断言节点：草稿非空、台账含新工具 URL

## 去重主键 / Dedup key

- 工具唯一键：`repoUrl`（去掉查询串、统一小写）+ `name` 兜底。
- 首次运行台账为空（种子文件仅表头），全部候选可用。
- 第二次运行同一批候选被过滤，选下一个未发布工具——这是去重闭环的唯一验收点。

## 关键取舍 / Trade-offs

- 搜索页只作补充来源并容错：GitHub 搜索页 DOM 不稳定且 CSP 拦 `run_javascript`，若纳入关键路径会让整个工作流脆弱。Trending 单源已足够产出候选。
- `ai-agent actOnPage:false`：只生成文案、不在小红书页面点击填写，符合"存草稿不发"边界。
- 用 JS 代码节点做去重与打分：项目无"按主键判存"原生块（`condition`/`eq` 表达不了数组语义），这是设计文档已确认的正当能力缺口用法，节点带 `justification` + `capabilityGap`。

## 验收 / Verification（实测 2026-11-17，真实 Chrome）

工作流 id：`mwkixl56-4pzuhiyp`（13 节点），保存 0 warning。可恢复定义：`.workbuddy-ai/workflows/github-ai-tool-xhs-draft.json`。

- 第一遍 `verify_workflow`：`passed (12/12 steps)`，`verified:true`，runId `1c3280d0`。产出草稿 `xhs-drafts/2026-11-17-180305-univer.md`（标题/作用/适合人群/地址/话题标签齐全），台账写入 `univer` 1 行。
- 第二遍 `verify_workflow`：`passed (12/12 steps)`，`verified:true`，runId `46f0cfb8`。读到台账后**跳过 univer**，改选 `last30days-skill`，台账变 2 个不同工具，产出第二份草稿 `...-last30days-skill.md`。
- 结论：去重闭环成立（第二遍不重复发布同一工具），AI 文案质量合格（未编造数据），全文案仅本地落盘、未公开发布。
- 实测耗时：每遍约 93–102 秒，主要消耗在 3 次 GitHub 导航 + ai-agent 长 prompt 生成。
- 边界：用户选择"生成内容存草稿"，工作流全程用 `ai-agent(actOnPage:false)` + `save-local`/`export-data`，无发布/提交动作；`verify_workflow` 安全截止未触发。

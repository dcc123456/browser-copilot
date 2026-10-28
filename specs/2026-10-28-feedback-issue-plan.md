# 面板内反馈入口 · In-panel feedback that opens a GitHub issue

- 状态：计划（2026-10-28） / Status: planned (2026-10-28)
- 关联：`AGENTS.md` §2/§3/§5.2/§5.6/§7；`src/lib/marketplace/github-client.ts`；`src/lib/marketplace/token.ts`；`src/sidepanel/PublishWorkflowDialog.tsx`

## 需求 / Request

设置页新增一个反馈入口；点击后打开对话框，用户填写正文、按需附带诊断信息，提交即在 `dcc123456/browser-copilot` 创建 GitHub issue。

1. **必须连接 GitHub token 才能提交。** 对话框内嵌连接步骤，复用现有 `marketplaceAuth` 凭据（经典 `ghp_`，`public_repo`），不新增凭据存储。
2. **本期只支持文字。** 不做图片/附件；对话框按独立分区组织，后续加图片只需新增一段，不需要重写。
3. **诊断信息默认附带，可取消勾选。** 内容：扩展版本、构建号（`__BUILD_STAMP__`）、浏览器 UA、界面语言。
4. **目标仓库：`dcc123456/browser-copilot`。**

非目标：附件上传、issue 去重、标签管理、匿名提交、Runner 侧任何改动。

## 选型与证据 / Options and evidence

### 提交通道：REST 建 issue（采纳）

- 候选 A：打开预填的 `github.com/.../issues/new?title=&body=`。**否决**：依赖浏览器里的 GitHub 登录态；诊断信息只能拼进 URL；无法把创建结果（issue 号/链接）回传面板，也无法把失败转成可读错误。
- 候选 B：`POST /repos/{owner}/{repo}/issues`，经由现有 `GitHubClient`。**采纳**：该文件是仓库里唯一允许访问 `api.github.com` 的模块（§5.6），已有鉴权头、API 版本固定与 `MarketplaceError` 映射，`request()` 会自动补 `Content-Type` 并处理 204/错误体。
- 证据：GitHub REST 文档 `/repos/{owner}/{repo}/issues`（POST，201 返回 `number`/`html_url`；标题上限 256、正文上限 65 536 字符；仓库关闭 issues 时返回 410）。本机无法在计划阶段调用真实 API，接口形态以上述文档为准，实现后由单测断言请求形状。
- 匿名不可行：建 issue 必须携带 token；扩展内不能内置密钥。

### 凭据：复用 `marketplaceAuth`（采纳）

- 候选：新增 `feedbackAuth` 存储键。**否决**：§5.6 禁止再加一套凭据设施；同一枚经典 PAT 已能建 issue，再存一份只会让用户重复粘贴、让“断开”语义分叉。
- 代价：提交时 401 会清除这枚共享凭据，同时断开市场发布。该行为写入交付说明。

### 连接步骤抽取（采纳）

现有 `PublishWorkflowDialog.connect()` 已是“校验 `ghp_` → `GET /user` → `setAuth`”的实现；反馈对话框若照抄即第二份复制（§5.2）。因此：

- 新增 `src/lib/marketplace/connect.ts#connectMarketplaceToken`，纯逻辑、可注入 `fetchImpl`。
- 新增 `src/sidepanel/MarketplaceConnectPanel.tsx`，承载同一段连接控件，发布对话框与反馈对话框共用。
- `connectFailureText` 从 `PublishWorkflowDialog` 移入 `src/sidepanel/marketplace-errors.ts`（该模块的既有职责就是错误→文案），并补 `invalid` 分支。
- `TeamSharingCard` **不**接入：它存的是“每个仓库一份”的凭据，走 `resolveTeamConnection`（`GET /user` + 探测仓库），与这里的单凭据语义不同，强行统一会改变行为。

### issue 正文语言（采纳双语模板）

`AGENTS.md` §3 未对“程序生成、用户可见”的文本给豁免，且反馈者会在 GitHub 上读到自己发的内容，因此正文标题与诊断字段随界面语言切换（`Messages` 函数值 key）。维护者侧靠正文里的 `UI language:` 行判断语言。

### 上限

GitHub 允许标题 256 / 正文 65 536 字符；产品取 100 / 4 000，与仓库其它输入上限的量级一致。

### 图片（本期不做）

GitHub REST 没有图片上传接口；程序化贴图只能把字节提交到仓库分支再在正文内嵌 raw 链接。按本期决策不做，记录在案以免后续误以为漏实现。

## 设计 / Design

不新增持久化设置；对话框内的勾选状态与正文都是临时状态。

```
text + (diagnostics | null)
  → buildFeedbackIssue(t, …)        // 纯函数，src/lib/feedback/issue.ts
  → GitHubClient.createIssue(…)     // POST /repos/dcc123456/browser-copilot/issues
  → { number, html_url }            // 对话框内展示成功态 + 打开链接
```

- 标题：正文第一个非空行，去首尾空白、内部空白折叠，超 100 字符截断加 `…`；正文全空白时用 `feedbackIssueFallbackTitle`。
- 正文：勾选诊断 → `text` + `---` + 诊断列表（双语模板 `feedbackIssueBody`）；未勾选 → 就是 `text.trim()`，不套模板。
- 诊断读取时机：点击提交时（`collectFeedbackDiagnostics`），不在渲染时读取。
- 状态机：`idle → sending → sent`；`auth` 为 `undefined` 表示读取中，`null` 表示未连接。
- 提交按钮：`phase === 'idle' && auth && text.trim()` 才可用；`sending` 期间重复点击被守卫拦下。
- 失败：展示 `connectFailureText`；`unauthorized` 额外 `clearAuth()` 并回到连接态（死 token 重试无意义）。
- 成功：对话框内展示 `Issue #N` 与可点击链接，不用 toast（3.4 秒后链接就没了）。

### 隐私

issue 是公开的；诊断仅含版本、构建号、UA、界面语言，不含页面 URL、工作流内容或任何凭据。勾选框与提示文案是唯一的同意面。

## 文件与符号 / Files and symbols

| 文件                                        | 变更                                               |
| ------------------------------------------- | -------------------------------------------------- |
| `specs/2026-10-28-feedback-issue-plan.md`   | 本文件                                             |
| `src/lib/marketplace/connect.ts`            | 新增 `connectMarketplaceToken(rawToken, options?)` |
| `src/sidepanel/MarketplaceConnectPanel.tsx` | 新增连接控件组件                                   |
| `src/sidepanel/marketplace-errors.ts`       | 迁入 `connectFailureText`，补 `invalid` 分支       |
| `src/sidepanel/PublishWorkflowDialog.tsx`   | 删除内联连接状态/逻辑，改用面板；行为不变          |
| `src/lib/marketplace/github-client.ts`      | 新增 `GitHubCreatedIssue` 与 `createIssue`         |
| `src/lib/feedback/issue.ts`                 | 新增 `FEEDBACK_ISSUE_REPO`、上限、标题/正文构建    |
| `src/lib/feedback/diagnostics.ts`           | 新增 `collectFeedbackDiagnostics(locale)`          |
| `src/sidepanel/FeedbackCard.tsx`            | 新增设置卡片（只持有开关）                         |
| `src/sidepanel/FeedbackDialog.tsx`          | 新增反馈对话框                                     |
| `src/sidepanel/SettingsTab.tsx`             | 渲染 `<FeedbackCard />`                            |
| `src/lib/i18n.ts`                           | 新增 `feedback*` 文案（en + zh-CN + 接口）         |

## 测试 / Tests

- `tests/marketplace-connect.spec.ts`：非经典 token 不发网络请求；成功写入 `marketplaceAuth` 并带 Bearer 命中 `/user`；401 原样抛出且不落盘。
- `tests/marketplace-errors.spec.ts`：`connectFailureText` 的 `invalid`/`unauthorized`/普通 Error 分支（从发布对话框 spec 迁入）。
- `tests/marketplace-github-client.spec.ts`：`createIssue` 的 URL/方法/请求体/头；422 → `conflict`。
- `tests/feedback-issue.spec.ts`：标题规则（首行、空行、空白折叠、截断、兜底）；带/不带诊断的正文（中英文）；仓库常量；诊断采集。
- `tests/feedback-card.spec.tsx`：卡片静态渲染（中英文），初始不出现对话框。
- `tests/feedback-dialog.spec.tsx`：无凭据 → 连接面板 + 提交禁用；诊断默认勾选；提交仅一次且正文符合预期；取消勾选后无诊断块；成功展示链接；限流/401 分支；中文渲染。
- `tests/marketplace-publish-dialog.spec.tsx`：移除迁出的用例，原有连接断言作为抽取后的回归网。

## 验收口径 / Verification

```
pnpm typecheck
TZ=UTC pnpm test
pnpm lint
pnpm format:check
pnpm build
pnpm server:typecheck
```

无需 `server:test` / `bench:debug` / `verify:injected`：未触及引擎、注入函数或 Runner 实现。

真实浏览器手工验证见计划文件；拿不到实证的条目标 BLOCKED。

## 风险 / Risks

- **410（仓库关闭 issues）** 会被共享映射器归到 `network`（“GitHub returned 410”），文案不精确；仓库当前开启 issues，改共享映射超出本期范围。
- **二级限流** 若不带 `x-ratelimit-remaining: 0` 会落到 `forbidden`，文案是“GitHub refused the request”。
- **重复 issue**：POST 成功但响应丢失后重试会再建一条；本期不做去重（搜索去重花配额且有竞态）。
- **死 token**：401 会清除共享凭据，市场发布随之断开。
- **标题截断**可能切开代理对；若评审提出，改为按码点切片。
- **并发改动**：工作树可能被其它主题同时在改；提交前 `git status`，只暂存本主题文件与 hunk。

## 落地偏差 / Deviations

| 计划                         | 实现                                                 | 原因                                                                                     |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 计划未列 `feedbackTextLabel` | 新增该 key，作为 textarea 的可见标签                 | 无标签的 textarea 对读屏不友好                                                           |
| 诊断信息“提交时读取”         | 提示文案用 `useMemo` 预览版本/构建号，提交时再读一次 | 让用户看到的内容与实际发出的内容一致                                                     |
| 校验面板用 Tailwind 布局     | 复用 `.checkbox` 类并加 `items-start!`               | 全局 `label` 规则未分层，会覆盖分层里的 `flex`；`.checkbox` 本就是设置卡片内的复选框样式 |
| 计划只靠按钮禁用防重复提交   | 额外用 `sendingRef` 同步守卫                         | 同一 React 批次内的两次点击都会看到旧的 `phase`                                          |

真实浏览器验证：Playwright 加载 `dist/`，在面板里进入设置 → 反馈，确认对话框、禁用态、默认勾选与非法 token 的内联报错（无网络请求）。真实创建 issue 未验证——需要用户的 token，且不应在未授权时创建线上 issue。

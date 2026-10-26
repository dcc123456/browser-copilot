# Workflow marketplace over Git PRs (zero server) · Plan

日期：2026-10-25
设计：`specs/2026-10-25-workflow-marketplace-design.md`
分支：`feat/workflow-marketplace`（按要求新开，不直接提交 main）

## 0. 范围回顾

1. 工作流卡片“发布” → 弹窗 → 提交 PR 到 `dcc123456/BC-workflow`，维护者手动合并。
2. “更多”菜单新增“工作流广场” → 卡片流 → 应用 / 已添加 / 可更新。
3. 点赞、评论写回该工作流对应的已合并 PR。
4. 全部读取只依赖：`git/trees` + `pulls?state=closed` + `issues`（3 次 API 调用）+ raw CDN。
5. 不引入服务器、Actions、OAuth App；写操作使用用户自备 classic PAT（`public_repo`）。

## 1. 实施顺序

按“纯逻辑 → 网络层 → 写路径 UI → 读路径 UI → 互动 → 提醒”推进；每步独立通过门禁，便于回滚。

### Step 1 — 纯逻辑与类型（可离线验证）

| 文件                                 | 动作 | 内容                                                                                                                                    |
| ------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/marketplace/types.ts`       | 新增 | `MARKETPLACE_REPO`、`MarketplaceMeta`、`MarketplaceCard`、`WorkflowMarketplaceRef`、`MarketplaceErrorCode`、`DEFAULT_CHECK_INTERVAL_MS` |
| `src/lib/marketplace/slug.ts`        | 新增 | `slugify`、`buildSlug(name, hash)`、`isValidSlug`；非 ASCII 名称退化 `wf`；碰撞时加长 hash                                              |
| `src/lib/marketplace/sanitize.ts`    | 新增 | `toPublishableWorkflow(workflow, {slug})`：剥离本地/运行时字段、`plan`、data URL；返回 `warnings`（疑似凭据字面量）                     |
| `src/lib/marketplace/meta.ts`        | 新增 | `workflowHash`（`crypto.subtle` 注入）、`buildMeta`、`parseMeta`（严格白名单，拒绝未知/缺字段）、`isNewerThan`                          |
| `src/lib/workflow/types.ts`          | 修改 | `Workflow` 增加可选 `marketplace?: WorkflowMarketplaceRef`                                                                              |
| `src/lib/workflow/storage.ts`        | 修改 | `asWorkflow` 白名单增加 `marketplace`（校验 repo/slug/version/hash），否则保存时被静默丢弃                                              |
| `tests/marketplace-slug.spec.ts`     | 新增 | ASCII/中文/空名/碰撞/非法字符                                                                                                           |
| `tests/marketplace-sanitize.spec.ts` | 新增 | 本地字段、settings 重置、pageContext/trialRun/goalVerification/plan、data URL、凭据告警                                                 |
| `tests/marketplace-meta.spec.ts`     | 新增 | hash 稳定、非法 meta 拒绝、版本比较                                                                                                     |
| `tests/workflow-storage.spec.ts`     | 回归 | `marketplace` 字段持久化与非法值丢弃                                                                                                    |

**验收**：`pnpm typecheck && pnpm test`，新增与回归全绿。

### Step 2 — token 与 GitHub 客户端

| 文件                                      | 动作 | 内容                                                                                                                                               |
| ----------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/marketplace/token.ts`            | 新增 | `getToken` / `setToken` / `clearToken`；`marketplaceAuth`；只接受 `ghp_` 前缀；写后回读校验                                                        |
| `src/lib/fs-store.ts`                     | 修改 | `CONFIG_KEYS` 增加 `marketplaceAuth`（永不进入数据目录）                                                                                           |
| `src/lib/marketplace/github-client.ts`    | 新增 | 注入 `fetch`；`request<T>(path, init)`；把 401/403(限流)/404/422 映射为 `MarketplaceError`；`validateToken()` 走 `GET /user`；`RateLimitInfo` 解析 |
| `tests/marketplace-token.spec.ts`         | 新增 | 前缀校验、存取、清理（mock `chrome.storage.local`）                                                                                                |
| `tests/marketplace-github-client.spec.ts` | 新增 | 错误码映射、限流头解析、Authorization 头、非 JSON 响应                                                                                             |

**验收**：`pnpm typecheck && pnpm test`；`rg "api.github.com" src` 只出现于 `github-client.ts`（单一出口）。

### Step 3 — 发布编排（写路径核心）

| 文件                                | 动作 | 内容                                                                                                                                        |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/marketplace/publish.ts`    | 新增 | `publishWorkflow(input)`：slug/版本判定 → 确保 fork（轮询 ≤30 s）→ 建分支 → PUT meta/workflow/assets → 开 PR；返回 `{prUrl, slug, version}` |
| `tests/marketplace-publish.spec.ts` | 新增 | 完整 happy path（断言调用序列与 base64 体）、fork 已存在、fork 轮询、422 重试一次、slug 冲突拒绝、图片超限拒绝                              |

**验收**：mock fetch 下单测覆盖所有分支；不触达真实 GitHub。

### Step 4 — 发布 UI

| 文件                                      | 动作 | 内容                                                                                                                                                                            |
| ----------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sidepanel/PublishWorkflowDialog.tsx` | 新增 | `FormDialog` 外壳；字段校验；图片选择/压缩（`createImageBitmap` + `OffscreenCanvas`，长边 1600、WebP 0.85、单张 ≤1 MB、≤3 张）；token 内联连接区；发布中/成功（PR 链接）/失败态 |
| `src/sidepanel/WorkflowsTab.tsx`          | 修改 | 卡片操作行增加“发布”按钮 + 弹窗状态；发布成功后 toast                                                                                                                           |
| `src/sidepanel/styles.css`                | 修改 | 仅当现有 class 不足以承载新布局时新增；优先 Tailwind 语义 token                                                                                                                 |
| `src/lib/i18n.ts`                         | 修改 | 新增 key（en + zh-CN 双侧）：弹窗字段、校验错误、token 指引、状态文案                                                                                                           |

**验收**：UI 单测（字段校验、图片超限、无 token 时停在连接区）；手动加载扩展截图为证据。

### Step 5 — 目录读取与应用（读路径核心）

| 文件                                | 动作 | 内容                                                                                                                                                         |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/marketplace/catalog.ts`    | 新增 | `loadCatalog({force})`：tree + pulls + issues 合并；`slug ↔ PR number`；raw 拉 meta/图片；30 分钟节流（`marketplaceLastCheck`）；分页上限 3 页；失败回退缓存 |
| `src/lib/marketplace/apply.ts`      | 新增 | `applyWorkflow(card, existing)`：`parseMeta`+`asWorkflow`+`migrateWorkflow`；新 id/时间戳；`marketplace` 引用；返回“已存在/可更新/新增”判定                  |
| `tests/marketplace-catalog.spec.ts` | 新增 | 三路合并、未合并 PR 过滤、删除的 slug、meta 损坏、分页、节流、缓存回退                                                                                       |
| `tests/marketplace-apply.spec.ts`   | 新增 | 去重、id 重生成、版本判断、非法内容拒绝                                                                                                                      |

**验收**：单测全绿；同一 slug 连续应用两次只产生一条本地记录。

### Step 6 — 广场页

| 文件                               | 动作 | 内容                                                                                            |
| ---------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `src/sidepanel/MarketplaceTab.tsx` | 新增 | 卡片流、搜索、分类筛选、排序（最新/最多赞）、加载/空/错误态、信任确认弹窗、“在 GitHub 查看”链接 |
| `src/sidepanel/App.tsx`            | 修改 | `TabId` 增加 `marketplace`；`MORE_TABS` 增加一项；`TAB_LABEL` 映射                              |
| `src/lib/i18n.ts`                  | 修改 | 广场页全部文案（en + zh-CN）                                                                    |

**验收**：`pnpm build` 通过；侧边栏“更多”中出现入口；空仓库时显示空状态而非报错。

### Step 7 — 点赞与评论

| 文件                                   | 动作 | 内容                                                                                                                         |
| -------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/marketplace/engagement.ts`    | 新增 | `toggleLike`（POST reaction / DELETE 已记录的 reaction id）、`listComments`、`postComment`；未连接 token 时返回 `needs-auth` |
| `src/sidepanel/MarketplaceTab.tsx`     | 修改 | 详情面板：评论列表、输入框、点赞按钮；无 token 时按钮变“在 GitHub 参与”                                                      |
| `tests/marketplace-engagement.spec.ts` | 新增 | reaction id 记录、取消点赞、分页、401 清理 token                                                                             |

**验收**：单测全绿；无 token 路径不发写请求。

### Step 8 — 更新提醒

| 文件                                                 | 动作 | 内容                                                                                |
| ---------------------------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `src/lib/workflow/workflow-revision.ts` / `types.ts` | 修改 | revision source 联合类型增加 `'marketplace'` 与 `'marketplace-update'`              |
| `src/sidepanel/WorkflowsTab.tsx`                     | 修改 | 打开面板时节流检查已装工作流版本；卡片显示“可更新”；更新走二次确认 + `apply.update` |
| `tests/marketplace-update.spec.ts`                   | 新增 | 版本/来源删除/本地修改不被误判（以 `marketplace.version` 为准）                     |

**验收**：离线场景不报错；同一份远端版本不重复提示。

### Step 9 — 目标仓库初始化（需单独授权）

这一步会写 `dcc123456/BC-workflow`，**必须等用户明确同意**后执行：

- `README.md`：目录约定、如何发布、审核规则。
- `workflows/.gitkeep`、`CONTRIBUTING.md`、PR 模板。
- 可选 `scripts/validate-workflow.mjs`（维护者本地校验，不依赖 Actions）。

### Step 10 — 重新编辑与下架（2026-10-25 追加）

| 文件                                              | 动作 | 内容                                                                                  |
| ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `src/lib/marketplace/github-client.ts`            | 修改 | `deleteFile`（`DELETE /contents/<path>`，带 sha 与分支）                              |
| `src/lib/marketplace/publish.ts`                  | 修改 | `unpublishWorkflow`：读树 → 定位 `workflows/<slug>/` 全部 blob → 删文件分支 → 下架 PR |
| `src/lib/marketplace/raw.ts`                      | 修改 | `fetchPublishedAsset`：把已发布截图取回为 Blob，供重新编辑预填                        |
| `src/lib/marketplace/apply.ts`                    | 修改 | `removedSources`：仅在目录完整且非 stale 时标记“来源已删除”                           |
| `src/lib/messages.ts` / `src/background/index.ts` | 修改 | `workflows.marketplace`：发布回写引用，只改元数据、不 bump revision                   |
| `src/lib/workflow/storage.ts`                     | 修改 | `saveWorkflow` 增加 `touchUpdatedAt: false`：元数据写入不更新排序时间戳               |
| `src/sidepanel/PublishWorkflowDialog.tsx`         | 修改 | 有 `marketplace` 引用时按已发布 meta 预填；首个输入后放弃预填                         |
| `src/sidepanel/WorkflowsTab.tsx`                  | 修改 | 发布成功回写引用；列表显示“来源已删除”                                                |
| `src/sidepanel/MarketplaceTab.tsx`                | 修改 | 自己发布的卡片显示“取消发布”，确认后提交删除 PR                                       |
| `tests/marketplace-publish.spec.ts`               | 修改 | 删除全部分文件、slug 不存在不建分支、分支冲突重试、无 token                           |
| `tests/marketplace-update.spec.ts`                | 修改 | 完整/截断/stale、非同仓库引用、无引用工作流                                           |
| `tests/marketplace-publish-dialog.spec.tsx`       | 修改 | 预填已发布信息与图片；预填返回前的手动输入不被覆盖                                    |
| `tests/workflow-storage.spec.ts`                  | 修改 | `touchUpdatedAt: false` 保留 `updatedAt`，默认写入仍打时间戳                          |

**验收**：发布成功后本地出现 `marketplace` 引用；再次发布沿用同一 slug 且版本 +1；自己的卡片可提交删除 PR（合并后消失）；完整目录下缺失的 slug 显示“来源已删除”。

### Step 11 — 细分分类与自定义分类（2026-10-26 追加）

| 文件                                                                                                                   | 动作 | 内容                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `src/lib/marketplace/types.ts`                                                                                         | 修改 | 内置分类扩到 15 个；`MAX_CATEGORY_CHARS`；`category` 类型放宽为字符串      |
| `src/lib/marketplace/categories.ts`                                                                                    | 新增 | 规范化、大小写不敏感比较、内置标签翻译、筛选选项（内置 + 目录自定义）      |
| `src/lib/marketplace/meta.ts`                                                                                          | 修改 | `buildMeta` 接受自定义分类并规范化；`parseMeta` 保留未知标签，空值回退其他 |
| `src/lib/marketplace/form.ts`                                                                                          | 修改 | 发布表单要求分类非空（`category-required`）                                |
| `src/lib/i18n.ts`                                                                                                      | 修改 | 9 个新内置分类英文/中文标签 + 自定义分类输入与错误文案                     |
| `src/sidepanel/PublishWorkflowDialog.tsx`                                                                              | 修改 | 分类下拉新增「自定义…」并展开文本框；预填已发布的自定义分类                |
| `src/sidepanel/MarketplaceTab.tsx`                                                                                     | 修改 | 筛选项来自内置分类 + 目录中出现的自定义标签；按 `categoryKey` 匹配         |
| `tests/marketplace-categories.spec.ts`                                                                                 | 新增 | 规范化/去重/排序/翻译                                                      |
| `tests/marketplace-{meta,form}.spec.ts`、`tests/marketplace-publish-dialog.spec.tsx`、`tests/marketplace-tab.spec.tsx` | 修改 | 自定义分类保留与规范化、空分类拒绝、自定义输入与预填、新标签渲染           |

**验收**：发布弹窗可选 15 个细分类之一或自填分类；自填分类随 `meta.json` 提交并在广场筛选里出现（不翻译）；空名称无法发布；重新编辑自定义分类的工作流时，下拉为「自定义…」且文本框带回原值；旧数据（未知分类）仍显示为「其他」。

### Step 12 — 被调用的工作流随发布打包（2026-10-26 追加）

| 文件                                                                                                                                | 动作 | 内容                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/node-params.ts`                                                                                                   | 新增 | `nodeBlockId` / `nodeParams`；引擎与依赖扫描共用一份读取逻辑                                      |
| `src/background/workflow-engine/engine.ts`                                                                                          | 修改 | 删除本地 `blockIdOf` / `paramsOf`，改为 import 共享实现                                           |
| `src/lib/marketplace/types.ts`                                                                                                      | 修改 | `MAX_BUNDLE_WORKFLOWS = 20`；`MarketplaceDependency`；`MarketplaceMeta.dependencies?`             |
| `src/lib/marketplace/meta.ts`                                                                                                       | 修改 | `dependencyPath` / `dependencyFile`、`buildMeta` 规范化与校验、`parseMeta` 严格解析               |
| `src/lib/marketplace/dependencies.ts`                                                                                               | 新增 | `workflowCalls`、`collectDependencies`（后序、去重、环剪枝、缺件）、`rewriteWorkflowCalls`        |
| `src/lib/marketplace/sanitize.ts`                                                                                                   | 修改 | `PublishWarning.workflow` 标注警告来自哪个被打包的工作流                                          |
| `src/lib/marketplace/publish.ts`                                                                                                    | 修改 | `PreparePublishOptions.library`；阻断缺件/超量；dep 文件与 `meta.dependencies`；PR 正文 bundle 行 |
| `src/lib/marketplace/apply.ts`                                                                                                      | 修改 | `publishedDependencies` 校验、确定性本地 id、调用重写、就地替换、`up-to-date` 不装东西            |
| `src/lib/marketplace/raw.ts`                                                                                                        | 修改 | `fetchWorkflowAt(path)`；`fetchPublishedWorkflow` 复用之                                          |
| `src/sidepanel/marketplace-install.ts`                                                                                              | 修改 | 先取父工作流与全部 dep 文件，再统一 `planApplyBundle`，依赖先保存、父工作流最后保存               |
| `src/lib/i18n.ts`                                                                                                                   | 修改 | 9 个新 key（发布弹窗 bundle 段、缺件/超量、按工作流标注的警告、卡片角标、信任/更新确认）          |
| `src/sidepanel/PublishWorkflowDialog.tsx`                                                                                           | 修改 | `library` 属性；调用列表、缺件/超量错误行；警告文案带工作流名                                     |
| `src/sidepanel/WorkflowsTab.tsx` / `MarketplaceTab.tsx`                                                                             | 修改 | 传入 `library`；信任/更新确认列出被打包的工作流；卡片显示「含 N 个」角标                          |
| `tests/marketplace-dependencies.spec.ts`                                                                                            | 新增 | 调用读取、传递顺序、共享、环、自调用、动态目标、同名文件、重写不改原对象                          |
| `tests/marketplace-publish.spec.ts`、`marketplace-apply.spec.ts`、`marketplace-meta.spec.ts`、`marketplace-publish-dialog.spec.tsx` | 修改 | 打包提交与 meta、缺件阻断、警告归属、PR 正文、id 映射与就地替换、整包校验、弹窗列表与阻断         |

**验收**：发布一个调用其它工作流的工作流时，弹窗列出将随行的工作流；合并后仓库中出现 `workflows/<slug>/deps/*.json` 且 `meta.json` 带 `dependencies`；另一个本地库应用该卡片后，父工作流的 `execute-workflow` 步骤指向 `mkt-<slug>-<file>`，被调用工作流以同一 id 落库且不自动运行；再次更新替换同一份副本；缺少被调用工作流时无法发布。

### Step 13 — 发布附件（≤200 KB，2026-10-26 追加）

| 文件                                                          | 动作 | 内容                                                                                                                                |
| ------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/marketplace/attachments.ts`                          | 新增 | 文件名净化、`attachments/` 路径白名单、同名去重、`formatAttachmentSize`                                                             |
| `src/lib/marketplace/types.ts`                                | 修改 | `MAX_PUBLISH_ATTACHMENTS = 3`、`MAX_PUBLISH_ATTACHMENT_BYTES = 200 KB`、`MarketplaceAttachment`、`PublishAttachment`、meta 可选字段 |
| `src/lib/marketplace/meta.ts`                                 | 修改 | `buildMeta` 严格校验数量/大小/路径；`parseMeta` 按条丢弃非法附件                                                                    |
| `src/lib/marketplace/form.ts`                                 | 修改 | `too-many-attachments` / `attachment-too-large`                                                                                     |
| `src/lib/marketplace/publish.ts`                              | 修改 | 校验附件、提交 `attachments/*`、meta 记录、PR 正文附件行                                                                            |
| `src/lib/i18n.ts`                                             | 修改 | 弹窗附件字段/提示/错误、卡片附件链接与大小文案（en + zh-CN）                                                                        |
| `src/sidepanel/PublishWorkflowDialog.tsx`                     | 修改 | 附件选择与移除、大小提示、预填已发布附件、`preparePublish` 入参                                                                     |
| `src/sidepanel/MarketplaceTab.tsx`                            | 修改 | 卡片列出附件链接（raw 地址，新标签页打开）                                                                                          |
| `tests/marketplace-attachments.spec.ts`                       | 新增 | 净化/去重/白名单/大小显示                                                                                                           |
| `tests/marketplace-card-attachments.spec.tsx`                 | 新增 | 卡片附件链接指向 raw 文件                                                                                                           |
| `tests/marketplace-{meta,form,publish,publish-dialog}.spec.*` | 修改 | meta 往返与拒收、表单错误、提交字节与 PR 正文、弹窗字段与预填                                                                       |

**验收**：发布弹窗可选 ≤200 KB 的附件（最多 3 个），超限立即报错且不联网；发布后 PR 中出现 `workflows/<slug>/attachments/<file>`，`meta.json` 有 `attachments`；广场卡片显示附件链接并能打开原始文件；再次编辑能带回已发布附件。

## 2. 测试与门禁

- 每步：`pnpm typecheck && pnpm test && pnpm lint && pnpm format:check`。
- UI/构建改动：`pnpm build`（必要时 `pnpm build:no-ocr`）。
- 不新增 `executeScript({func})` 内联函数的前提下无需 `pnpm verify:injected`；若后续为压缩图片引入注入函数则必须补跑。
- 真实端到端（发布 → 合并 → 广场 → 应用 → 点赞/评论）需要用户提供 PAT 和目标仓库写权限；在此之前如实标记 **BLOCKED**，不宣称通过。
- 所有网络层测试使用注入的 mock `fetch`，CI 不访问 GitHub。

## 3. 文件清单总览

```
新增
  src/lib/marketplace/{types,slug,sanitize,meta,token,github-client,publish,catalog,apply,engagement}.ts
  src/sidepanel/MarketplaceTab.tsx
  src/sidepanel/PublishWorkflowDialog.tsx
  tests/marketplace-*.spec.ts
修改
  src/lib/workflow/types.ts            Workflow.marketplace
  src/lib/workflow/storage.ts          asWorkflow 白名单
  src/lib/workflow/workflow-revision.ts  revision source 取值
  src/lib/fs-store.ts                  CONFIG_KEYS += marketplaceAuth
  src/lib/i18n.ts                      en + zh-CN 文案
  src/sidepanel/App.tsx                “更多”入口
  src/sidepanel/WorkflowsTab.tsx       发布按钮 + 可更新标记
```

## 4. 提交计划（全部英文 Conventional Commits）

1. `feat(marketplace): add publish metadata model and sanitizer`
2. `feat(marketplace): add github client and local token store`
3. `feat(marketplace): open a workflow PR from the panel`
4. `feat(marketplace): browse and apply shared workflows`
5. `feat(marketplace): add likes and comments`
6. `feat(marketplace): flag installed workflows with updates`

每个提交都保持 `typecheck` / `test` 通过；不混入无关改动；推送前 `git status` 确认只包含本主题文件。

## 5. 风险与开放项

- **rate limit**：3 次/刷新是硬预算；任何新增读取都必须并入这三路，不另开轮询。
- **token 安全**：PAT 等同密码；只允许 `ghp_` classic token，UI 明示 `public_repo` 范围与撤销路径。
- **第三方执行风险**：信任确认不可省略；更新覆盖本地修改必须二次确认。
- **目标仓库尚未初始化**：真实端到端在此之前为 BLOCKED。
- **Fine-grained PAT 不支持**：需要时另立设计（可能要求 OAuth App 或 GitHub App）。

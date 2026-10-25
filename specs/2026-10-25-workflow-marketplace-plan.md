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

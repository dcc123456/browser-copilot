# 团队工作流共享（私有 GitHub 仓库）设计

- 日期：2026-10-27
- 状态：已实现（2026-10-27）；单仓库约束已被 `specs/2026-10-28-team-multi-repo-design.md` 取代（缓存键现为 `teamCatalog:<owner>/<repo>`）
- 相关：`specs/2026-10-25-workflow-marketplace-design.md`、`src/lib/marketplace/**`

## 1. 背景与目标

公共工作流广场（`dcc123456/BC-workflow`）把工作流分享给所有安装本扩展的用户。团队场景需要
一个只对团队成员可见的共享空间：团队账号下建一个 **私有仓库**，把成员加成仓库协作者，成员在
扩展里用自己的 GitHub token 连上这个仓库，即可浏览、应用、发布团队工作流。

目标：

1. 在工作流广场内切换「公共广场 / 团队共享」两个来源，复用同一套列表、应用、发布代码。
2. 发布到私有仓库走 PR：成员推分支开 PR，有 push 权限的成员自动合并，其他人等维护者合并。
3. 团队仓库地址与访问 token 在设置页配置，与公共广场的 token 分开保存。
4. 访问控制完全交给 GitHub：能读仓库的协作者才能看到列表，有 push 权限才能发布。

非目标：

- 不自建服务器、不做 OAuth App、不做组织级权限管理界面。
- 不做跨仓库的「公共+团队合并视图」。
- 不在团队视图里做点赞/评论（公共广场的互动逻辑保持原样，团队视图不读取 issues/pulls 计数）。

## 2. 决策（用户已确认）

| 决策点   | 结论                                                        |
| -------- | ----------------------------------------------------------- |
| 入口形态 | 工作流广场内切换「公共 / 团队」，不新增独立 tab             |
| 发布方式 | 同仓库分支 + PR；token 有 push 权限时自动合并               |
| 配置位置 | 设置页新增「团队共享」；独立 classic PAT（需 `repo` scope） |

## 3. 访问与安全模型

- 仓库由用户手动创建（私有、可为空仓库），并邀请成员为 collaborator。
- 每位成员在设置页填自己的 classic PAT（`ghp_`，`repo` scope）。token 只存
  `chrome.storage.local`（`CONFIG_KEYS`，不进入用户数据目录），UI 只显示末四位，绝不导出或写日志。
- 读取私有仓库一律走 `api.github.com` 且带 token：`raw.githubusercontent.com` 不接收 Authorization
  头，无法用于私有内容。见官方文档 `GET /repos/{owner}/{repo}/contents/{path}` 的
  `Accept: application/vnd.github.raw+json` 与 `ref` 参数。
- 认证用户配额 5000 次/小时，远高于匿名 60 次/小时；团队目录刷新 = 1 次 tree + 每个工作流 1 次
  meta，交给 2 小时快照缓存摊薄。应用时再按需取 workflow.json / 依赖 / 附件。

## 4. 技术方案

### 4.1 仓库描述符

`src/lib/marketplace/repo.ts`（新模块，理由：把 owner/repo/branch/private 从常量提升为参数，避免在
catalog/raw/publish/apply 里各复制一套私有分支）：

```ts
export interface RepoRef {
  owner: string
  repo: string
  branch: string
  isPrivate: boolean
}
export const PUBLIC_REPO: RepoRef // dcc123456/BC-workflow, main, 公开
export function repoFullName(ref: RepoRef): string // `${owner}/${repo}`
```

所有读取/发布入口接收 `RepoRef`，公共路径行为与现在完全一致。

### 4.2 文件读取

`src/lib/marketplace/raw.ts` 泛化为按仓库读取：

- 公共：沿用 `raw.githubusercontent.com`（零 API 配额），保留 `?v=<ts>` 只用于 meta 防 CDN 404 缓存。
- 私有：`GET /repos/{o}/{r}/contents/{path}?ref=<branch>`，`Accept: application/vnd.github.raw+json`；
  404 → 返回 null（文件不存在/无权限统一按不存在处理）。
- 新增 `fetchRepoText / fetchRepoMeta / fetchRepoWorkflow / fetchRepoWorkflowAt / fetchRepoAsset`，
  `{ token, fetchImpl }` 作为访问参数。原公开函数改为 `PUBLIC_REPO` 之上的薄封装，调用方逐步迁移。
- `GitHubClient` 增加 `getRawFile(owner, repo, path, ref)`、`getRawBlob(...)`，复用现有的错误映射与
  API 版本头，不新建第二个 GitHub 客户端（§5.6）。

私有卡片封面图/附件不能用作 `<img src>` 的直链：按需取 blob 生成 object URL（封面），附件点击时取
blob 触发下载。

### 4.3 目录读取与缓存

`readCatalog` 增加 `repo: RepoRef` 参数：

- tree/pulls/issues 全部用 `repo` 代替常量。
- 团队来源传 `includeEngagement: false`：跳过 pulls/issues 两页请求，卡片不显示点赞/评论。
- meta 读取用仓库感知的 `fetchRepoMeta(repo, slug, { token })`。
- 缓存按来源分开：公共仍用 `marketplaceCatalog`，团队用 `teamCatalog`（`chromeCatalogCache(key)` 参数化），
  避免一个来源的失败/截断污染另一个来源的更新检测。

### 4.4 发布与下架

`pushPublish` / `unpublishWorkflow` 增加 `repo: RepoRef`：

- 公共：保持现有 fork 逻辑（`writableOwner`）。
- 团队：不 fork，分支直接推在私有仓库本身；`createPull` 的 `head` 用分支名（同仓库 PR）。
- 「有 push 权限自动合并」：沿用 `tryMergePublish`，405/409 重试一次，403 保持 PR 等待维护者。
- PR 正文的结束语按来源变化：公共「对所有人可见」，团队「对仓库成员可见」。
- 发布结果写入 `workflow.marketplace.repo = repoFullName(repo)`；下次更新检测按 repo + slug 匹配。

### 4.5 应用与更新检测

- `installFromCard` 增加 `source = { repo, token }`，按来源读取 workflow.json、依赖、凭据引用；
  其余写入顺序（密钥库 → 子工作流 → 父工作流）不变。
- `findInstalled` / `pendingUpdates` / `removedSources` / `marketplaceRef` 改为按 `repoFullName` 匹配，
  公共与团队同名 slug 不会互相误判。
- `WorkflowsTab` 的更新提醒：公共目录照旧；配置了团队仓库且 token 可读时，再读一次团队目录并合并
  更新结果（失败静默，保持现有「未验证不提示」的约定）。

### 4.6 设置页「团队共享」

存储：

```ts
teamRepo: {
  owner: string
  repo: string
} // 非敏感
teamRepoAuth: {
  token: string
  login: string
} // 敏感，仅本地
```

连接流程：输入 `owner/repo` 与 classic PAT → `GET /user` 取 login → `GET /repos/{o}/{r}` 校验：

- 404 → 「仓库不存在或没有访问权限」；
- `private !== true` → 提示这是公开仓库（允许连接，但明确告知团队内容会公开）；
- `permissions.push === false` → 允许连接（只读成员），发布按钮提示需要 push 权限。

断开只清 token 与仓库地址，不影响已安装工作流。

### 4.7 广场 UI

- 顶部来源切换（分段按钮）：公共广场 / 团队共享；默认公共。
- 团队未配置 → 空状态说明并指引到设置页；配置了但读取失败（401/403/404）→ 明确提示 token 或权限问题。
- 卡片：标题、作者、分类、标签、描述、附件、更新/已应用状态与公共一致；点赞/评论图标在团队来源下隐藏。
- 「在 GitHub 查看」与 PR 链接指向团队仓库；下架按钮仅对本人的发布显示（沿用 `isMine`）。

### 4.8 发布弹窗

- 新增「发布到」选择：公共广场 / 团队共享（团队未配置时禁用并提示去设置）。
- 公共使用现有 marketplace token；团队使用 `teamRepoAuth`。选择团队时若未连接，显示禁用与设置指引。
- 其余（标题、分类、标签、截图、附件、凭据字段、草稿）完全复用；草稿按目标来源分别保存，避免把
  团队仓库的凭据字段草稿带到公共发布。

## 5. 兼容性与风险

- 未配置团队仓库时：公共广场、工作流更新提醒、发布流程行为与当前版本一致。
- 已安装工作流的 `marketplace.repo` 已存在，历史记录默认是公共仓库，无需迁移。
- 私有仓库读取会消耗认证配额；快照 TTL 2 小时 + 应用时按需读取，正常使用远低于 5000/h。
- 私有附件不再有可直接打开的网页链接，改为下载；这是私有内容不出现在公共 CDN 的代价。
- token 被吊销/过期时，团队视图给出「授权失效」提示，而不是空白页。

## 6. 验收清单

1. 设置页可保存/校验/断开团队仓库；非私有仓库有提示；只读成员可连接但发布被阻止。
2. 广场切换来源后，团队卡片来自私有仓库；公共卡片、点赞/评论不受影响。
3. 应用团队工作流：导入凭据、子工作流引用改写、分组入组与公共一致。
4. 发布到团队：同仓库分支 + PR，PR 正文措辞正确；有 push 权限时自动合并；无 push 时 PR 保持打开。
5. 更新提醒同时覆盖公共与团队来源，且不会把另一个仓库的同名 slug 当作更新。
6. 真实 Chrome 探针：stub `api.github.com`（含 contents 原始内容接口）验证连接、切换、应用、发布。
7. 门禁：`pnpm typecheck`、`TZ=UTC pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全绿。

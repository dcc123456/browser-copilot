# Workflow marketplace over Git PRs (zero server) · Design

日期：2026-10-25
范围：侧边栏工作流面板的“发布”、新增“工作流广场”页、应用/更新、点赞/评论。
目标仓库：`dcc123456/BC-workflow`（公开，当前为空）。
分支：`feat/workflow-marketplace`。

## 1. 目标与非目标

**目标**

- 工作流卡片新增“发布”：弹窗填写标题/描述/分类/标签、上传 ≤3 张截图、填视频外链，提交为一个 PR 到 `dcc123456/BC-workflow`，由维护者手动合并。
- “更多”菜单新增“工作流广场”：卡片流展示已合并的工作流，支持搜索/分类筛选、应用、点赞、评论。
- 应用后写入本地工作流库，并以 `marketplace` 引用去重；远端版本变化时在本地列表中提示“可更新”。
- 点赞/评论写回该工作流对应的 PR（issue comments / reactions）。
- 不依赖任何自建服务器、不依赖 GitHub Actions、不注册 OAuth App。

**非目标**

- 不做自动合并；PR 永远由维护者手动 review + merge。
- 不把视频存进 git（只存外链）；不托管图片在 git 之外。
- 不自动运行从广场导入的工作流，不自动信任第三方工作流。
- 不做即时推送通知；更新提醒在侧边栏打开时按节流检查。
- 不做作者主页、关注、评分、收藏夹等社交功能。

## 2. 选型与证据

### 2.1 候选方案与否决理由

| 方案                                                | 结论     | 理由                                                                                |
| --------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| 自建后端（DB + 对象存储 + WebPush）                 | 否决     | 违反“不新建服务器”；点赞/评论/媒体都可以用 GitHub 原生能力替代                      |
| GitHub Actions 生成 index.json + 每工作流一个 issue | 否决     | 能工作，但多一层自动化要维护；读取可以用 3 次 API 调用完成，不需要 Action           |
| Gist 作为存储                                       | 否决     | 无中心审核，无法做到“维护者手动合并”；发现与排序弱                                  |
| 去中心化 topic 发现                                 | 否决     | 无审核会导致任意工作流被执行；搜索 API 匿名限额低                                   |
| OAuth Device Flow                                   | 暂不采用 | 需要维护者注册一次 OAuth App；当前版本用用户自备 PAT 即可，Device Flow 作为后续增量 |
| Issues 表单发布（用户零 token）                     | 否决     | 需要贴 JSON（issue 正文上限 64 KB），媒体不可靠，发布体验差                         |
| **PR + 文件 + raw 读取 + PR 作为讨论区**            | **采用** | 唯一需要的基础设施是仓库本身；审核与讨论都复用 GitHub                               |

### 2.2 实测结论（2026-10-25）

- **PR 就是 issue**：`GET /repos/{owner}/{repo}/issues?state=all&per_page=100` 返回的条目同时包含 PR（带 `pull_request` 键）、`reactions` 汇总（`+1` 等）和 `comments` 计数。用 `microsoft/vscode` 实测确认三个字段都存在。→ 一次调用拿到所有卡片的赞/评论数。
- **raw 不计 API 额度**：`raw.githubusercontent.com` 返回 `access-control-allow-origin: *` 与 `cache-control: max-age=300`，正文和图片走它，不消耗 REST 限额。
- **304 也扣额度**：条件请求返回 304 时 `x-ratelimit-remaining` 从 52 降到 51。所以不能把“轮询”寄托在 304 免费上，只能控制请求数（每次刷新 3 次 API 调用）。
- **匿名限额 60 次/小时/IP**：3 次/刷新 → 每小时最多 20 次刷新。扩展自身的更新检查与广场共用同一份额度（同一个出口 IP），持续自检时两者会互相饿死，因此目录新鲜窗口取 2 小时而不是 30 分钟。
- **扩展已有跨域能力**：`manifest.config.ts:87` 已声明 `<all_urls>`，扩展页面可直接 `fetch api.github.com` 与 `raw.githubusercontent.com`，无需改 manifest。
- **目标仓库存在且为空**：`https://github.com/dcc123456/BC-workflow` 显示 “This repository is empty.”，需要先补 README、目录约定与 PR 模板（单独授权后执行）。
- **可复用的现有能力**：工作流单条/批量导出（`src/sidepanel/WorkflowsTab.tsx:941`、`:945`）、批量导入（`:967`）、`asWorkflow` 归一化（`src/lib/workflow/storage.ts:44`）、`migrateWorkflow`、`FormDialog`（`src/ui/FormDialog.tsx`）、`OffscreenCanvas` 图片处理（`src/background/element-capture.ts:271`）。

## 3. 仓库约定

```
workflows/<slug>/
  workflow.json    # 脱敏后的工作流（Workflow 形状，id = slug）
  meta.json        # 卡片与版本信息
  assets/1.webp    # ≤3 张，压缩后每张 ≤1 MB
```

- **slug**：`slugify(name)` 生成 ASCII 串；名称全为中文等非 ASCII 时退化为 `wf`；末尾追加 6 位内容 hash：`<ascii-or-wf>-<hash6>`。同一作者更新同一工作流时沿用原 slug。
- **meta.json**

```json
{
  "schema": 1,
  "slug": "xiaohongshu-publish-note-a1b2c3",
  "title": "小红书发布笔记",
  "description": "打开创作页 → 填写标题 → 上传图片 → 发布",
  "category": "ecommerce",
  "tags": ["xiaohongshu", "publish"],
  "author": "octocat",
  "version": 1,
  "hash": "<sha256(workflow.json)>",
  "images": ["assets/1.webp"],
  "videoUrl": "https://www.bilibili.com/video/...",
  "createdAt": "2026-10-25T09:00:00.000Z",
  "updatedAt": "2026-10-25T09:00:00.000Z"
}
```

- **版本**：整数，首发 `1`；同一 slug 的后续 PR 递增。`hash` 指向该版本 `workflow.json` 的 SHA-256。
- **分类**：`category` 存内置 slug（`MARKETPLACE_CATEGORIES`，共 15 个细分类，面板按界面语言翻译）或发布者自填的标签（规范化后 ≤24 字符，按内容原样显示、不翻译）。广场筛选 = 全部内置分类 + 目录中已出现的自定义标签（按大小写不敏感去重）；卡片与筛选都用 `categoryKey` 比较，所以 `DevOps` 与 `devops` 落在同一项。新增分类无需升 schema：旧版面板读到未知值会显示为「其他」，卡片本身照常展示。
- **PR 约定**：标题 `Add workflow: <title> [wf:<slug>]`；分支 `submit/<slug>-<yyyyMMddHHmm>`；一个 PR 只包含一个工作流目录。
- **冲突**：slug 已存在且 `meta.author` 不是当前 GitHub 登录名 → 拒绝发布，提示改名；同一作者 → 视为更新，version +1。

## 4. 模块划分

全部纯逻辑放 `src/lib/marketplace/**`（chrome-free，可单测）；网络调用注入 `fetch`；只有 token 存取与 UI 触达 `chrome.*`。

| 文件                                      | 职责                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `types.ts`                                | `MarketplaceMeta`、`MarketplaceCard`、`WorkflowMarketplaceRef`、`MarketplaceErrorCode`、仓库常量 |
| `slug.ts`                                 | `slugify` / `buildSlug` / `isValidSlug`                                                          |
| `sanitize.ts`                             | `toPublishableWorkflow`：剥离本地字段、运行时数据、data URL、日志；凭据疑似值的告警              |
| `meta.ts`                                 | `buildMeta` / `parseMeta`（严格校验）/ `workflowHash` / `compareVersion`                         |
| `categories.ts`                           | 内置分类与自定义标签：规范化、大小写不敏感比较、标签翻译、筛选选项                               |
| `github-client.ts`                        | 带 token 的 REST 封装：401/403/404/422/限流映射为稳定错误码；只发本文档列出的端点                |
| `publish.ts`                              | `publishWorkflow`：确保 fork → 建分支 → 逐个 PUT 文件 → 开 PR                                    |
| `catalog.ts`                              | `loadCatalog`：tree + pulls + issues 三路合并；raw 拉 meta/图片；2 小时新鲜窗口与内存缓存        |
| `engagement.ts`                           | 点赞（reaction 增删）与评论（列/发）                                                             |
| `token.ts`                                | `getToken` / `setToken` / `clearToken`，存 `chrome.storage.local` 的 `marketplaceAuth`           |
| `src/sidepanel/MarketplaceTab.tsx`        | 广场页：卡片流、筛选、应用/更新、点赞、评论                                                      |
| `src/sidepanel/PublishWorkflowDialog.tsx` | 发布弹窗（`FormDialog` 外壳）                                                                    |

## 5. 发布流程

1. 工作流卡片上新增“发布”按钮，打开弹窗。
2. 弹窗字段：标题（必填）、描述（必填）、分类、标签、截图（≤3，前端 `createImageBitmap` + `OffscreenCanvas` 压到长边 1600、WebP 质量 0.85）、视频外链（可选）、作者（只读，来自 token 的 `/user`）。
3. `toPublishableWorkflow` 脱敏：
   - 删除 `id`、`createdAt`、`updatedAt`、`folderId`、`revision`、`revisionHistory`、`table`、`marketplace`、`plan`。
   - `settings` 只保留四个布尔开关，全部重置为默认；丢弃 `pageContext`、`goalVerification`、`trialRun`、`goalSpec`。
   - `drawflow.position/zoom` 归零/归 1。
   - 递归剥离 `data:` URL 与运行日志键；疑似凭据字面量（参数名匹配 `password|token|secret|apiKey` 且不是 `{{}}` 引用）→ 弹窗内阻断并要求用户确认或改为凭据引用。
4. token 缺失时先要求粘贴 PAT（classic，`public_repo`），`GET /user` 校验后存 `marketplaceAuth`。
5. 发布 API 序列（约 9–12 次调用）：
   1. `GET /repos/dcc123456/BC-workflow` 取默认分支（实际取 `git/ref/heads/main`）。
   2. `GET /repos/{login}/BC-workflow`；404 → `POST /repos/dcc123456/BC-workflow/forks`，最多轮询 30 s。
   3. `GET /repos/{login}/BC-workflow/git/ref/heads/<base>` 取 sha。
   4. `POST /repos/{login}/BC-workflow/git/refs` 建 `submit/<slug>-<stamp>`。
   5. `PUT /repos/{login}/BC-workflow/contents/workflows/<slug>/meta.json|workflow.json|assets/*`（base64，`branch` 指定分支）。
   6. `POST /repos/dcc123456/BC-workflow/pulls` 开 PR。
6. 成功后在弹窗内展示 PR 链接；失败按错误码给出可操作提示（见 §9）。

**为什么非目标仓库作者也要 fork**：统一路径，维护者始终通过 PR 审查；即使是 `dcc` 本人发布，也走同一流程，避免两条写路径。

## 6. 浏览、应用与更新

### 6.1 读取（每次刷新 3 次 API 调用）

1. `GET /repos/dcc123456/BC-workflow/git/trees/main?recursive=1` → 找到所有 `workflows/*/meta.json` 与 `assets/*`。
2. `GET /repos/dcc123456/BC-workflow/pulls?state=closed&per_page=100&sort=updated&direction=desc` → 只保留 `merged_at != null`，用 `head.ref` 前缀 `submit/<slug>-` 建立 slug → PR number 映射。
3. `GET /repos/dcc123456/BC-workflow/issues?state=all&per_page=100` → 用 PR number 取 `reactions['+1']` 与 `comments`。
4. meta 与图片走 `https://raw.githubusercontent.com/dcc123456/BC-workflow/main/workflows/...`。
5. raw 的每个响应（404 也算）带 `cache-control: max-age=300`。发布流程在合并**前**会读一次 `main` 上的 `meta.json` 算版本号，那次多半是 404；合并后立刻刷新，目录读取会命中这份 5 分钟缓存，工作流就会“消失”。因此第 4 步的 `meta.json` 请求追加 `?v=<时间戳>` 绕开缓存（GitHub 忽略查询串，raw 不计 API 额度）。
6. 反向保护：tree 已经列出工作流、却一张卡都解析不出来时按“读取失败”处理（回退旧快照并提示），绝不把空目录写进 2 小时缓存。

结果在内存缓存，并在 `chrome.storage.local` 记 `marketplaceLastCheck`；`MARKETPLACE_CACHE_TTL_MS`（2 小时）内重复打开不重新请求，手动刷新始终绕过节流。超过 100 个条目时分页（最多 3 页），超过上限时只显示“最新 300 个”。

### 6.2 卡片

封面（第一张截图）、标题、描述、作者、分类/标签、👍/💬 计数、来源链接、按钮状态：`应用` / `已添加` / `可更新`。

三种 chip 必须是三种不同的视觉，不只靠文字区分：作者是中性灰胶囊；分类是强调色填充胶囊（`bg-accent-soft` + `text-accent`）；标签是带描边、方角、`#` 前缀、保持原文大小写的小标签。样式全部走 Tailwind 语义 token（`.task-chip` 的基础字号/内边距保留，颜色与圆角用工具类覆盖），不新增手写 class。

### 6.3 应用

- `parseMeta` + `asWorkflow` + `migrateWorkflow` 校验；非法内容直接拒绝并在卡片上标记“不可用”。
- 生成本地副本：`newId()`、`createdAt/updatedAt = now`、`folderId` 清空、`revision` 从 1 起、`revisionHistory[0].source = 'marketplace'`。
- 写入 `workflow.marketplace = { repo, slug, version, hash, appliedAt }`。
- **首次应用必须经过信任确认**：说明“第三方工作流会在你的浏览器里执行页面操作”，并给出 GitHub 文件链接；确认后才写入。永不自动运行。
- 去重：本地任一工作流的 `marketplace.slug` 相同 → 不新增；按钮显示“已添加”。

### 6.4 更新

- 判定“可更新”只看已发布侧：`meta.version > marketplace.version`，或版本相同但 `meta.hash !== marketplace.hash` → 卡片与本地工作流列表显示“可更新”。
  - 版本是发布者的契约，但同一个 slug 可以“下架 → 重新发布”并复用旧版本号；只比版本会让这次内容更新永远推不到已安装用户，因此同版本必须再比内容 hash。
  - 本地修改不会改 `marketplace.hash`（它记录的是当初应用下来的发布内容），所以本地编辑本身不会触发更新提示——它正是更新要覆盖的对象。
  - 已发布的版本**低于**本地记录时永不提示更新，避免 2 小时目录快照回退时把用户“降级”。
- 执行更新：保留本地 `id`、`folderId`、`createdAt`，替换 `drawflow/trigger/settings/description/name`，刷新 `marketplace.version/hash`，追加 revision（`source = 'marketplace-update'`）。
- 更新是覆盖式操作，必须二次确认，并在确认文案里写明“本地修改会丢失”。
- 已安装工作流的检测节流复用目录 TTL（2 小时）；离线失败后 10 分钟再试，避免 5 秒一轮的工作流列表反复打 GitHub。

### 6.5 重新编辑与下架

- 发布成功后把 `{repo, slug, version, hash, author, appliedAt}` 记到本地工作流的 `marketplace` 上（`workflows.marketplace` 命令，只改元数据、不产生 revision，也不改 `updatedAt`——工作流列表按该字段排序，回写不能把它当作一次内容修改）。下次发布读这个引用，沿用同一 slug 并 `version + 1`，PR 标题变 `Update workflow: …`。没有该引用的“从本地直接发布”的工作流，改完再发布会因内容 hash 变化生成新 slug → 广场重复卡片，因此回写是重新编辑的前提。
- 重新编辑时发布弹窗先用 `raw.githubusercontent.com` 的 `meta.json` 预填标题/描述/分类/标签/视频，并把已发布图片下载回表单（最多 3 张，已压缩）；用户在预填返回前动过任何字段则整段预填放弃，避免覆盖输入。
- 下架入口在广场卡片上：当 `card.meta.author` 与已连接账号一致（忽略大小写）时显示“取消发布”。确认后 `GET git/trees` 取出 `workflows/<slug>/` 下全部 blob，新建 `submit/<slug>-<stamp>` 分支逐个 `DELETE /contents/...`（带 sha），再开 PR `Remove workflow: <title> [wf:<slug>]`。维护者合并后目录消失，目录刷新（或 2 小时过期）后卡片消失。
- 只有“完整且非 stale”的目录读取才能证明某个 slug 不存在：此时本地 `marketplace.slug` 不在目录中的工作流显示“来源已删除”，不再提示更新；本地副本、触发器和历史都不受影响。截断或回退缓存时不做该判断，避免把仍在架上的工作流误标为删除。

### 6.6 被调用的工作流（bundle）

`execute-workflow` 步骤存的是**发布者本地的 workflow id**，在别人机器上没有意义；如果只发布父工作流，消费者拿到的是一个指向不存在工作流的步骤。因此调用关系必须随发布一起打包：

- 发布前用 `collectDependencies` 沿调用图（`nodeBlockId === 'execute-workflow'`，参数按 `nodeParams` 读取，与引擎同一实现）遍历发布者本地库，按“叶子在前”的顺序去重收集。自调用与环被 visited 集合剪掉（引擎本来就拒绝环）。目标为空或含 `{{…}}`（运行时才确定）视为无法打包；库中找不到的 id 同样视为缺少。**存在无法满足的调用就阻断发布**，不发出指向空气的 PR。
- 被调用工作流写进同一个目录：`workflows/<slug>/deps/<file>.json`，文件名由工作流名 slug 化（同名追加 `-2`），`meta.json` 增加可选字段 `dependencies: [{ id, name, path }]`（`id` 是发布者的本地 id，`path` 形如 `deps/export-orders.json`，单条列表上限 20 个）。
- 父工作流的 `workflow.json` **保持发布者原始引用**（`data.workflowId` 仍是发布者的 id）。这是刻意的：文件字节与旧版本一致，不做无意义的 hash 漂移；真正把引用接到本机副本是应用时的事。
- 依赖文件复用同一套脱敏（运行日志、`data:` URL、凭据警告都不例外），弹窗里的警告会注明属于哪个被打包的工作流——凭据泄露风险不因“它只是被调用”而降低。
- 应用时 `planApplyBundle` 把 `meta.dependencies` 与下载到的 dep 文件一一核对（数量、id、path 必须完全对应，否则整包拒绝），生成本地 id `mkt-<父slug>-<file>`，再把父工作流与每个依赖内部的 `execute-workflow` 调用重写成这些 id。确定性 id 让“再次更新”替换同一份本地副本而不是不断堆积；依赖副本不写 `marketplace` 引用，不出现在“可更新/来源已删除”列表里，触发器一律 `enabled: false`。
- 用户被告知的三处：发布弹窗列出将随行的工作流（以及缺少/超量的错误行）；广场卡片的信任确认与本地工作流的更新确认里列出名字；卡片本身显示“含 N 个被调用工作流”的角标。PR 正文也列出 bundle，方便维护者审阅。
- 兼容性：`dependencies` 是可选的。旧版本面板发布的 listing 没有该字段，行为与以前完全一致（`execute-workflow` 步骤仍按历史方式应用）；新面板读取旧 listing 时 `parseDependencies` 返回空数组。schema 版本不升，避免把“只是多了可选字段”变成一次全量迁移。
- 父工作流已是最新版时 `planApplyBundle` 不写任何东西（包括依赖），与单工作流的 `up-to-date` 语义一致。新增/更新前先保存全部依赖，父工作流最后保存，保证中途失败时不会留下“父工作流指向尚未安装的副本”。

### 6.7 附件（200 KB 以内）

工作流常常需要一份配套文件（示例表格、配置模板、说明文档）。发布时允许附带小文件，随同一个 PR 提交：

- 每个文件 **≤ 200 KB**，最多 **3 个**（与截图数量一致）；超限在弹窗内直接拒绝，不发起任何网络写入。
- 存到 `workflows/<slug>/attachments/<文件名>`。文件名由原始名净化而来：去掉目录部分、转小写、非 `[a-z0-9._-]` 的字符折成 `-`、保留 ≤10 字符的扩展名；同名自动加 `-2`。`meta.json` 记录 `attachments: [{ name, path, size }]`，`name` 是用户原始文件名（展示用），`path` 是净化后的仓库路径。
- 附件是**二进制原样提交**，不经过脱敏；因此弹窗把“附件会公开”写在提示里，且只允许用户显式选择的文件。路径正则限制在 `attachments/` 单层目录内，`../` 之类不可能落库。
- 重新编辑时，已发布附件会按 `meta.json` 拉回表单（每个 ≤ 200 KB），避免“再次发布”静默丢掉附件；用户在预填返回前动过表单则整段放弃。
- 广场卡片把附件列成链接，指向 `raw.githubusercontent.com` 的原始文件，点击在新标签页打开；不写入本地库、不参与“应用/更新”，因此旧版本面板忽略该字段完全无影响。`schema` 不升版本。
- 校验分层与 bundle 一致：`attachments.ts` 负责命名/路径/大小显示，`buildMeta` 严格拒收非法记录，`parseMeta` 对附件**按条丢弃**而不是作废整张卡片——附件只影响下载，不影响可应用性。

## 7. 点赞与评论

- 目标对象是该工作流已合并 PR 的 issue 通道。
- **点赞**：`POST /repos/{o}/{r}/issues/{n}/reactions`，`content: "+1"`；取消 = `DELETE .../reactions/{id}`。自己点过的 reaction id 存本地 `marketplaceReactions`，避免每次重查。
- **评论**：打开卡片详情时 `GET .../issues/{n}/comments?per_page=50`；发送 `POST .../issues/{n}/comments`。
- 没有 token 的用户：只读计数，按钮变为“在 GitHub 参与”，打开 PR 页手动点赞/评论。
- 所有写操作都需要 token；读操作匿名即可。

## 8. token 与隐私

### 8.1 用户具体怎么操作

发布、点赞、评论第一次被触发时，弹窗内显示“需要连接 GitHub”：

1. 用户点 **打开 GitHub 创建 token**。扩展打开
   `https://github.com/settings/tokens/new?scopes=public_repo&description=Browser%20Copilot`
   （GitHub 支持用查询参数预填 scope 与备注；若参数失效则退化为普通创建页，按钮旁仍写明“只勾 `public_repo`”）。
2. 在 GitHub 页面上：
   - Note 已预填 `Browser Copilot`；
   - Expiration 选 90 days（推荐）或 No expiration；
   - Scopes **只勾 `public_repo`**（不要勾 `repo`，那会连私有仓库一起授权）；
   - 点 Generate token，复制 `ghp_...`（只显示一次）。
3. 回到侧边栏，粘贴到输入框，点 **验证并保存**。扩展调用 `GET /user`：
   - 成功 → 显示“已连接为 @octocat”，继续被打断的发布/点赞/评论；
   - 401 → 提示 token 无效或已被撤销，停留在输入框。
4. 之后每次发布/点赞/评论都复用这个 token；浏览不需要 token。
5. 想撤销：点插件里的“断开 GitHub”（只清本地），再到 GitHub 的 Tokens 页面 Delete；两处任一侧失效后扩展都会在下次写操作时提示重新连接。

**必须是 classic PAT。** Fine-grained PAT 对“向别人拥有的公开仓库开 PR / 建 fork”没有稳定的写权限模型（公开仓库默认只读），本次不支持；UI 若检测到 `github_pat_` 前缀直接提示改用 classic token。

### 8.2 存储与隐私约束

- PAT 存 `chrome.storage.local` 的 `marketplaceAuth`，并把该 key 加入 `src/lib/fs-store.ts` 的 `CONFIG_KEYS`，确保它**永远不会**被写进用户的数据目录（数据目录可能被同步/备份）。
- UI 只显示 `••••` 末 4 位；提供“断开 GitHub”清空 token 与本地的 reaction 缓存。
- token 只发给 `api.github.com`，不进入聊天上下文、不进入日志、不随数据导出。
- token 与 Settings 里的模型 API key 同级明文存储（仓库现状）；扩展页自身不注入第三方脚本，blob 半径为“公开仓库写”。

## 9. 错误与边界

| 场景                               | 行为                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| 401 / token 失效                   | 清空 token，提示重新粘贴                                                           |
| 403 且 `x-ratelimit-remaining: 0`  | 回退缓存并显示重置时间（“正在显示上次加载的列表；GitHub 限流，预计 HH:MM 恢复。”） |
| fork 未就绪                        | 轮询最多 30 s，超时提示稍后重试（发布内容不丢，可再次点击）                        |
| 422（分支/PR 已存在）              | 换时间戳重试一次，仍失败则提示同名 PR 已在等待合并                                 |
| slug 冲突且作者不同                | 阻断并建议改名，不发 PR                                                            |
| `meta.json` 解析失败               | 该卡片标记为“不可用”，不阻断其它卡片                                               |
| 工作流在远端被删除                 | 本地保留，标记“来源已删除”，不再提示更新                                           |
| 被调用的工作流本地已删除           | 阻断发布，列出无法满足的 id/节点名                                                 |
| 打包数量超过 20                    | 阻断发布并提示拆分                                                                 |
| `deps/*.json` 缺失或与 `meta` 不符 | 整包拒绝应用，不写入任何副本                                                       |
| 附件超过 200 KB 或超过 3 个        | 弹窗内阻断，不发 PR                                                                |
| `meta.attachments` 条目非法        | 丢弃该条，卡片与其余附件正常显示                                                   |
| 图片超限                           | 前端压缩后仍 >1 MB → 阻断并要求换图                                                |
| 离线                               | 回退缓存并说明真实原因（不可达 / 超时），不把限流说成“无法连接”                    |

## 10. 安全

- 平台内容是不可信输入：`parseMeta`/`asWorkflow` 严格校验，任何额外字段丢弃。
- 应用前必须经过信任确认；导入后不自动运行，不自动授予任何权限。
- 发布侧脱敏是硬约束：测试必须覆盖“本地字段/运行时字段/日志/data URL/凭据字面量”全部被剥离。
- 维护者的人工 review 仍是最终闸门；本设计不替代审核。

## 11. 验收与测试

- 纯逻辑单测：slug、sanitize、meta 解析/校验、hash、版本比较、PR→slug 映射、去重、更新判断。
- bundle 单测：调用图遍历（直接/传递/共享/环/自调用/动态目标/同名文件）、`meta.dependencies` 往返与非法值、应用时的 id 映射与就地替换、缺件整包拒绝。
- 附件单测：文件名净化（路径穿越/空格/中文/扩展名）、同名去重、路径白名单、大小显示；`buildMeta` 拒收超限，`parseMeta` 按条丢弃；发布文件与 PR 正文。
- 网络层单测：注入 mock fetch，覆盖发布序列、fork 轮询、401/403/422、分页。
- UI 测试：发布弹窗字段校验与图片压缩上限；卡片按钮状态（应用/已添加/可更新）；无 token 时的只读行为。
- 真实端到端（需要用户提供 PAT 与目标仓库写入许可）：发布 → 合并 → 广场可见 → 应用 → 点赞/评论。未获得前标记 BLOCKED，不宣称通过。

## 12. 后续增量（不在本次范围）

- OAuth Device Flow 替代 PAT。
- 维护者审核辅助（自动校验 PR 内 JSON、危险参数高亮）。
- 作者主页、按作者订阅、即时通知（需要后端）。

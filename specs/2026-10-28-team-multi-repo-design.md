# 多团队仓库共享 · Multiple team repositories

- 状态：已实现（2026-10-28）
- 关联：`specs/2026-10-27-team-workflow-sharing-design.md`（单仓库版本）

## 目标

一个人可能同时属于多个团队。团队共享不能再只允许一个私有仓库：设置里可以连接任意多个
`owner/repo`，工作流广场的「团队」视图同时展示所有已连接仓库的工作流，发布时可以选择发到哪个仓库。

## 决策

1. **每个仓库一枚 classic PAT。** 不同团队常常属于不同 GitHub 账号（甚至不同组织），共用一枚
   token 既表达不了权限，也把凭据绑死在一个连接上。存储为 `teamRepoAuths: Record<"owner/repo", auth>`。
2. **团队视图合并展示。** 「团队」标签读出所有已连接仓库的目录，合并成一份列表；连接数 > 1 时
   多出一个来源筛选（全部团队 / 各仓库）。每张卡片记住自己的仓库，应用、更新、下架都回到该仓库。
3. **发布目标按仓库选择。** 发布对话框的「发布到」列出「公共」+ 每个已连接仓库；上次发布到哪个
   仓库，再次打开就默认选中哪个。草稿按 `workflowId@owner/repo` 隔离（凭据值不跨仓库恢复）。
4. **目录缓存按仓库隔离**：`teamCatalog:<owner>/<repo>`。某个仓库读取失败不会清空其余仓库的列表，
   只会少掉它的卡片并在顶部点名该仓库。
5. **向后兼容**：旧的 `teamRepo` / `teamRepoAuth` 单连接记录继续可读，视为一个连接；第一次写入
   新存储时迁移成数组并删除旧键。

## 存储

```
teamRepos:      TeamRepoConfig[]                 // { owner, repo, branch, canPush, isPublic }
teamRepoAuths:  Record<"owner/repo", MarketplaceAuth>
teamCatalog:<owner>/<repo>: CatalogSnapshot      // 两小时缓存，各自独立
```

## 计划

1. `src/lib/marketplace/team.ts`：连接列表读写、按仓库取 token、增删、旧键迁移。
2. `src/lib/marketplace/catalog.ts`：`teamCatalogCacheKey(config)`。
3. `MarketplaceTab`：并行读取各仓库目录并合并，卡片带 `repo`，来源筛选，按仓库选用 client。
4. `PublishWorkflowDialog`：目标从 `public | team` 改成 `public | owner/repo`。
5. `WorkflowsTab`：更新检查与服务端更新按 `marketplace.repo` 逐个仓库执行。
6. `TeamSharingCard`：已连接列表（逐条断开）+ 始终可用的「再连接一个」表单。
7. `fs-store.ts` 的 `CONFIG_KEYS`、i18n（en + zh-CN）、测试、`CHANGELOG.md`。

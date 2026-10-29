# CLAUDE.md

本项目的 AI 修改代码规范统一维护在仓库根目录的 [AGENTS.md](./AGENTS.md)，以该文件为准，请先完整阅读并遵守。核心规则：

1. **提交信息必须使用英文**（Conventional Commits：`<type>(<scope>): <subject>`）。
2. **代码样式必须使用 Tailwind CSS**（v4，语义 token 见 `src/ui/design-system.css`，禁止内联静态样式与硬编码颜色）。
3. **文案提示必须使用多语言** · 所有 UI 文案必须同时支持英文与简体中文（en + zh-CN），新增/重命名 i18n key 时由类型系统强制对齐两侧；详细规范见 [AGENTS.md §3](./AGENTS.md#3-文案提示必须使用多语言--ui-copy-must-be-bilingual-en--zh-cn)。
4. **打 tag 必须同步更新 website/ 版本号与 README** · `git tag vX.Y.Z` 之前必须先 bump 根 `package.json`、同步 `website/index.html` 与 `website/index-zh.html` 中的版本号字符串（三处字面一致），并更新 `README.md` 与 `README.zh-CN.md`（每次 release 都要把新增功能与行为变更写进 README，两份同步）；详细规范见 [AGENTS.md §4](./AGENTS.md#4-打-tag-必须同步更新-website-版本号与-readme--tagging-must-bump-website-version-and-readme)。
5. **改完即推 + 交付说明** · 门禁全绿后自动 commit 并 push 到 `main`（一个功能一次提交），并在回复里写清「这次改了什么」与「人工怎么测（步骤 + 预期现象）」；破坏性操作仍需先问；详细规范见 [AGENTS.md §8](./AGENTS.md#8-改完即推--交付说明--commit-push-and-hand-off)。

收尾自检：`pnpm typecheck`、`pnpm test`；涉及 UI / manifest / 构建配置时加跑 `pnpm build`。

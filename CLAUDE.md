# CLAUDE.md

本项目的 AI 修改代码规范统一维护在仓库根目录的 [AGENTS.md](./AGENTS.md)，以该文件为准，请先完整阅读并遵守。核心规则：

1. **提交信息必须使用英文**（Conventional Commits：`<type>(<scope>): <subject>`）。
2. **代码样式必须使用 Tailwind CSS**（v4，语义 token 见 `src/ui/design-system.css`，禁止内联静态样式与硬编码颜色）。
3. **文案提示必须使用多语言** · 所有 UI 文案必须同时支持英文与简体中文（en + zh-CN），新增/重命名 i18n key 时由类型系统强制对齐两侧；详细规范见 [AGENTS.md §3](./AGENTS.md#3-文案提示必须使用多语言--ui-copy-must-be-bilingual-en--zh-cn)。
4. **打 tag 必须获得用户明确指令，并同步更新 website/ 版本号与 README**：**未获用户明确指令（消息里出现「打 tag」或指定 tag 名），禁止创建或推送任何 tag**——具体包括 `git tag`、`git push --tags`、`git push origin <tag>`、以及在 GitHub 网页创建 Release（会先建 tag）；"版本号已 bump / 文档已就绪 / 用户说过要发版"都不构成授权，流程走到 tag 必须停下询问。`git tag vX.Y.Z` 之前必须先 bump 根 `package.json`、同步 `website/index.html` 与 `website/index-zh.html` 中的版本号字符串（三处字面一致），并更新 `README.md` 与 `README.zh-CN.md`（每次 release 都要把新增功能与行为变更写进 README，两份同步）；详细规范见 [AGENTS.md §4](./AGENTS.md#4-打-tag-必须同步更新-website-版本号与-readme--tagging-must-bump-website-version-and-readme)。
5. **修改记忆目录** · 每次**代码提交**都要在 `memory/YYYY-MM-DD.md`（当天文件，只追加）写一条，并更新 `memory/index.md` 的今日行（历史行冻结）；条目固定五项（变更/模块/验证/遗留 + `HH:MM · commit subject`），**写行为变化不写文件清单，不写 commit hash**；详见 [AGENTS.md §9](./AGENTS.md#9-修改记忆目录--change-memory-memory) 与 [`memory/README.md`](./memory/README.md)。
6. **改完即推 + 交付说明** · 门禁全绿后自动 commit 并 push 到 `main`（一个功能一次提交），并在回复里写清「这次改了什么」与「人工怎么测（步骤 + 预期现象）」；破坏性操作仍需先问；详细规范见 [AGENTS.md §8](./AGENTS.md#8-改完即推--交付说明--commit-push-and-hand-off)。

收尾自检：`pnpm typecheck`、`pnpm test`；涉及 UI / manifest / 构建配置时加跑 `pnpm build`。

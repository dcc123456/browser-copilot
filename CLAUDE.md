# CLAUDE.md

本项目的 AI 修改代码规范统一维护在仓库根目录的 [AGENTS.md](./AGENTS.md)，以该文件为准，请先完整阅读并遵守。核心规则：

1. **提交信息必须使用英文**（Conventional Commits：`<type>(<scope>): <subject>`）。
2. **代码样式必须使用 Tailwind CSS**（v4，语义 token 见 `src/ui/design-system.css`，禁止内联静态样式与硬编码颜色）。

收尾自检：`pnpm typecheck`、`pnpm test`；涉及 UI / manifest / 构建配置时加跑 `pnpm build`。

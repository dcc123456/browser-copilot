# AI 修改代码规范 / AI Coding Guidelines

本文件约束所有 AI 编码助手（以及人类协作者）在本仓库中的代码修改与提交行为。修改代码前必须先读完并遵守本文件。规范如有更新，只维护这一份文件，其他入口文件（`CLAUDE.md`、`.trae/rules/project_rules.md`）均为指向本文件的引用。

## 1. 提交信息必须使用英文 · Commit messages MUST be in English

- 每条提交的 subject 和 body **必须全部使用英文**，禁止中文或其他语言。
- 沿用 Conventional Commits 格式：`<type>(<scope>): <subject>`。仓库已使用的 type：`feat` / `fix` / `docs` / `test` / `refactor` / `chore`（按需可扩展）。
- subject 用英文祈使句、结尾不加句号，建议不超过 72 个字符；scope 写受影响模块，如 `workflow`、`agent`、`mcp`、`i18n`、`sidepanel`、`ui`、`background`、`inpage`。
- 示例：
  - ✅ `feat(workflow): add retry controls to loop blocks`
  - ❌ `feat(workflow): 循环块新增重试控制`（提交信息使用中文）

> 注：仓库历史提交存在中文信息，自本规范生效起，所有**新**提交一律使用英文。

## 2. 代码样式必须使用 Tailwind CSS · Styling MUST use Tailwind CSS

- 所有新增或修改的 UI 样式**必须使用 Tailwind CSS 工具类**（Tailwind v4，已经 `@tailwindcss/vite` 接入，入口为 `src/ui/design-system.css`）。
- 颜色必须使用 `@theme inline` 桥接出的语义 token 类名（如 `bg-panel`、`text-muted`、`border-border`、`text-accent`、`bg-accent-soft`、`text-err`），禁止在 JSX 中写硬编码 hex 颜色，这样才能同时适配深色/浅色主题（深色为默认主题）。
- 禁止：
  - 引入 CSS-in-JS、CSS Modules 或其他新的样式方案；
  - 为一次性样式在 `design-system.css` 或各 surface 的 `styles.css` 中手写新的 class；
  - 在组件里写内联静态样式。
- 内联 `style={{…}}` 仅允许用于运行时才能确定的动态值（如拖拽时计算的坐标）；静态样式一律用 Tailwind 类。
- 需要新的颜色、圆角等设计 token 时：先在 `design-system.css` 的 dark / light 两个主题块中添加 `--bc-*` 变量，并在 `@theme inline` 中映射为 Tailwind 类名，再使用该类名——不要临时内联或硬编码。
- 例外：CodeMirror 等第三方组件必须通过选择器覆盖的样式，继续留在现有 CSS 文件中维护。

## 收尾自检 · Before you finish

- `pnpm typecheck` 与 `pnpm test` 通过。
- 改动涉及 UI、manifest 或构建配置时，额外运行 `pnpm build` 确认产物正常。

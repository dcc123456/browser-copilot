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

## 3. 文案提示必须使用多语言 · UI copy MUST be bilingual (en + zh-CN)

- 所有面向用户的可见文案（按钮、标签、提示、错误信息、Toast、Modal、占位符、空状态、Tooltip、aria-label、通知、文档站点文案）**必须同时提供英文（`en`）与简体中文（`zh-CN`）两个版本**。任何新增或修改的文案都禁止只写一种语言。
- i18n 实现位置（本仓库）：核心字典在 `src/lib/i18n.ts` 的封闭 `Messages` interface 中；侧边栏消费层在 `src/sidepanel/i18n.tsx`（`I18nProvider` / `useT`），workflow editor 独立字典在 `src/workflow-editor/i18n.ts` 与 `src/workflow-editor/block-i18n.ts`。
- Key 命名：**flat camelCase**（无嵌套、无 `.` 分隔），按区域加短前缀，例如 `tabChat`、`settingsLanguage`、`chatWorkflowReviewLogFailed`、`histDeleteConfirm`。同一文案不允许出现两个 key。
- 由于 `Messages` 是 TypeScript 封闭类型，**新增或重命名 key 时必须同时给 `en` 与 `zh-CN` 两侧赋值**——`pnpm typecheck` 会自动拦截「只在一侧注册」的情况。请把这种类型守卫当作强制约束，不要绕过（不要 `// @ts-expect-error`、不要把 key 改成可选）。
- 字符串插值：使用函数式 value，参数通过 `params` 对象传入，如 `skillsSaved: ({ name }) => \`Saved "${name}".\``；不允许拼接用户输入。
- JSX 中**禁止硬编码**用户可见的字符串字面量（包括中英文）。需要新增文本时一律走 i18n key；只有 `console.*`、注释、纯开发者日志可以不受此约束。
- 若新增语种文件，必须保持 1:1 对齐，且同步更新 `LOCALES` 联合类型与 `DICTIONARIES` 映射。

> 注：仓库历史中可能存在单语种文案残留；新提交一律双语，旧文案按 i18n TODO 逐步补齐。

## 4. 打 tag 必须同步更新 website/ 版本号 · Tagging MUST bump website version

- 每次 `git tag`（无论是正式版 `vX.Y.Z` 还是预发布 `vX.Y.Z-rc.N`）之前，**必须先**更新 `website/` 目录下展示版本号的位置，使其与即将打的 tag 完全一致。
- 本仓库中需要同步的文件（截至当前）：
  - `website/index.html`（line 160、423）
  - `website/index-zh.html`（line 160、420）
  - 根 `package.json` 的 `version` 字段（始终是单一权威源）
- Tag 格式：与历史保持一致 `vX.Y.Z`（SemVer 带 `v` 前缀）；tag 中的 `X.Y.Z` 与 `package.json` 的 `version`、与 `website/` 内展示的版本号三处必须**字面完全一致**（不带 `v` 前缀）。
- 顺序约束（必须按顺序执行，不可并行；CI 校验建议在 §收尾自检 之上加一条「`git tag --points-at HEAD` 与 `website/` 声明版本号一致」的检查）：
  1. bump 根 `package.json` 的 `version`
  2. 同步更新 `website/index.html` 与 `website/index-zh.html` 中所有版本号字符串
  3. `pnpm typecheck && pnpm test && pnpm build` 通过
  4. `git tag vX.Y.Z`
- 仅修改 `package.json` 但漏改 `website/`（或反之）视为违反本规则；该类漂移在打 tag 前必须修齐。

> 注：当前仓库已观察到一次漂移——根 `package.json` 已为 `0.6.3`，但 `website/` 两文件仍为 `v0.6.2`，下次打 tag 前需先修齐。

## 收尾自检 · Before you finish

- `pnpm typecheck` 与 `pnpm test` 通过。
- 改动涉及 UI、manifest 或构建配置时，额外运行 `pnpm build` 确认产物正常。

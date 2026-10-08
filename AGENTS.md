# AI 修改代码规范 / AI Coding Guidelines

本文件约束所有 AI 编码助手（以及人类协作者）在本仓库中的代码修改与提交行为。修改代码前必须先读完并遵守本文件。规范如有更新，只维护这一份文件，其他入口文件（`CLAUDE.md`、`.trae/rules/project_rules.md`）均为指向本文件的引用。

## 约束分级与冲突优先级 · Enforcement tags & conflict priority

本文件是**约束清单**，不是建议清单。每条规则后面标注它的强制手段：

- `[机检]` — 有工具自动拦截（CI / tsc / vitest / eslint / 脚本），可以声称"工具会拦"。
- `[验收]` — 无自动拦截，属于收尾自检逐项人工核对的验收条目。
- `[纪律]` — 只能靠执行者自觉，收尾自检必须显式回答，**不得声称有工具兜底**。

冲突时的优先级：**本文件 > `specs/**` 与 `docs/**` 里的设计/计划文档 > 个人习惯**。
若某条规则与当前计划的既定决策不可调和，**先停下来提出冲突，不要自行打破规则继续写**。

命名、注释、死代码类细则约束**新增与被修改的代码**；存量违例不要求顺手清理，但不得当作范例复制。

## 0. 项目是什么 · What this project is

- Chrome MV3 浏览器自动化扩展（`src/`：side panel、workflow editor、background 引擎、注入内核）
  加配套的无头 Runner 服务（`server/`，pnpm workspace 包 `browser-copilot-runner`）。
- 它**不是**网页项目、**不是**脚本集合、**不是** SaaS 后台。"先做成网页再说""再起一套 driver"的实现都是错的。
- 执行纪律：**一次只推进一个主题**，沿用仓库既有文档约定——先在 `specs/<YYYY-MM-DD>-<area>-design.md` /
  `-plan.md`（或 `docs/`）写下计划与设计，再写代码，最后按「收尾自检」逐项验收。

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

## 5. 代码复用与简洁 · Reuse & simplicity

**以逻辑复用为荣，以堆积代码为耻。**

- 5.1 写任何新函数之前，先按**能力**（不只按名字）在 `src/lib/**`、`src/background/**`、`server/src/**`
  里搜现有实现（retry / parse / interpolate / store / replay / redact / throttle……）。已有就复用或
  扩展，不要复制改写一份。`[纪律]` + `[验收]`
- 5.2 同一逻辑**出现第二次**就必须抽公共层；第三次还在复制视为缺陷，必须修掉才算完成。`[验收]`
- 5.3 优先**扩展现有模块的接口**，不新建平行模块；新增文件要在对应 plan/design 文档里说明理由。`[验收]`
- 5.4 发现无用代码（未被调用的导出、死分支、被替换的旧实现、注释掉的代码块）**及时删除**。
  eslint 的 `no-unused-vars` 只是 warn、CI 也不带 `--max-warnings 0`，工具不拦，全靠人工。`[纪律]`
- 5.5 不做超出需求的功能、不为假想未来做抽象、不加不会发生的异常处理；边界校验只在系统边界做
  （用户输入、外部页面、LLM 输出）。三行相似代码好过一次过早抽象——但按 5.2，同一逻辑第二次出现就必须抽。`[纪律]`
- 5.6 **禁止新增第二套同类基础设施。** 仓库里现有的"成对设施"分两类处理：
  - **刻意镜像（受保护，必须锁步）**：`src/background/driver.ts`（chrome.scripting + CDP via
    chrome.debugger）与 `server/src/driver.ts`（Playwright 移植）是同一驱动能力在两个宿主上的镜像。
    硬性契约：两侧注入的内核必须同为 `src/inpage/kernel.ts`（版本对齐 `src/inpage/kernel-version.ts`）；
    驱动行为改动必须双侧同时落地、各有测试。出现**第三条**浏览器驱动路径（新的 executeScript 通道、
    新的 CDP 客户端、新的 Playwright 入口）即违规。`[验收]`
  - **既有债务（只许收敛，禁止再加一套）**：配置读取（`server/src/config.ts`、`server/src/config-store.ts`、
    `src/lib/storage.ts`）、状态存储（`src/background/checkpoint-store.ts` 与 `server/src/checkpoint-store.ts`，
    契约统一在 `src/lib/workflow/checkpoints.ts`）、i18n 字典（`src/lib/i18n.ts`、`src/sidepanel/i18n.tsx`、
    `src/workflow-editor/i18n.ts`、`src/workflow-editor/block-i18n.ts`）、设计 token（定义在
    `src/ui/design-system.css`，由 `server/web/src/styles.css` 手工镜像——改 token 必须双侧同步）。
    给其中任何一类再加一套都不允许；需要新的跨端能力时放 `src/lib/**`。`[纪律]` + `[验收]`
- 5.7 跨端逻辑只放 `src/lib/**`（chrome-free，`CONTRIBUTING.md` 既有红线）。Runner 依赖扩展内部文件
  只允许走 `server/tsconfig.json` 的 `include` 里逐个列出的白名单（当前为
  `../src/background/workflow-engine/engine.ts`、`../src/background/workflow-engine/loop-breakpoint.ts`、
  `../src/inpage/kernel.ts`、`../src/inpage/kernel-version.ts`、`../src/lib/**/*.ts`）；新增跨包依赖必须
  显式加行。**已知缺口（存量，不得当作范例）**：`server/src/executors.ts` 与 `server/src/run-service.ts`
  实际还 import 了 `workflow-engine/executors.ts` 与 `workflow-engine/debug-session.ts`，这两行不在
  `include` 里——因为 `include` 只列 program 根文件，被 import 的文件会传递性地拉进来，`pnpm server:typecheck`
  拦不住越界。收敛方向是把缺的两行补进 `include`（并把清单与真实 import 对齐），而不是再放宽一层。
  唯一已知反向依赖是 `src/lib/messages.ts` → `../background/running-tasks`（type-only），不要再造第二条。
  `[验收]`

## 6. 命名与注释 · Naming & comments

- 6.1 变量/函数命名必须有含义：读名字就知道它装什么、属于哪个阶段。禁止 `data`、`res`、`temp`、`flag`、
  `obj2`、`item`、`a/b/c` 与无语义缩写；循环内单字母只允许出现在 ≤3 行的极短作用域。eslint 没有
  naming-convention 规则，纯靠人工。`[纪律]`
- 6.2 命名风格沿用现状：变量 `camelCase`、类型与类 `PascalCase`、文件 `kebab-case`、常量
  `UPPER_SNAKE_CASE`，布尔量用 `is/has/should/can` 前缀。`[纪律]`
- 6.3 注释写**为什么**和非直观约束，不复述代码字面；`// 返回 x` 这类废话注释视为违规。复杂函数在头部
  写 1–3 行流程说明，禁止段落式大文档注释块。`[纪律]`
- 6.4 注释一律用**英文**（与仓库现状一致），新模块文件头沿用现有 `@module` 注释块惯例。
  不要求逐个函数写 JSDoc——写了要值得读。`[纪律]`

## 7. 方案先行 · Research before building

- 7.1 实现项目里没有的能力之前，先做外部取证（官方文档 / 源码仓库 / 检索），产出写进对应
  `specs/<YYYY-MM-DD>-<area>-plan.md`（或 `docs/`）的"选型与证据"小节：候选方案、**否决理由**、被验证的
  一手来源、本机实测结论。`[验收]`
- 7.2 **文档转述不可信，以实测为准**：涉及框架或第三方库的 API 形态时，先读它的 `.d.ts` 或编译产物，
  或跑一个最小 spike 验证，再写调用代码。`[纪律]`
- 7.3 spike 与手工验证脚本一律放 `tmp/`（已在 `.gitignore`）；结论进文档，代码不进主干。`[纪律]`
- 7.4 takeover / debug 成功率口径以 `docs/ai-debug-success-rate-v3.md` 为唯一事实源
  （"verified = takeover-free verification run 通过且 goal 达成"），禁止在别处另造口径。`[验收]`

## 收尾自检 · Before you finish

**禁止"脚本绿了就宣称做完"。** `pnpm test` 只证明纯逻辑层没坏，**证明不了扩展真的能用**。
涉及浏览器真实行为的结论，必须来自以下证据之一：加载 unpacked extension 的手工验证（写明步骤与
观察到的现象）、`pnpm selftest`（build → 真实 Chrome 上的 WS bridge → generate / replay / repair，
证据落在 `tmp/selftest-report.json`）、`pnpm server:smoke`、`pnpm test:replay`。
拿不到证据就如实报告 BLOCKED 与原因——诚实的空项比虚假的全绿有用。

每次改完逐条回答，任一不过不得声称完成：

- ① 扩展侧门禁全绿并贴实际命令与输出：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`；
  改动涉及 UI、manifest 或构建配置时额外 `pnpm build`（或对应变体，如 `pnpm build:no-ocr`）。`[机检]`
- ② Runner 侧改动：`pnpm server:typecheck`、`pnpm server:test`。`[机检]`
- ③ 改动涉及 `src/lib/workflow/ai-takeover.ts` 或 `src/background/workflow-engine/**`：跑
  `pnpm bench:debug` 取 before/after，并按 `CONTRIBUTING.md` 在 PR 里报告成功率变化（基线
  `tests/bench/baseline.json`）。`[机检]` + `[验收]`
- ④ 新增或改动了 `executeScript({func})` 的内联函数体：`pnpm verify:injected` 必须过——该脚本**不在 CI**，
  要手动跑。`[验收]`
- ⑤ 浏览器可见行为的证据（见上）已附上，或明确标 BLOCKED。`[验收]`
- ⑥ 复用检查：新写逻辑搜过同能力实现吗？出现第二处复制了吗？（§5）`[纪律]`
- ⑦ 死代码与命名：没有未调用的导出、没有注释掉的代码块、命名合规（§6）。`[纪律]`
- ⑧ UI 与文案满足 §2（Tailwind + token 双侧同步）与 §3（en + zh-CN；核心字典由封闭 `Messages` 类型机检）。`[验收]`
- ⑨ 暂存区没有测试临时产物：截图、探针输出、一次性素材只能留在 `tmp/`，禁止 `git add -f` 绕过。`[纪律]`
- ⑩ 提交符合 §1（英文 Conventional Commits）；要打 tag 时按 §4 先同步 `website/` 版本号。`[纪律]`

## 机检落地状态 · What is actually tool-enforced

**已落地（可以声称"工具会拦"）：**

- CI `.github/workflows/ci.yml`：扩展 job（blocking）跑 `pnpm typecheck` / `test` / `lint` /
  `format:check` / `build` / `bench:debug`；Runner job（blocking）跑 `pnpm server:typecheck` /
  `server:test`；`coverage` 与 `pnpm audit` 是 advisory（`continue-on-error: true`）。
  注意触发条件：**只有 push 到 `main` 与 PR 才跑**，本地提交不会被拦，所以门禁要在收尾时本地跑。
- `pnpm typecheck` = `tsc --noEmit && tsc --noEmit -p tsconfig.tests.json`（src + tests）。
- `src/lib/i18n.ts` 的封闭 `Messages` 接口让「i18n key 只注册一侧」直接编译失败（§3 的机检来源）。
- Vitest 覆盖 `tests/**/*.spec.ts[x]`（含 31 个 `tests/acceptance-*.spec.ts`）；Runner 侧
  `server/test/**/*.test.ts` + `*.smoke.ts`。
- `tmp/` 已在 `.gitignore`（注释明示 manual testing 产物不入库）。
- `pnpm verify:injected`（`scripts/verify-injected-functions.mjs`）是真实的静态校验，但不在 CI，靠人跑。

**未落地（只能标 `[纪律]`，不得声称有工具兜底）：**

- **仓库没有自带任何 git hook**（无 `.githooks/`、`core.hooksPath` 未设置、无 commit-msg / pre-commit
  校验；`.git/hooks` 里只有 IDE 装的遥测钩子）→ §1 英文提交、收尾自检 ⑨⑩ 纯靠纪律。
- eslint 刻意最小：`no-console` / `no-explicit-any` / `no-empty-object-type` 关闭、`no-unused-vars` 仅
  warn、没有 naming-convention 规则，并且 ignore 掉 `server/web/**`、`public/**`、`website/**`
  → 死代码、命名、以及 Runner 控制台前端的文案都不被工具检查。
- `pnpm selftest` / `pnpm server:smoke` / `pnpm test:replay` / `pnpm bench:reliability` /
  `pnpm bench:workflow-generation` / `pnpm bench:workflow-repair` 这类真实浏览器验证全部 opt-in。
- 无 locale 键对齐脚本：`EDITOR_STRINGS`、`src/workflow-editor/block-i18n.ts`、
  `src/sidepanel/i18n.tsx` 不受 `Messages` 类型保护；`server/web/` 现有硬编码文案属已知存量违例
  （见前言的"新增与被修改"限定）。
- 无分层 / boundaries 检查：`src/lib/**` chrome-free 与 §5.7 白名单靠 `CONTRIBUTING.md` + review。
- §4 设想的「tag ↔ website 版本一致」校验脚本并不存在；打 tag 前必须人工核对。

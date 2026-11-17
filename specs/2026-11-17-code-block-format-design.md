# 代码算子节点 — 一键格式化设计方案

## 目标 / Goal

在「JavaScript code」算子节点（`blockId: 'javascript-code'`）的编辑代码面板上增加一个「Format」按钮：点击后自动把当前代码排版为项目统一的风格（单引号、无分号、2 空格缩进、100 列宽），原地写回编辑器；语法错误时不破坏代码，给出可读提示。

不做：不自动生成/改写逻辑、不改执行语义、不覆盖 JSON 只读查看器、不加全局快捷键（首版 Scope 仅限该按钮）。

## 现状 / Current implementation（实测 2026-11-17）

- 算子定义：`src/lib/workflow/blocks/catalog.ts:726-751`，`editComponent: 'EditJavascriptCode'`，代码存于 `data.code`。
- 编辑面板：`src/workflow-editor/blocks/batchC/EditJavascriptCode.tsx`。Modal 内 `tab==='code'` 时渲染 `<CodeEditor value={code} onChange={(v)=>onChange({code:v})} lang="javascript">`（L164-174）。
- 编辑器：`src/workflow-editor/ui/CodeEditor.tsx` — CodeMirror 6 原生封装，`value`/`onChange` 受控，外部值通过 `view.dispatch({changes})` 同步（L184-191）。**因此格式化只需在面板层 `onChange({code: formatted})`，无需改 CodeMirror 内部。**
- 面板已有「wrap line」小按钮（L178-184，`.wf-code-wrap-toggle`）与可用函数区，Format 按钮与之并列最为自然。
- 项目格式配置：`.prettierrc.json` = singleQuote / no semi / printWidth 100 / tabWidth 2 / trailingComma all / arrowParens always / lf。

## 选型与证据 / Evidence（一手实测）

| 决策                                                                                             | 证据                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用 `prettier/standalone` + `prettier/plugins/babel` + `prettier/plugins/estree` 在浏览器侧格式化 | spike `tmp/prettier-format-spike.mjs` 实测：凌乱代码、`await` top-level、`automaNextBlock()` 调用、`'{{myVar}}'` 字符串全部格式化成功；语法错误 `const = ;;;` 抛 `Unexpected token (1:7)`，可捕获提示。 |
| prettier 版本与依赖位置                                                                          | `package.json:93` 已有 `prettier ^3.9.6`（devDependency）。**运行时被 bundle 使用，需提升到 `dependencies`**，否则扩展生产构建/他人安装时可能缺失。                                                     |
| 复用项目风格配置，不另立规则                                                                     | 直接读 `.prettierrc.json` 的 7 个选项硬编码进 format 调用（standalone 无法读配置文件）。格式化结果与 `pnpm format` 一致，避免两套风格。                                                                 |
| parser 选 `babel` 而非 `typescript`                                                              | 节点产出是普通 JS；spike 证明 babel 能解析 top-level await 与 automa 全局调用。                                                                                                                         |
| 不引入 js-beautify / esprima                                                                     | 依赖树中没有，且 prettier 已是项目既有格式化权威，避免第二套格式化实现（§5.6）。                                                                                                                        |
| 错误反馈用面板内行内文字，不建全局 toast                                                         | 全仓 `src/` 无 toast/notify 机制；新增基础设施超出本次范围。                                                                                                                                            |
| 按钮文案走 `EDITOR_STRINGS` 双语 key                                                             | `src/workflow-editor/i18n.ts` 的 `t()`（en 源 key + zh 字典），既有 `wrapLine`(en L260 / zh L698) 即同面板范例；`tests/editor-i18n.spec.ts` 强制 en/zh key 数量一致。                                   |

## 实现设计 / Design

1. **纯函数模块** `src/lib/format-code.ts`（chrome-free，放 lib 便于单测与跨端复用）：
   - `export async function formatJavaScriptCode(code: string): Promise<string>`
   - 顶层 import `prettier/standalone` + babel + estree 插件；`format(code, { parser:'babel', plugins:[babel,estree], ...STYLE })`。
   - 格式化失败原样抛出（由 UI 捕获），不在工具函数里吞错。
   - 风格常量带注释说明来源 `.prettierrc.json`，避免漂移。
2. **按钮 UI**（`EditJavascriptCode.tsx`）：
   - 在 `wf-code-helpers-title` 行，`wrap line` 按钮旁加 `<button type="button" className="wf-code-wrap-toggle" ...>`，文案 `t('formatCode')`，`title=t('formatCodeHint')`。
   - 点击 handler：`async` → `setFormatting(true)` → try `formatJavaScriptCode(code)` → 成功 `onChange({code: formatted})` → `catch` 记录 `t('formatCodeFailed')` → `finally` 复位。空代码直接返回。
   - 行内错误/状态提示：`<span className="wf-code-format-status" role="status">`，失败时显示本地化错误文案（不显示英文原始堆栈，避免噪音），2.5s 后清除（用 ref 存 timer，卸载时 clear，避免内存泄漏）。
   - 复用 `wf-code-wrap-toggle` 样式类（下划线小按钮），不新增 CSS class，符合「不为一次性样式手写新 class」。按钮需 `disabled={formatting}` 防重复点击。
3. **i18n**（`src/workflow-editor/i18n.ts`）：
   - `EDITOR_STRINGS.en` 加 `formatCode: 'format'`, `formatCodeHint: 'Auto-format JavaScript (single quotes, no semicolons)'`, `formatCodeFailed: 'Format failed — check for a syntax error'`（en 即 key 源，值写可读英文）。
   - `EDITOR_STRINGS.zh` 对应 `格式化` / `自动排版 JavaScript（单引号、无分号）` / `格式化失败，请检查语法错误`。
   - 两侧 key 数保持一致，满足既有 i18n 测试。
4. **依赖**：`package.json` 将 `prettier` 从 devDependencies 移到 dependencies；同步 `pnpm-lock.yaml`（用项目自带 pnpm，避免 corepack 改写锁定格式，§memory 教训）。

## 关键取舍 / Trade-offs

- 用 async 动态 `import()` 加载 prettier（非静态 import）：实测静态 import 使 `workflow-editor` chunk 从约 0.6 MB 涨到 1.61 MB（gzip 492 kB）；一键格式化是低频便利功能，不应让所有打开编辑器的用户下载 ~1 MB 解析器/打印器。动态 import 后 prettier 拆为独立 chunk，仅点击时加载。单测仍可直接 `await formatJavaScriptCode()`，无行为差异。
- parser 不强制 `sourceType:'module'`：babel parser 默认即可解析脚本片段；如果用户代码含 `import`，babel 也能解析（spike 未覆盖但 prettier babel 插件支持 ESM）。
- 不在 CodeEditor 内做格式化：CodeEditor 被 JSON 只读查看器复用，格式化职责放在知道「这是可编辑 JS 代码」的面板层更清晰。

## 验收 / Verification

- **单测**（新增 `tests/format-code.spec.ts`，6 项通过）：凌乱代码→期望风格；top-level await / automa 调用 / `{{变量}}` 字符串保持可格式化；幂等（格式化两次相同）；语法错误 reject；空字符串返回空；format 按钮 4 个 i18n key 双语齐全。
- **i18n 回归**：既有 `tests/editor-i18n.spec.ts` 的「每 key 双语存在且数量一致」自动覆盖新增 4 个 key（8 项通过）。
- **构建门禁**（实测 2026-11-17）：`pnpm typecheck`（src）✓、定向 `vitest` ✓、`eslint`（改动文件）✓、`prettier --check`（改动文件）✓、`vite build` ✓。动态 import 后 `workflow-editor` chunk 从 1610 kB 降到 996 kB。
- **完整测试套件**：6037 项中 6035 通过；2 项失败位于 `tests/tool-config.spec.ts`，根因是工作区**其它主题**未提交改动——`src/lib/tool-catalog.ts` 把 `run_workflow` 加进 `BRIDGE_ONLY_TOOLS` 却未补 `TOOL_META_BY_NAME_MERGED`/section 映射（对照实验：临时移除该行后失败从 2 降为 1，另一项同源 `agent.ts` 改动）。本任务未改这些文件，按 §8.2 不混入他人改动。
- **浏览器实证**：BLOCKED —— 这些浏览器工具经当前已加载扩展桥接，使新构建生效需 reload 扩展，而 reload 会断开桥接连接并干扰用户正在使用的标签页会话，故无法安全完成端到端点击验证。人工测试步骤见下方交付说明；格式化纯函数的真实运行结果由 spike 与单测覆盖。

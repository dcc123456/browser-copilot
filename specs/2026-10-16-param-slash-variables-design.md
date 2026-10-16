# 算子参数输入框的 `/` 动态变量下拉 — 设计与取证

日期：2026-10-16 ｜ 范围：workflow editor 属性面板 + `src/lib/workflow/**` 纯逻辑层
需求原话：「工作流编辑中 我需要所有能填写字符串的算子 的属性面板 它们的输入框支持 用户输入 '/'
就出现下拉框 能带出可选择的动态变量 字段 包含用户设置的秘钥等字段」

## 1. 需求拆解

- 触发：字符串输入框里敲 `/`（光标处，非任意位置）。
- 内容：此刻**真正可用**的动态变量 —— 工作流入参、上游算子产出的变量、引擎别名、循环上下文，
  以及用户保存的凭证（密钥）。
- 覆盖：所有能填字符串的算子参数字段，不要求逐个改 55 份手写表单。

## 2. 选型与取证

### 2.1 复用侧栏聊天的 `/` 下拉，而不是再造一套

`src/lib/slash.ts` 已经是纯逻辑 + 有测试的（`tests/slash.spec.ts`）：`findSlashQuery`（命令 `/`
的判定）、`filterSkills`（打分排序）、`moveSelection`（↑↓ 环绕）。侧栏消费层在
`ChatTab.tsx`。本次把它泛化成 `rankByTerm<T>(items, term, nameOf, hintOf?)` +
`applySlashInsert(text, query, insert)`（原 `applySlashPick` 是"删掉命令"语义，插变量的场景不适用），
`filterSkills` 改为委派 `rankByTerm`，行为与旧用例完全一致。AGENTS.md §5.2/§5.3。

**`/` 的触发条件天然安全**：`findSlashQuery` 要求 `/` 位于草稿开头或空白之后，因此
`https://example.com`、`src/lib`、`3/4` 都不会弹菜单（`tests/var-slash-menu.spec.tsx` 有机检）。

### 2.2 否决：新增运行时直引语法 `{{secret:<id>::<field>}}`

初选是这个方案，取证后**否决**，两条硬理由：

1. **Runner 宿主没有凭证库。** `server/src/executors.ts` 的取值路径里没有任何
   `get-secret`/密码库实现，`server/src/config.ts` 只有 llm / feishu 两类 key；扩展侧凭证存在
   `chrome.storage` 的 `KEY_PASSWORDS`（`src/lib/storage.ts` 的 `listPasswords`），两个宿主
   的数据目录互不相通。直引语法在扩展里也许能取到值，在 Runner 里必然取不到 —— 同一份工作流
   两种行为，违反 §5.6「同一逻辑不允许出现第三条宿主路径」。
2. **6 处校验器只按 `.` 切 token 根。** `integrity.ts`、`producer-completeness.ts`、
   `declare-missing-inputs.ts`、`generated-validation.ts`（挂在 save 卡口）、
   `repair/variable-provenance.ts`、`execution-trace.ts` 都会把 `secret:x::y` 当成一个变量名 ——
   要么判为悬空引用（存不下去），要么把它注册成触发器输入名。改动面 = 全部校验器 + `interpolate`
   （同步函数、约 60 处调用点）。

**最终裁定（用户 2026-10-16 复述）：下拉里选密钥 = 复用/自动插入 `get-secret` 节点**，输入框写
该节点产出的 `{{variableName}}`。`interpolate` 与所有校验器**零改动**，宿主覆盖与今天的
`get-secret` 完全一致（扩展有凭证库、Runner 按既有语义处理该算子）。

### 2.3 `get-secret` 没有默认变量名

`src/lib/workflow/blocks/custom.ts` 明确 `variableName: ''`，注释解释了为何不给默认。因此下拉写入
的必须是**生产者节点真实的 `variableName`**：命中一个名字为空的上游 `get-secret` 时顺手补名
（`SecretProducerPatch.nodePatch`）；只有新建节点才用约定名 `secret_<id>_<field>`
（沿用 `src/lib/storage.ts` 历史记录转换的命名），两侧都过 `sanitizeName` —— 凭证 id 是用户输入，
含 `.` 或花括号会让 token 静默变形。

### 2.4 变量口径 = 仅上游可达

对 `edges` 反向遍历（`reverseReachable`），只列当前节点的祖先产出的名字 + 触发器入参 + 引擎别名 +
循环上下文。图里其他地方存在的变量在此处引用会是悬空引用，宁可不给。

### 2.5 不扩引擎别名白名单（Plan Step 0 的处置）

`ENGINE_PROVIDED_NAMES`（save 卡口认作"引擎自带"的名字）与
`producer-completeness.fallbackVariableOf` 不完全重合，取证结论：

- `lastReadPage` / `lastAttribute` 确实由引擎写入（`executors.ts:980`、`:2300`），但白名单里没有；
- `lastAiResult` 是**幻影名**：`fallbackVariableOf('ai-agent')` 返回它，而 ai-agent 执行器实际写
  `lastAIAgent`（`ai-agent-executor.ts:213,322`），全仓没有 `lastAiResult` 的写入点；
- `get-text` 走 `publishRead`，声明名与 `lastText` **都**写（`:877`），而 attribute-value 只写一个
  （`data.variableName ?? 'lastAttribute'`）—— 所以"有 attribute-value 上游就报 lastAttribute"
  在该节点自命名时是错的。

权衡后**不动白名单**（那是 save 卡口的语义，且 `lastAiResult` 的错账在别处），改为把下拉严格限制在
`ENGINE_PROVIDED_NAMES` 已认可的名字上（`var-suggestions.ts` 的 alias 分支显式
`ENGINE_PROVIDED_NAMES.has(alias)`）。代价：`lastReadPage`/`lastAttribute` 暂不进下拉；
收益：下拉里出现的每个名字都不可能撞 save 卡口，也不会给出"这个节点其实没发布"的假名字。
`lastAiResult` 的幻影映射是存量缺陷，本设计只记录、不顺手改（改它要同时定 ai-agent 的口径）。

## 3. 结构

```
src/lib/workflow/graph-edges.ts      纯：edge 语义（fallback / 回环 / 正常入边 / 反向可达）
src/lib/workflow/var-suggestions.ts  纯：collectSuggestions + filterSuggestions + ensureSecretProducer(补丁)
src/lib/slash.ts                     纯：rankByTerm / applySlashInsert（与聊天共用）
src/workflow-editor/flow/connections.ts   改为委派 graph-edges，签名与旧测试不变
src/workflow-editor/blocks/shared/SlashVariableMenu.tsx  Provider + useFieldSlashMenu（portal 菜单）
src/workflow-editor/blocks/shared/Field.tsx              TextInput / TextArea 两个原语接菜单
src/workflow-editor/App.tsx                              挂 Provider：属性面板 + 算子设置弹窗
```

- **图手术是纯函数。** `ensureSecretProducer(graph, nodeId, ref, newId)` 返回
  `{variableName, reused, added?, edges?, nodePatch?, detached?}`，不碰 DOM、不碰 store，
  所以 vitest 能钉住"插节点 + 改线 + 幂等 + 不擅自接触发器"（AGENTS.md §5.7/§7.3）。
  句柄严格按 `${blockId}-input-1/-output-1`：React Flow 会**静默丢弃**句柄对不上的边
  （`App.tsx` 的 `healEdgeHandles` 注释即此坑）。
- **App 只负责把补丁落到画布。** 复用分支只 `patchNode`；插入分支 `setNodes` 加节点、按 id 调和
  `setEdges`（整体替换会丢 React Flow 自己的 per-edge 状态），并翻 `certificationStatus:'unverified'`
  —— 与所有画布编辑一致。`detached`（该节点没有正常入边可插）时明确 toast 警告，而不是偷偷
  连线或改触发器。
- **两次选同一密钥必然复用**：新节点插入后立刻是当前节点的上游，第二次命中复用分支 ⇒ 幂等。
- **密钥只到元数据。** Provider 加载 `listPasswords()` 后**立刻**投影成
  `{credentialId, fieldKey, label}`，行上显示 `label · fieldKey` + `KeyRound` 图标；`PasswordEntry`
  对象不进入任何 state、不进 DOM（`tests/var-slash-menu.spec.tsx` 断言 DOM 里搜不到值）。
  与 `agent.ts` 的 `list_secrets`（只回 key 不回值）同一不变量。
- **name-defining 字段 opt-out。** 定义名字而不是引用名字的字段（`variableName`、`dataColumn`、
  `attributeName`、cookie `name`、触发器参数 `name`）传 `noSlash` —— 往名字里插 `{{…}}` 只会把
  名字本身弄坏。共享字段组件（`OutputVariableFields`、`AssignVariable`、`SaveToTable`）一处改，
  覆盖几十个算子。GenericForm 按键名正则判定。
- **状态从 DOM 读，不从 React state 推。** 光标与待提交内容只存在于 DOM，props 会慢一帧
  （沿用 `ChatTab` 的做法）；IME 合成期整体跳过；行用 `onMouseDown + preventDefault`，
  否则失焦瞬间 `Field` 的 blur-`fallback` 会把选中的值覆写回空默认值。
- **定位**：`createPortal` 到 `document.body`，`position: fixed` 取输入框 rect，视口下方不够则上翻，
  `z-[9000]` 高于属性面板（50）、低于 modal 背板（10000）；捕获阶段监听 `scroll` / `resize` 跟随
  （侧栏可滚动、`TextArea` 会自动长高）。样式全部 Tailwind 语义 token（§2）。

## 4. 明确不做

不改 `interpolate.ts` 与任何校验器；不做 `{{` 触发；不做 ConditionEditor / NodeGoalInspector /
CodeMirror 里的菜单；不在 Runner 侧新建凭证库；不在编辑器状态或 DOM 里持有密钥值；
不扩引擎别名白名单（理由见 §2.5）。

## 5. 验证

- `tests/graph-edges.spec.ts`、`tests/var-suggestions.spec.ts`、`tests/secret-producer-patch.spec.ts`
  —— 纯逻辑：可达口径、别名/循环名门控、插节点+改线、按 credential 复用、空名 `nodePatch`、
  幂等、`detached`、回环不被拆线。
- `tests/var-slash-menu.spec.tsx`（jsdom，真组件）—— `/` 弹、`https://`/`src/lib`/`3/4` 不弹、
  ↑↓+Enter 写入 `{{…}}`、Esc 不改值、mousedown 选中 `preventDefault`、合成期 Enter 不选、
  `noSlash` 不弹、DOM 里搜不到密钥值、无 chrome 宿主时凭证组为空而不是报错。
- `tests/slash.spec.ts` 扩展覆盖 `applySlashInsert` + `rankByTerm`，原用例照旧。
- 门禁：`pnpm typecheck`、`TZ=UTC pnpm test`、eslint/prettier（按 `git ls-files` 过滤，裸 lint 会因
  tmp tsconfig 硬失败）、`pnpm build`。
- 浏览器证据：见收尾自检 ⑤。

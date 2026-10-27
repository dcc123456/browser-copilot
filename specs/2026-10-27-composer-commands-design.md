# 输入框统一命令与附件入口（2026-10-27）

## 1. 诉求（dcc 原话）

> 压缩 按钮需要删除 使用 /compact 命令替换 类似skill 使用 能用 / 唤出这个命令
> skill 手动使用时 比如 /trans 命令 发送到对话框中 应该连这个命令一起发送 且展示成tag 样式
> 且对话输入框中不再展示 /trans skill 这是一次性调用
> /trans 也应该展示在输入框中 而不是输入框上方 应该和文案在一行中
> 模型选择下拉的弹窗应该展示到选择框的上方 不要遮住选择框
> 聊天的附件选择使用@符号唤出附件选择 并使用输入框的pleacehoder中说明

四件事，都属于 composer 的输入入口：

1. 删掉「压缩上下文」图标按钮，改成 `/compact` 斜杠命令，和技能一起由 `/` 唤出；
2. 手动调用技能（如 `/trans`）是一次性的：命令本身不留在草稿里，技能以 tag 形式出现在
   **输入框内部、与正文同一行**，发送后的用户消息里同样以 tag 展示；
3. 模型选择改成自绘下拉，弹层向上展开，不遮住选择框本身；
4. 输入 `@` 唤起附件选择，placeholder 里说明 `/` 与 `@`。

## 2. 现状取证

- `/` 菜单只列技能：`matches = query ? filterSkills(skills, query.term) : []`，且
  `menuOpen = query !== null && skills.length > 0`（`src/sidepanel/ChatTab.tsx:3515-3517`）。
  没有技能时 `/` 什么也唤不出。
- 选中技能时 `applySlashPick` 把 `/term` 从草稿里删掉、`onSelectSkill(id)` 记下 active
  （`ChatTab.tsx:3543-3558` → `src/lib/slash.ts:123`）。技能会**一直保持**到用户手动清除
  （只有 plan 技能在批准后清除，`ChatTab.tsx:3244-3251`），不是一次性。
- 已有技能 chip 浮在输入框**上沿**（`absolute left-2 top-1.5`，textarea 加 `pt-8`），
  文案是 `Skill: trans`（`ChatTab.tsx:4337-4353`，`chatSkillActive`）。
- 发送时 `chat` 命令带 `skillId`，worker 用 `wrapSkillDirective` 把指令包进模型可见的
  `content`，只把用户原文存进 `displayContent`（`src/background/index.ts:3673-3699`）；
  面板侧用户 turn 的 `Entry` 没有技能信息，回放（`src/background/restore.ts`）也不带，
  刷新后无从得知这一轮用了哪个技能。
- 压缩按钮在 `.actions` 里，`entries.length > 0` 时出现，调 `compactContext()`
  （`ChatTab.tsx:2908-2927`、`4466-4481`）；`chatCompact*` 文案、phase、toast 都在。
- 模型选择是原生 `<select><optgroup>`（`ChatTab.tsx:4482-4506`）。原生弹层由操作系统绘制，
  位置不可控，会盖住控件本身。
- 附件入口只有 📎 按钮与拖放/粘贴（`ChatTab.tsx:4445-4465`、`4369-4380`）；
  placeholder 只提 Enter / Shift+Enter（`/` 提示只在有技能时出现）。

## 3. 决策

**D1 `/compact` 是内置斜杠命令，与技能共用同一份菜单。** 引入 `SlashEntry`
（`{ key, name, description, skill? }`）：命令在前、技能在后，一起过 `rankByTerm`
（`/co` 能同时命中 `compact` 与名字含 co 的技能）。`menuOpen` 改为
`query !== null && entries.length > 0`，不再依赖「有没有技能」。
`/compact` 只在**可执行**时出现（`entries.length > 0 && !busy && !compacting`），
避免菜单给出一个点了没反应的动作。选中后走既有的 `compactContext()`：
一次 `conversations.compact` 命令、phase 行、成功/失败 toast、成功后重拉 transcript 全部复用，
不新增第二套压缩路径。压缩按钮删除（`FoldHorizontal` 一并删除），
`chatCompactContext` 文案改为菜单里的命令说明，键名不变。

**D2 技能调用是一次性的。** `startTurn` 把消息交给 worker 之后立即 `onSelectSkill(null)`：
下一条消息不再默认带上本轮的技能。否决「保持选中直到手动清除」——那是本次要改掉的旧行为；
也否决「按会话记住技能」——需求明确是一次性。plan 技能同样一次性：批准后清除的逻辑
（`answerPlan`）保留，但此时 pin 早已为空，是幂等的。

**D3 技能以 tag 展示，并且这条信息随 turn 落盘。** `WireMessage` 的 user 变体新增
display-only 的 `skillName?: string`（与 `displayContent` 同性质：`toApiMessages` 重建
`{ role, content }`，provider 永远看不到它）。worker 在查 `getSkill(skillId)` 的同时记下
`pinned.name`；`restore.ts` 的 `RestoreMessage` 透传；面板的 `Entry` 拿到后在气泡内渲染
`/name` 的 `.skill-chip`。因此刷新/重开历史后 tag 仍在，历史预览抽屉同样展示。
tag 文案取 `/${name}`（与用户敲的命令一致），不再使用 `chatSkillActive`（该键删除）。

**D4 tag 在输入框内部、与正文同一行，且只缩进第一行。** 首版把 tag 做成 textarea 的 flex 兄弟节点：
tag 与第一行并排，但 textarea 的**整个高度**都被挤窄，长消息每一行都短一截——dcc 明确否决。
改为 tag 绝对定位在输入框第一行行首，textarea 保持满宽，第一行用 `text-indent` 让开 tag 的宽度，
换行后的正文回到最左侧、与输入框同宽（DeepSeek harness 的观感）。
宽度不要靠猜字体：`useLayoutEffect` 量 tag 的 `getBoundingClientRect().width` 加上 6px 间距，
作为运行时值写进 textarea 的内联 `textIndent`（§2 允许运行时动态值），窗口 resize 时重量一次；
jsdom 里宽度为 0，落到 6px，测试只断言「有正缩进 + textarea 满宽 + tag 为 absolute」。
textarea 去掉了自己的边框/背景/内边距（焦点环放在容器的 `:focus-within`）。
否决「contenteditable + 行内 token」：要把整个 composer、IME、拖放、粘贴重写一遍，收益只是换行后文字能回到最左侧，不值得。
输入框内不再保留 `/trans` 原文（`applySlashPick` 已删除）；tag 右侧的 × 沿用
`skillsStopUsing` 作为取消。

**D5 模型下拉自绘、向上展开。** 原生 `<select>` 的弹层由系统绘制，CSS 无法控制位置，
只能换掉：按钮（显示当前模型名，`aria-haspopup="listbox"`）＋ `role="listbox"` 菜单，
容器 `relative`、菜单 `absolute bottom-full right-0`，所以弹层在选择框**上方**展开且不覆盖它。
分组用 `role="group" aria-label={provider.label}`。选中仍只发一条
`provider.activate { id, model }`（D2 of 模型选择设计），失败回滚 + toast 保持不变。
点击外部 / Escape 关闭；回合进行中按钮禁用。

**D6 `@` 是附件手势，不进入正文。** 输入里新敲下一个位于词首（开头或空白之后）的 `@`
时：消费掉这个字符、打开文件选择器。`takeAttachTrigger(previous, next, caret)` 放在
`src/lib/slash.ts`（与 `/` 同一类「控制字符 vs 正文」判定，纯函数可测）：
只认「本次恰好插入了一个 `@`」且它前面是空白/开头，因此 `me@host` 这样的邮箱、
粘贴进来的 `@` 都不会触发。取消选择时 `@` 已被消费——和 `/` 命令被选中后不再留在草稿里
是同一语义。placeholder 改为同时说明 `/`（命令）与 `@`（附件），
`chatPlaceholderWithSkills` 因此删除（`/compact` 让 `/` 提示不再依赖有没有技能）。
`@` 成为附件入口后，工具条上的 📎 按钮（及其 `chatAttach` 文案）删除，隐藏的
`<input type=file>`、拖放与粘贴路径不变；新会话按钮的图标改为加号（`Plus`）。

**D7 chat 模式下的 pin 技能必须真的进 prompt。** 真机探针发现：chat 模式（面板默认）
的 system prompt 是一句 191 字符的身份句，`buildSystemPrompt` 在返回前直接短路，
pin 的技能说明**从未进入模型**——而 `wrapSkillDirective` 写进用户消息的话是
「按 system prompt 里的说明执行」。于是 `/trans` 虽然进了消息、也显示了 tag，
实际效果是空指令。修法：chat 模式仍保持「不 pin 就一句话」的最省 token 形态，
只在该轮有 `activeSkill` 时把 `renderSkillPrompt` 追加在身份句之后；
`tests/tool-config.spec.ts` 增加一条断言（有技能时含说明、且仍不含 SEMI-AUTO），
原有的「chat 模式 < 260 字符」用例不变。这是既有缺陷（chat 模式自 `da041f8`
起如此），本次把它变成可用的技能通道。

**D8 菜单选中态用软底 + 左侧色条，而不是整行实心 accent。** 首版 `.slash-item[data-active]`
直接 `background: var(--accent)`，整行铺满饱和蓝：描述文字只靠 `opacity: .75` 压暗，在蓝底上
几乎读不清，整块高亮也像"文本被选中"而不是菜单焦点。改法是沿用仓库另两处菜单已有的idiom
（模型选择 `bg-accent-soft text-ink`、工作流变量菜单同款）：选中行 `background: var(--accent-soft)`、
正文 `var(--text)`、命令名 `var(--accent)`、描述恢复 `opacity: 1`，再叠一条 `inset 2px 0 0 var(--accent)`
左色条——软底在宽行上单靠自己不够显眼，色条把焦点说清楚。菜单容器加 `padding: 4px`、行 `border-radius: 6px`，
高亮成为内嵌圆角块而非压满整行的色带。深浅两套主题都用真机探针读 computed style 验过：
浅色 `rgba(40,96,207,.1)` 底 + `#18202c` 字 + `#2860cf` 名，深色 `rgba(110,163,255,.14)` 底 + `#e9ecf2` 字。

## 4. 测试与验收

- `tests/slash.spec.ts`：`takeAttachTrigger` 在开头/空白后触发并返回去掉 `@` 的文本与光标；
  词中（邮箱）、粘贴多个字符、光标不在 `@` 之后时不触发。
- `tests/chat-compact-command.spec.tsx`：真实 ChatTab，`restore` 一段对话后输入 `/compact`，
  菜单出现该命令；选中后发出 `conversations.compact` 并重拉 transcript、toast 带上条数；
  `nothing` 时不重拉；回合进行中菜单不提供该命令。原「压缩按钮」用例随之改写。
- `tests/chat-model-picker.spec.tsx`：改为按钮 + listbox。点开列出两个 provider 分组与全部模型、
  当前项 `aria-selected`；点选发一条 `provider.activate`；失败回滚 + toast；没有 provider 时不渲染；
  菜单带 `bottom-full`（向上展开）。
- `tests/chat-composer-commands.spec.tsx`（新）：选技能后草稿里的 `/tr` 被消费、`onSelectSkill`
  收到 id；active skill 的 tag 在输入框内部、绝对定位且 textarea 保持满宽（只缩进第一行）；发送后
  `onSelectSkill(null)`（一次性）；`restore` 带 `skillName` 的消息渲染 `/trans` tag；
  输入 `@` 触发文件选择器且正文不含 `@`；placeholder 同时提到 `/` 与 `@`。
- `tests/attachments.spec.ts`：`toRestoreMessages` 透传 `skillName`，且
  `toApiMessages` 不把它发给 provider。
- 门禁：`pnpm typecheck`、`TZ=UTC pnpm test`、改动文件 eslint + prettier、`pnpm build`。
- 浏览器实证：Chrome for Testing 加载 `dist/`，截图确认（a）`/` 菜单同时列出 `compact` 与技能、
  （b）tag 与正文同一行且在框内、（c）模型弹层在选择框上方、（d）placeholder 含 `@`；
  用探针确认 `/compact` 真的改写了 transcript、发送后的用户气泡带 `/trans` tag。
  同一探针读选中行的 computed style：底色等于 `--accent-soft`（不是 `--accent`）、正文色等于
  `--bc-text`、命令名等于 `--bc-accent`、描述 `opacity: 1`，并截图存档 `tmp/menu-light.png` /
  `tmp/menu-dark.png`（深浅两套主题各一张）。

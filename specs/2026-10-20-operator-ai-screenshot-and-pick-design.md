# 算子助手：截图识别、手动拾取，以及"拾取被页面自己吃掉"的修复

- 日期：2026-10-20
- 状态：已实施（切片 A / B / C 全部落地，见 §9 实施回填）
- 范围：`AI 算子助手`（`src/lib/workflow/operator-advise.ts` + `src/background/operator-advise-engine.ts` + `src/workflow-editor/ai/OperatorChatDock.tsx`）的第三、四、五块能力，以及元素拾取器（`src/inpage/element-picker`）的事件语义修复
- 前置：`specs/2026-10-19-editor-operator-ai-chat-design.md`（切片 1，已上线 bb228b4）、`specs/2026-10-19-operator-ai-observe-and-edit-design.md`（读优先 / 改参数 / 先做一次，已上线 ef34e17）

## 1. 原始诉求（dcc 原话）

1. 算子助手能读截图做识别，拿到 DOM 文本拿不到的屏幕信息，从而更准地加算子。
2. 算子助手支持手动元素拾取：用户自己点一个元素，把它的选择器交给助手。
3. 有些页面的元素是"点空白就消失"的，而拾取器的那一下点击会先触发页面自己的点击动作 → 弹层先关、拾取失败。

## 2. dcc 裁定（覆盖本文推荐）

| 议题                            | 裁定                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拾取器怎么修                    | **吞指针事件 + 键盘提交**两条都做：armed 期间在 window 捕获阶段吞掉 pointerdown/mousedown/click，并加"悬停 + Enter 确认"的免点击路径                              |
| 拾取结果由哪套"元素→选择器"产出 | **使用算子里现有的元素选择器功能**——即现有 `startPicker` 的 `build()/buildXp()/count()` 与 `{selector,findBy}` 载荷，不复活 `build-selector.ts`，不动 `kernel.ts` |
| 截图什么时候截                  | **缺参数时自动附带**（DOM 读不出必填参数的那一轮自动补一次截图重试）                                                                                              |
| 视觉调用走哪条                  | **两条都接、自动选**：视觉模型与当前对话模型同源时把图直接塞进助手那一次调用；否则走 `inspectImage` 拿文字描述进 prompt                                           |

## 3. 选型与证据（仓库现状，逐条核实过）

**截图**：`captureVisiblePage(scope?, opts?)`（`src/background/capture.ts:69`）返回 `dataUrl`，自带"最小化窗口先还原、每秒配额重试一次、browser-internal 页拒绝并说明原因"。JPEG 观测图的既有约定是 `format:'jpeg', quality:60`（`src/background/agent.ts:4617`）。

**视觉模型**：`src/lib/vision.ts` 是唯一的图像→模型通路：`resolveVisionTarget(imageModel, providers, activeProvider)`（:47，`Settings.imageModel = {providerId, model}`，缺省回落 active provider）、`buildVisionRequestBody`（:76，OpenAI 形状 `content:[{type:'text'},{type:'image_url'}]`）、`callVisionModel`（:141，45s 硬超时、软失败返回 `{ok:false,error}`、`observeUsage` 记账）、`inspectImage`（:245，描述元素与屏幕状态，不像 `recognizeImage` 那样强制只回文本）、`preprocessImage`（:271，OffscreenCanvas，service-worker 安全）。

**对话侧能否带图**：`streamCompletion`（`src/lib/llm.ts:656`）的 body 用 `toApiMessages(request.messages)`（:209），user 轮的 `attachments` 会被折成 `image_url` part（:224）。`AttachmentDescriptor`（`src/lib/attachments.ts:20`）带 `dataUrl`。全仓库只有 OpenAI 兼容的 `image_url` 形状，没有 Anthropic `source` / Gemini inlineData（provider 都走 `{baseUrl}/chat/completions`，所以够用；也因此**不要**为别家形状加代码）。

**模型能力元数据**：**不存在** vision/multimodal 标志位。`ProviderProfile`（`src/lib/providers.ts:24`）只有 model/models/thinkingEffort；是否多模态靠用户在 Settings 的"图片识别模型"里自己保证（`src/lib/i18n.ts:2087`）。这就是裁定"两条都接自动选"的判据来源：只能比 `providerId+model` 是否同源，不能探测能力。

**拾取器（已存在，勿再造）**：UI 在 `src/workflow-editor/blocks/shared/ElSelectorActions.tsx:165-186`（Focus 图标 = 拾取，CheckCheck = 校验），`picker:start`/`picker:verify` 走 `chrome.runtime.sendMessage` → `handlePickerMessage`（`src/background/picker-bridge.ts:109`）→ `injectPicker` → `chrome.scripting.executeScript({func:startPicker})`（:93）；结果 `picker:result` 由注入体自己 `chrome.runtime.sendMessage` 直达所有扩展页面（background 只 ack，:135），编辑器按 `pickerId` 认领。载荷只有 `{selector,findBy,multiple}`（校验模式多 `count,verified`）。

**根因（第 3 条）**：`startPicker` 只在 `document` 捕获阶段听 `mousemove/click/keydown`（`src/inpage/element-picker/index.ts:505-507`），`onClick` 只做 `preventDefault()+stopPropagation()`（:404-405）后把元素 `locked`（提交还要再点卡片上的"Select Element"）。事件时序是 `pointerdown → mousedown → mouseup → click`，而现代组件库的"点击空白关闭"绑在 `pointerdown`/`mousedown`（Floating UI、Headless UI、MUI Menu、Vue click-outside 指令），它们在**我们的 click 之前**就执行完了 → 弹层先消失、光标下元素被移除，click 落到背景层，`locked` 锁错或锁空。`onKey` 只处理 Escape（:409-414），没有任何免点击路径。
两点补充：`stopPropagation()` 不拦同节点上更早注册的其他监听器，所以要 `stopImmediatePropagation()`；`preventDefault()` 在 mousedown 上还顺带抑制焦点转移，从而不会触发页面自己的 `focusout`/`blur` 型关闭。

**闭阴影与 CDP**：closed shadow root 里的目标现有 picker 拿不到（:211 `openRoots()` 只走 open root，注释说这类目标由 `chrome.debugger` 驱动），`cdp-shadow.ts:656-674` 已有 `Input.dispatchMouseEvent`。**本次不用 CDP**：仓库既有裁定是"收窄 CDP 使用"已上线又被回退（CDP infobar 是浏览器全局的，每个窗口都挂"正在调试此浏览器"），且不新增第三条驱动通道（AGENTS.md §5.6）。

**否决的候选**：

- 第四份"元素→选择器"实现（新写一个 pick 时的描述器）——按裁定复用 picker 现有 `build()`。已知存量是四份（picker 内联 / `build-selector.ts`（生产死代码，仅 `tests/build-selector.spec.ts` 引用）/ `inpage/record/index.ts:94` / `kernel.ts:634 targetFor`），本次既不增加也不收敛。
- 让 picker 调 `kernel.targetFor` 拿富 `Target{primary,fallbacks[]}`：要改 `kernel.ts` 注入面、bump `kernel-version`，并把新文件写进 `server/tsconfig.json` 的 include 白名单（§5.6/§5.7 镜像契约），收益不抵代价。
- 图像直接常驻进助手 prompt：`streamCompletion` 只支持 OpenAI 形状且 active provider 未必多模态，非兼容时静默丢图。故按裁定拆成两条路 + 同源判据。
- 把截图做成"三态开关默认全读"：每轮都花视觉 token、持续外发屏幕像素。默认仍是 DOM 读。

## 4. 切片 A — 拾取器不再被页面吃掉（先做，它是 B 的可用前提）

改 `src/inpage/element-picker/index.ts`（注入体，**自包含红线**：不得引入模块级 import/闭包外变量，新样式与新文案继续内联）：

1. armed 期间在 **`window` 捕获阶段**（window 是捕获路径的第一站，比现在的 document 更早）为 `pointerdown`、`mousedown`、`click` 安装拦截器：`isOurUi(e)` 命中就原样放行（卡片自己的按钮/复选框/拖拽要用），否则 `preventDefault()` + `stopImmediatePropagation()`。`mousemove` 不吞（高亮靠它，且悬停不会关弹层），`mouseup` 不吞（卡片拖拽靠它收尾）。
2. 锁定改到 `pointerdown`：按下即 `locked = eventTarget(e)` + `refresh()`；随后的 `mousedown`/`click` 只吞不再改 `locked`（指针序列落地时 DOM 可能已变，click 的 target 未必是用户看中的那个）。没有 pointer 事件的极端环境（老引擎/合成事件）保留 click 里的兜底锁定。
3. 键盘提交：`onKey` 增加 `Enter` → `confirmPick()`，并 `preventDefault()+stopImmediatePropagation()`（否则页面把 Enter 当表单提交）。`confirmPick()` 从卡片按钮里抽出来，卡片按钮与 Enter 共用同一条 `picker:result`；无有效选择器时不提交（沿用 `confirmBtn.disabled` 的同一判据）。Escape 行为不变。
4. 免点击路径写进卡片提示：hover 后一行小字"按 Enter 选中该元素 / Press Enter to select the highlighted element"。新增文案双语：`PickerArgs` 加 `locale?: 'en'|'zh'`，由 `ElSelectorActions` 从 `useEditorLocale().locale` 传入、`picker-bridge` 透传，注入体内用小写对照表渲染（§3：卡片文案存量是硬编码英文，只补新增的两条，不顺手改旧的）。
5. 拾取期间页面 JS 照常运行——这是刻意的：吞事件只保证"页面收不到这一下点击"，不承诺冻结页面自身发起的关闭（定时器关弹层仍会关）。文档与手工步骤里都按这个口径写。

**门禁变化**：这一片改了 `executeScript({func})` 的内联函数体 → 收尾自检 ④ `pnpm verify:injected` **从"不适用"变为必跑**（不在 CI，需人工执行）。

## 5. 切片 B — 手动拾取接进助手

- 拾取的"发起 + 认领结果 + 安全超时 + 焦点回编辑器"目前是 `ElSelectorActions` 组件内部的私有逻辑，第二个消费者出现就必须抽（AGENTS.md §5.2）：抽 `src/workflow-editor/blocks/shared/element-pick.ts`，导出 `requestElementPick({mode,findBy,multiple,selector,locale}): Promise<PickedElement>`（PickedElement `{selector,findBy}`），`ElSelectorActions` 与 dock 都用它；行为逐字保持（`pickerId` 生成、120s/15s 超时、`focusEditorWindow`、失败 toast 文案）。
- 命令扩一个字段而非新命令：`workflows.operatorAdvise` 加 `pickedElements?: PickedElement[]`（本轮生效的手动事实，累积到下一次发送）。
- prompt 增一节 `## Elements the user picked by hand`，紧跟现有 `## The page the user is looking at`，指令是"这些选择器是用户亲手点的，逐字用于对应步骤的元素参数；不要再为同一元素造别的选择器；本节与页面读到的内容冲突时以本节为准"。纯函数层可测。
- 聊天窗里一个"拾取元素"按钮（复用 `Focus` 图标 + `wf-icon-btn` 语义类，不加新 class）：点它 → 页面拾取 → 对话里落一条用户行 `已拾取：<selector>`，并把该选择器带进下一次发送。
- 与"先做一次"那条 offer 打通（这是 B 的真正价值）：offer 还挂着时用户拾取了元素 → 若恰好只有一个步骤缺元素参数，就把拾取到的 selector 填进该步骤（`{...data, selector, findBy}`）并**直接落地**，不再要求页面执行一次；多于一个则填第一个缺口、offer 保留继续问。用户因此可以"点两下选中"就绕过动页面。

## 6. 切片 C — 缺参数时自动附带截图

在 `runOperatorAdvise` 内闭环，**一轮最多一次**截图重试，不产生循环：

1. 现状流程不变（读 DOM → 组 prompt → 调模型 → 解析）。
2. 新增判据：`page` 读过、且解析结果里 `proposalsNeedingPage(proposals)` 非空（即真的还缺页面参数），且本轮还没带过图 → 走截图轮。`skipPageRead`（不读页面）时整条截图路径关闭。
3. 截图：`captureVisiblePage(scope, {format:'jpeg', quality:60})`，scope 仍由 `normalScopeFromWindowId(input.windowId)` 得到——只截编辑器自己那个窗口，绝不跨窗。失败不报错终止：把 `error` 记进结果，交回原来的 offer 路径。
4. 路线选择（纯函数 `operatorScreenshotRoute(activeProvider, imageModel)`，可单测）：
   - 未配置 `imageModel`，或解析出的 `providerId+model` 与 active provider 同源 → **inline**：把 `dataUrl` 作为该 user 轮的 `attachments` 交给 `streamCompletion`（`toApiMessages:224` 折成 `image_url`），一次调用模型自己看图。`deps.callModel` 签名从 `(prompt)` 扩成 `(prompt, image?)`，测试仍可注入。
   - 配了独立的图片模型（异源）→ **described**：`inspectImage(target, dataUrl, {prompt, signal, attribution})` 得到文字，作为 `## What the screenshot shows` 文本节拼进第二次调用的 prompt。
   - `described` 是天然兜底：inline 路径要求 active provider 恰好多模态，用户没保证过。所以同源判据只在"用户自己把这个模型同时用作对话与图像模型"时成立。
5. 截图 prompt 明确禁止转录凭据：描述"布局/控件/选项文字/状态"，"不要把看起来像密码、令牌、手机号、身份证、银行卡的内容原样抄出来"。这是文档层面的缓解——**截图无法脱敏**（`redactText`/`isSecretKey` 只能处理文本，`src/lib/workflow/execution-evidence.ts:55`），屏幕像素一旦外发就含所有可见内容。风险写进 i18n tooltip 与本节，让"自动附带"是知情选择。
6. 预算：`described` 分支的描述文本截到常量 `OPERATOR_SCREENSHOT_NOTE_CAP = 1200`（与 `EVIDENCE_*` 同一风格命名），第二次的 prompt 里 DOM 节与图节共存但不重复展开。
7. 结果契约加一个字段供 UI 报告：`screenshot?: { route:'inline'|'described'; taken:true; error?:string }`。dock 在答复行下多一行 `已附带当前页面截图（缺参数时自动）` / 失败原因，让用户知道屏幕内容外发过。

## 7. 测试

- `tests/element-picker.spec.ts`（新增，jsdom，`startPicker` 直接 mount + `chrome.runtime` 打桩）：armed 时 `pointerdown`/`mousedown`/`click` 在 window 捕获即被吞（`defaultPrevented`、页面监听器不被调用——用先注册的对照监听器证明 `stopImmediatePropagation` 生效）、卡片内事件放行、hover+Enter 发出 `picker:result` 且只发一次、Enter 无有效选择器时不发、Escape 仍发 `picker:cancel`、pointerdown 之后 click 到来时 `locked` 不被 DOM 变化改走。
- `tests/operator-advise.spec.ts`：`pickedElements` 渲染出的节位置与措辞、与页面节冲突时的优先级指令、无拾取时不出现该节；`operatorScreenshotRoute` 的三种输入（未配置 / 同源 / 异源）。
- `tests/operator-advise-engine.spec.ts`：缺参数才截图（参数齐 → 完全不截，`capture` 调用数 0）；截图轮只跑一次（第二次仍缺参数不再无限重试）；`skipPageRead` 关掉整条路；inline 路线把 `attachments` 交给注入的 `callModel`；described 路线把描述文本进 prompt 且被 cap；`captureVisiblePage` 失败 → 结果带 `error` 且正常走 offer。
- `tests/acceptance-operator-chat-dock.spec.tsx`：拾取按钮触发 `requestElementPick`（打桩）、拾取到的 selector 随下一次 `workflows.operatorAdvise` 发出、offer 挂着一个缺口时拾取直接落地（`onApply` 收到填了 selector 的 proposals，且不发 `workflows.operatorObserve`）、多缺口时填第一个并保留 offer。
- `pnpm verify:injected` 必跑（§4 改了注入体）。

## 8. 收尾自检口径

- ①：`pnpm typecheck`、`pnpm test`、`TZ=UTC pnpm test`、eslint+prettier 按 `git ls-files` 集合（bare `pnpm lint` 会因 `tmp/` 误红）、`pnpm build`。
- ②：不碰 `server/**`，Runner 侧不适用（`pnpm server:typecheck`/`server:test` 仍会顺手跑一次作为回归）。
- ③：不动 `src/lib/workflow/ai-takeover.ts` 与 `src/background/workflow-engine/**` → `bench:debug` 不适用；若切片实施中确实触碰了 engine，必须补跑并报告 before/after。
- ④：**适用**——切片 A 修改 `executeScript({func})` 内联函数体，`pnpm verify:injected` 必须人工跑并贴输出。
- ⑤：扩展页不可脚本化 → BLOCKED，给编号手工步骤：(a) 在一个"点空白会关闭"的下拉页上按旧路径复现失败，再验证按下去就能锁定、Enter 即提交、页面弹层不关；(b) 助手缺参数时确认自动截图那条报告行出现、参数按截图补齐；(c) 配一个异源 imageModel 验证走描述路线；(d) "不读页面"时确认既不读也不截。
- ⑥：拾取器/截图/视觉均复用既有设施，无第二套；`element-pick.ts` 的抽取由第二个消费者触发（§5.2）。
- ⑦⑧⑨⑩：注入体自包含、新文案双语、临时产物只进 `tmp/`、提交英文。

## 9. 实施回填（2026-10-21）

三个切片都已落地。与设计不同的地方逐条列出，并写明为什么改。

**切片 A（拾取器事件语义）** — `src/inpage/element-picker/index.ts`，`src/background/picker-bridge.ts` 透传 `locale`，`tests/element-picker.spec.ts`（新增 11 行）。window 捕获吞 pointerdown/mousedown/click + Enter 提交 + 悬停提示，全部按 §4 实施；`confirmBtn.disabled` 是唯一提交判据，Enter 与卡片按钮共用 `confirmPick()`。无偏差。

**切片 B（手动拾取接进助手）** — 新增 `src/workflow-editor/blocks/shared/element-pick.ts`，`ElSelectorActions.tsx` 改为消费它，`operator-advise.ts` 加 `PickedElement` / prompt 节 / `proposalIndexesNeedingPage`，命令加 `pickedElements`，dock 加拾取按钮与 `fillOfferWith`。偏差三条：

1. `requestElementPick({findBy, multiple, locale})` 没有 §5 写的 `mode` / `selector` 参数：抽出来的只做"拾取"这一趟往返，`verify` 那趟另出 `verifyElementSelector()`（两者共享监听器/安全超时/焦点归还，但载荷不同）。失败原因也集中成 `describePickFailure()`，两个消费者同一套话。
2. 拾取按钮用 Tailwind 语义类（与"读取页面"开关同款式），没用 §5 写的 `wf-icon-btn`——§2 要求新样式走工具类。
3. offer 的落地条件实现为"每次拾取填一个缺口，缺口清零即落地"：两格缺元素时点两下就绕过动页面，这与 §5"恰好一个直接落地、多于一个填第一个"是同一判据的连续版本，不是新功能。

**切片 C（缺参数时自动附带截图）** — `operator-advise.ts` 加 `operatorScreenshotRoute` / `OPERATOR_SCREENSHOT_QUESTION` / `OPERATOR_SCREENSHOT_NOTE_CAP` / prompt 的 `screenshot` 入参，引擎内闭环一次重试，dock 加 `ScreenshotLine`。偏差四条：

1. `OperatorScreenshotReport.taken` 从 §6.7 的恒 `true` 扩成 `boolean`："没截到"（屏幕没外发）与"截到但那一轮没成"（屏幕已经外发）是两件事，用同一行文案会撒谎。
2. inline 路线的第二次调用同时改了 prompt（新增"图已附在本请求"一节）。§6.4 只说挂 `attachments`——不写这一节，模型不知道这张图是来补哪个参数的。
3. 注入面按 §6.4 扩了 `callModel(prompt, image?)`，另加 `captureScreenshot` / `describeScreenshot` / `screenshotRoute` 三个可注入点：否则两条路线无法分别测，且默认实现要读 Settings。
4. 第二次调用失败或不可解析时**保留第一次的答案**并带 `error`，而不是整轮失败：屏幕像素已经外发，再白报一次错误只会丢掉本来可用的 offer。

**测试口径**：dock 那套 harness 的 `t` 是 key 透传，`.replace('{keys}' | '{error}', …)` 插不进去，所以"缺口列表""失败原因"这类插值文字一律在纯函数层与引擎层断言；dock 只断言"出现的是哪一行报告"。`tests/condition-editor-picker.spec.tsx` 有一行改成 `async` 并把回包裹进 `act()`——选择器现在跨一个 await 才回到行里。

**门禁实测**（2026-10-21，基线 `d318388`）：`npx tsc --noEmit` 与 `-p tsconfig.tests.json` 均无输出；`TZ=UTC npx vitest run` 407 files / 4693 tests 全绿；`npx eslint` 对本主题 15 个改动文件 exit 0；`npx prettier --check` 同集合全绿；`npx vite build` 成功；`node scripts/verify-injected-functions.mjs` → `OK - every injected function is self-contained`（20 个注入体 / 24 个调用点，唯一未静态可解析的站点是既有的 `src/background/workflow-engine/ai-agent-executor.ts:108`）；`pnpm server:typecheck` 干净，`pnpm server:test` 12 files / 102 tests 全绿。③ `bench:debug` 不适用（未触碰 `ai-takeover.ts` 与 `workflow-engine/**`）。⑤ 仍 BLOCKED（扩展页不可脚本化），按 §8 的 (a)–(d) 手工验证。

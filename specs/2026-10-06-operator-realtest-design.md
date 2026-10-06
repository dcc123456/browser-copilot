# 设计：工作流算子的真实测试床与逐算子判定

日期：2026-10-06
状态：进行中（本轮结论已落地为代码修复，逐算子判定见 §6）

## 1. 问题

工作流编辑器有 67 个算子节点。此前的质量手段是三层：catalog 元数据、单元测试（构造 IR 断言编译结果）、以及生成链路（目标→图→重放）的端到端 selftest。这三层都无法回答一个最基本的问题：

**每个算子在自己的编辑表单所暴露的每一项功能上，是否真的可用？**

单元测试只验证「图能编译」，不验证「节点执行后页面发生了什么」；selftest 只跑生成出来的少数图，覆盖不到未被生成的算子；而 catalog、operator guide、Edit 表单、executor 读取的 key 分布在四个互不校验的位置，任何一处拼写漂移都会让一个控件永久失效却无人报错（历史上 `get-text` 的 collect 三件套、`export-data` 的整个字段集、`switch-tab.tabIndex` 就是这样同时坏掉的）。

## 2. 目标与判据

- 对**每一个**算子，用它自己的编辑表单实际写出的数据形状，在真实浏览器里跑一次；
- 判定依据必须是**页面侧或服务端的可观测事实**（DOM 文本、服务端记录、写出的文件、发出的 webhook），不允许用「节点没报错」「日志好看」当证据；
- 每个算子的每一项功能都要有明确结论：PASS / FAIL（附根因）/ BLOCKED（附环境原因）。

## 3. 测试床

```
tmp/operator-matrix/
  fixture.mjs   一次性夹具站点（:8798，仅回环）：/read /form /detail /frame /scroll
                /upload /cookies /dialog /popup /clipboard /events /slow /ocr /interact
                /state + /api/hook /api/form /api/upload /api/state /api/reset /api/json
  cases.mjs     146 条用例：{ id, block, feature, workflow, assert, explain }
  matrix.mjs    逐条：清证据 → 建图 → 经 Runner API 真跑 → 断言 → 写 report.json / operator-matrix.md
  bed.mjs       Runner 客户端（登录、建 workflow、触发 run、取 state）
```

- **执行引擎就是产品本身**：用例经 Runner（:8799，Playwright Chromium）走 `src/background/workflow-engine/engine.ts` + `server/src/executors.ts`，与扩展共享同一引擎与同一套块语义；不存在为测试写的第二套执行器。
- **证据取回**：`webhook` 节点把 `{{变量}}` 发到 `/api/hook`（fixture 原样回显并留存），因此断言读的是「页面被读回来的值」而不是「节点返回值」；表单值、上传字节、下载计数、cookie 由 fixture 服务端记录。
- **一次性夹具不进入产品**：全部留在 `tmp/`（§7 的 spike 约束），`data/` 产物目录同理不入库。

启动 / 停止：

```
node tmp/operator-matrix/fixture.mjs &
cd server && BC_TOKEN=<t> BC_PORT=8799 npx tsx --import ../tmp/operator-matrix/defines.mjs src/main.ts &
node tmp/operator-matrix/matrix.mjs            # 全量
node tmp/operator-matrix/matrix.mjs --only data # 单子集
```

## 4. 本轮发现并修复的系统性缺陷

每条都有逐算子用例作为证据（修复前 FAIL，修复后 PASS），且扩展与 Runner 端口两侧同步落地（§5 的锁步要求）。

1. **`assignVariable` 无人读取**。16 个算子的输出条（`AssignVariable` 组件）写 `assignVariable`/`variableName`，而两个 executor 文件里 `assignVariable` 的读取次数为 0。即「把结果存到变量」这个控件在全部 16 个算子上都是死的。修法：新增共享 `applyAssignVariable()`，各块在真正产出结果处调用。
2. **数据类算子的表单/执行器词汇漂移**。`insert-data`/`delete-data`/`sort-data`/`data-mapping` 的 executor 各自发明了一套 key（`data`、`dataList` 当字符串、`deleteList[].type` 被忽略、排序按 `sortByProperty` 单字段），与 `Edit*.tsx` 实际写出的形状不一致：编辑器里配好的表格列、变量删除、按多字段降序、字段改名，运行时静默变成 0 行或无效。修法：按编辑器契约读取，数组优先于 JSON 字符串（`String(arr)` 会得到 `[object Object]` 并解析为 0 行）。
3. **`log-data` 无落点**。它 emit 一个没有任何表单写入的 key，且系统根本没有运行日志存储（`saveLog` 只是 workflow 设置项）。修法：引擎把当前运行的 `stepLines` 通过 `ctx.getRunLog()` 暴露给 executor；`log-data` 读它并遵守 `assignVariable`/`saveData`/`dataColumn`；被要求读**其他工作流**的历史时抛错而不是静默成功（`visible-failure` 守卫不允许把失败降级成一条日志）。
4. **分支 handle 词汇**（harness 侧缺陷，但暴露了真实风险）。编辑器写出的 handle id 是 `<blockId>-output-1|2`，而 `BRANCH_KEYS` 只把这两个 id 映射为 `true/false`、`exists/notExists`、`loop/end`；直接写 `conditions-false` 这类「标签名」的图，false 分支会静默落到 `defaultNext`。用例改用真实 handle 形状后，`conditions`/`element-exists` 的假分支第一次被真正执行到（此前 14 条条件用例里的 false 分支全是空跑）。
5. **`condition-tree.ts` 抽取**。条件树（AND 行 / OR 组、`elementExists`/`elementText`/`variableValue` 判据、旧版扁平 `{name,compare,value}` 兼容）原先只长在扩展的 executor 文件里，端口只能重写一遍。抽到 `src/lib/workflow/condition-tree.ts` 供两侧 import（`server/tsconfig.json` 白名单已覆盖），并把无人调用的 `conditionRowMatches` 取消导出。
6. **`block-output.ts` 的必要性论证（§5.3 要求）**。它不是第三套基础设施：里面只有两个 executor 文件里**逐字重复过**的语义（输出条写入、`dataList` 形状归一、数据项比较），且两侧各自 import 同一份；不抽它就必须让 `server/` 复制第二份，正是 §5 禁止的模式。

第二轮（逐算子跑完后暴露、并已两侧同步修复）：

7. **`switch-tab` 的标签查找**。端口只读 `index` —— 一个编辑器从不写的 key —— 于是任何手工配的节点都跳到 0 号标签并且报告「已切换」。现在两端共用 `pickTabIndex()`，按 `findTabBy` 的五种编辑器词汇各取所需（`match-patterns`/`tab-title`/`next-tab`/`prev-tab`/`tab-index`），端口补上标题读取与 `createIfNoMatch`，越界索引直接抛错。
8. **`close-tab` 不跟随活跃标签**。关掉一个标签后运行的 `tabId` 仍指着已经死掉的标签，后续每一步都在驱动不存在的页面。两端改为在关闭后取回 Chrome/Playwright 交接的活跃标签（`ctx.setTab`）。
9. **`regex-variable` 的 match 丢掉了 `g`**。构造正则时剥掉 `g` flag，使「匹配全部」只返回第一个匹配。现在按 flag 决定取全部还是取第一个。
10. **`press-key` 的组合键**。`Ctrl+A` 被整体当成一个键名派发，且 `new KeyboardEvent({key})` 不带 `keyCode/which`（DraftJS 一类编辑器只看 `which`）。新增 `parseKeyCombo()` 拆出修饰键与主键（含 `+` 自身、Shift 的大小写），两个派发点（无目标 / 有目标）都走它，Enter 才按表单提交处理。
11. **`trigger` 声明的运行参数在端口从未播种**。编辑器与 PUT 图把参数写在 trigger **节点**的 `data.parameters` 上，端口只读 `workflow.trigger.parameters`（只有生成路径会填），于是 `{{city}}` 在 Runner 上全部悬空 —— 图默认值如 `city = Shanghai` 也一起失效。修法：顶层 mirror 缺失时用 `triggerFromNodes(drawflow.nodes)` 派生后再播种。
12. **`forms` 的「Get form value」在端口不存在**。扩展侧早已实现（读值并保持原生类型），端口完全没有 `getValue` 分支：勾选「读取表单值」的节点在 Runner 上会走写入路径，把要读的控件**清空**。现补 `readFormValue()`（缺 `variableName` 直接抛错）。
13. **`element-scroll` 的 `incX`/`incY` 复选框无人读取**。两端一律发 `mode:'by'`（相对），而关掉复选框（编辑器默认）按 Automa 语义应是**绝对位置**：同一个节点重放两次就滚两倍。新增 `ScrollSpec` 的 `mode:'to'` 与逐轴 `xIncremental`/`yIncremental`，判定抽成共享 `scrollSpecFrom()`（数字形状的 `incX` 仍按相对处理，兼容对话生成的节点）；顺带修 `operator-history.ts` 把布尔当金额用（`incX:false` 时 `x=false` → 滚 0）。
14. **`proxy` 不可能工作却报告成功**。扩展清单里没有 `proxy` 权限，服务端只能通过运行参数配置代理 —— 这个块在任何宿主都无法改变网络出口。原来是 `emit('info')` + 继续（看起来像成功），现在直接失败并说明原因。
15. **`KNOWN_INERT` 白名单收缩**。守卫现在会顺着 `block-output.ts` / `ai-agent-executor.ts` 解析共享 helper 里的 `data[...]` 读取，11 条「参数其实已被读取」的过期豁免被删除（`get-text.prefixText/suffixText`、`forms.selected/selectOptionBy/optionPosition`、`press-key.selector`、`create-element.javascript/css`、`workflow-state.type/throwError/errorMessage`、`switch-to.selector`），只留下真实不生效的（如 `ocr.findBy` —— 页面捕获原语只吃 CSS 选择器）。
16. **`clipboard.copySelectedText` 在两个宿主都不生效**。表单复选框、catalog 默认值、`operator-tools` 的广告列表三处都有这个字段，唯独 executor 不读它：`get` 分支永远读系统剪贴板，勾选「Copy selected text」拿到的是**上一个块复制进去的内容**。真跑证据：fixture `/clipboard` 的 `#copyable` 是 `CLIPBOARD-MARKER-7731`，而修复前变量里是上一用例写入的 `clip-text-123`。现在两宿主在 `copySelectedText === true` 时用 kernel 读页面选区（`pageSelectionText`）。注意静态守卫没抓到这条——`clipboard` 没有作为算子工具暴露，守卫按 `isOperatorTool` 跳过了整块；这类不生效只有真跑矩阵能发现。
17. **服务端 webhook 的响应记录缺 `data`**。扩展存 `{status, ok, headers, body, data}`（`data` 按 `responseType` 解码、按 `dataPath` 收窄），端口只存 `{status, ok, headers, body}`，且 `contentType`/`responseType`/`dataPath` 三个表单字段一概不读——于是 `{{resp.data.total}}` 在扩展里取到 2、在服务端原样悬空。`webhookContentTypeOf` + `webhookRecord`（内含 parseResponseBody/pickDataPath/toBase64）上提到 `src/lib/workflow/block-output.ts`，两宿主同一份实现，扩展侧原有的四个本地 helper 删除。
18. **`handle-download` 的 `timeout` / `waitForDownload` 两个字段都不生效**。扩展只做一次 `chrome.downloads.search({})` 就报「未找到匹配下载」——点击触发的下载通常还没落盘；端口确实等待，但硬编码 30s，块自己的 `timeout` 无人读取（用例设 20s 实测跑了 32s）。现在两侧都按 `timeout` 轮询（`waitForDownload: false` 时不等待），`KNOWN_INERT` 里相应只留 `downloadId`。
19. **`javascript-code` 语句体里的顶层 `await` 编译即死**。kernel 只对「不含语句关键字」的裸表达式做 async 包装；`const r = await fetch(...); return (await r.json()).total` 这种最常见的写法落进同步 `new Function` 体，在编译期就抛 `await is only valid in async functions...`。现在语句体编译失败且代码含 `await` 时重试一次 async IIFE 包装（包装也编译不过则抛原始错误，不把真正的语法错误换成噪音）。
20. **`link` 块（同标签页）在导航真正开始前就报完成**。`waitForLoaded` 读的是**上一份**文档的 load 状态：合成点击返回时导航还在队列里，于是端口立刻报「已点击链接」。紧跟 `go-back` 时，历史回退发生在导航中途，页面落到 `about:blank`（探针实测 `AFTERBACK=about:blank`、`history.length=3`）。端口新增 `driver.currentUrl` + `waitForUrlLeave`，同标签页点击后先等 URL 离开原值再等 load；锚点（`#`）与 `javascript:` 链接不等。

## 5. 复现与验证

- 单元层：`pnpm typecheck && pnpm test`（含 `tests/operator-param-coverage.spec.ts` 的四条守卫：广告出去的参数必须被读到、UI-only key 不得被重新广告、KNOWN_INERT 不得过期、算子不得无 executor）。该守卫现在会把 `src/lib/workflow/block-output.ts` 一并解析，否则共享 helper 里的 `data['variableName']` 会被误判为「无人读取」。
- 端口层：`pnpm server:typecheck && pnpm server:test`。**端口改动必须单独跑 `server:typecheck`**：根 `pnpm typecheck` 不覆盖 `server/`，本轮就在 `server/` 里写过 `effective.nodes`（图实际在 `effective.drawflow.nodes`），类型检查没拦到、真跑时 146 条用例一起崩成 `Cannot read properties of undefined (reading 'find')`。
- 真实浏览器层：`node tmp/operator-matrix/matrix.mjs`（本报告 §6 的全部结论来源）。
- 引擎相关改动附带 `pnpm bench:debug`。

## 6. 逐算子判定

规模：面板 67 个算子（`BLOCK_CATALOG` 63 + `CUSTOM_BLOCKS` 4），146 条真跑用例覆盖 62 个，其余 5 个记入 `UNTESTABLE`（cloud-only / 需真实 Google 授权，见 §7）；`tmp/operator-matrix/coverage.mjs` 双向校验「算子没有用例」与「用例指向不存在的算子」，当前两侧都是 0。逐条观察证据（每步日志、hook 收到的 JSON、下载/上传计数）在机器生成版 `tmp/operator-matrix/operator-matrix.md`；本节只给结论。

最后一轮全量：**140 PASS / 3 FAIL / 3 BLOCKED**。判据的证据面：矩阵跑的是 Runner 端口，但它与扩展共用同一引擎（`src/background/workflow-engine/engine.ts`）、同一页面 kernel（端口直接 `import { runExecJs, runOp, runWorkflowJs } from '../src/inpage/kernel'`）与同一批共享 helper，只有 executor 的宿主 API 调用是两份对照实现；扩展侧的改动由 `pnpm test`（3823 例）与静态参数守卫把关。收敛过程：一次崩盘 8 PASS / 138 FAIL（`effective.nodes` 事故）→ 127 → 134 → 138 → 140，其间 16→3 的差额里，产品缺陷与「用例自己写错/证据通道竞态」几乎各半（§4 第 11-14 条与 §5）。

四类判定：

1. **功能正常**——140 条。判据不是「没报错」，而是本轮修复前反复出现的那类假绿：证据必须由「块自己产生、且只有这条功能生效才可能出现的形状」承载（见 §4 第 11-13 条）。
2. **端口能力缺失，不是产品缺陷**——2 条：
   - `forms.content-editable`：kernel 在 `src/inpage/kernel.ts:1404` 明确返回「编辑器未接受模拟输入（内部状态未更新，字数仍为 0）。将尝试通过受信任键盘输入重试」，扩展宿主确实接住了这条重试（`src/background/driver.ts:593` + `src/background/cdp-typing.ts:265`，走 chrome.debugger 受信任按键），端口没有对应实现。扩展内可用，服务端不可用。
   - `switch-to.iframe`：两个宿主里这个块都只打印一行「已定位 iframe …」（扩展 `executors.ts:2869-2875`、端口 `server/src/executors.ts:1752-1758`），不改变后续步骤的作用域。扩展之所以还能读 iframe 内容，是 driver 以 `allFrames: true` 注入 kernel、在所有 frame 里排序取最佳（`src/background/driver.ts:2、8、495`）；端口经由同一 kernel 只读主框架，所以用例里 `#frame-title` 读不到。判定：算子本身没有可观察效果（一条日志），要真正生效需要引入 run 级 frame 上下文并让目标解析遵守它——跨宿主架构改动，不在本轮范围。
3. **语义无法实现（架构）**——1 条：`wait-connections.join-incoming-flows`，单路径引擎（§7）。
4. **本环境无法验证**——3 条 BLOCKED：`proxy.apply`（扩展未声明 proxy 权限，块按设计直接抛错）、`ai-agent.read-only`（无 `BC_LLM_*` 模型配置）、`upload-file.set-file`（headless 无 OS 文件选择器，`user-select` 模式按设计拒绝）。

### 6.1 广告出去但确实不生效的功能

`tests/operator-param-coverage.spec.ts` 的 `KNOWN_INERT` 就是这份清单的机器版（守卫强制它不许过期：本轮 `handle-download` 的 `timeout`/`waitForDownload` 被真实读取后必须立刻从表里删掉）。以下功能在两个宿主里都不存在，用户或模型勾选了也不会发生任何事：

- **`save-assets` 整块是占位实现**：扩展与端口都只 `emit('info', …占位)`，`selector`/`type`/`url`/`filename`/`saveDownloadIds`/`variableName`/`saveToGDrive`/`findBy`/`waitForSelector`/`waitSelectorTimeout` 十一个字段无人读取。矩阵里的 `save-assets.element-image` 只证明它不崩，不证明它保存了资源。
- **`proxy` 整块未实现**（`scheme`/`host`/`port`/`bypassList`/`clearProxy`），并且是按设计「宁可直接失败也不静默」。
- `get-text`：`regex`/`regexExp`（正则清洗不做）、`addExtraRow`/`extraRowValue`/`extraRowDataColumn`（不往数据表补行）、`findBy`；`attribute-value` 的同一组附加行字段。
- `conditions`：`retryConditions`/`retryCount`/`retryTimeout`——表单里的「重试直到条件成立」不生效。
- `element-exists`：`tryCount`/`timeout`/`throwError`——只查一次、永不等待、永不抛错。
- `javascript-code`：`context`（website/transformed 一律当 website）、`preloadScripts`、`everyNewTab`、`runBeforeLoad`。
- `press-key`：`pressTime`（长按时长）、`action`（keyDown/keyUp 拆分）。
- `notification`：`iconUrl`/`imageUrl`；`parameter-prompt`：`timeout`（永不超时）；`workflow-state`：`exceptCurrent`/`workflowsToStop`（只停当前流）。
- `create-element`：`insertAt`/`selector`/`waitForSelector`/`waitSelectorTimeout`/`preloadScripts`/`runBeforeLoad`/`findBy`——插入位置与等待都不生效。
- `trigger-event`：`waitForSelector`/`waitSelectorTimeout`；`forms`：`delay`；`ocr`：`findBy`（页面捕获原语只吃 CSS 选择器）；`handle-download`：`downloadId`；`browser-event`：端口整块不支持，扩展依赖常驻 content script。

### 6.2 逐算子判定表

由最后一轮全量 `report.json` 与 `KNOWN_INERT` 联接生成（`cd server && npx tsx ../tmp/operator-matrix/block-table.mjs`）。用例列是 `P/F/B` 计数。两条判读约束：**「正常」是矩阵判据下的正常**——`save-assets`、`browser-event` 这类占位/拒绝实现块的用例只证明「不崩」或「按设计报错」，真实结论在 §6 与 §6.1；**「不生效字段」列是静态守卫的机器清单**（广告给模型但 executor 不读），不是矩阵跑出来的结论。

| 算子 | 用例 | 判定 | 不生效的已广告字段 |
| --- | --- | --- | --- |
| `trigger` | 4: 4P/0F/0B | 正常 | — |
| `ai-workflow` | 0 | 不可测（cloud-only 块） | — |
| `execute-workflow` | 1: 1P/0F/0B | 正常 | — |
| `active-tab` | 1: 1P/0F/0B | 正常 | — |
| `new-tab` | 3: 3P/0F/0B | 正常 | — |
| `switch-tab` | 3: 3P/0F/0B | 正常 | — |
| `new-window` | 1: 1P/0F/0B | 正常 | — |
| `proxy` | 1: 0P/0F/1B | 环境阻塞（整块未实现，按设计抛错） | — |
| `go-back` | 1: 1P/0F/0B | 正常 | — |
| `forward-page` | 1: 1P/0F/0B | 正常 | — |
| `close-tab` | 1: 1P/0F/0B | 正常 | — |
| `take-screenshot` | 2: 2P/0F/0B | 正常 | — |
| `read-page` | 4: 4P/0F/0B | 正常 | — |
| `browser-event` | 1: 1P/0F/0B | 正常（端口按设计拒绝） | timeout, eventName, setAsActiveTab, activeTabLoaded, tabLoadedUrl, tabUrl, fileQuery |
| `event-click` | 4: 4P/0F/0B | 正常 | — |
| `delay` | 1: 1P/0F/0B | 正常 | — |
| `get-text` | 7: 7P/0F/0B | 正常 | findBy, regex, regexExp, addExtraRow, extraRowValue, extraRowDataColumn |
| `export-data` | 3: 3P/0F/0B | 正常 | — |
| `element-scroll` | 3: 3P/0F/0B | 正常 | — |
| `link` | 2: 2P/0F/0B | 正常 | — |
| `attribute-value` | 2: 2P/0F/0B | 正常 | addExtraRow, extraRowValue, extraRowDataColumn |
| `forms` | 12: 11P/1F/0B | 部分不通过（contenteditable 需端口缺受信任按键重试） | — |
| `repeat-task` | 1: 1P/0F/0B | 正常 | — |
| `javascript-code` | 3: 3P/0F/0B | 正常 | context, preloadScripts, everyNewTab, runBeforeLoad |
| `trigger-event` | 1: 1P/0F/0B | 正常 | waitForSelector, waitSelectorTimeout |
| `google-sheets` | 0 | 不可测（需真实授权凭据） | — |
| `google-sheets-drive` | 0 | 不可测（cloud-only 块） | — |
| `google-drive` | 0 | 不可测（需真实授权凭据） | — |
| `conditions` | 14: 14P/0F/0B | 正常 | — |
| `element-exists` | 3: 3P/0F/0B | 正常 | findBy, tryCount, timeout, throwError |
| `webhook` | 5: 5P/0F/0B | 正常 | — |
| `while-loop` | 2: 2P/0F/0B | 正常 | — |
| `loop-data` | 5: 5P/0F/0B | 正常 | — |
| `loop-elements` | 1: 1P/0F/0B | 正常 | — |
| `loop-breakpoint` | 3: 3P/0F/0B | 正常 | — |
| `blocks-group` | 1: 1P/0F/0B | 正常 | — |
| `clipboard` | 2: 2P/0F/0B | 正常 | — |
| `insert-data` | 3: 3P/0F/0B | 正常 | — |
| `switch-to` | 1: 0P/1F/0B | 不通过（两宿主都只打印日志，不改作用域） | — |
| `upload-file` | 1: 0P/0F/1B | 环境阻塞（headless 无 OS 文件选择器） | — |
| `hover-element` | 1: 1P/0F/0B | 正常 | — |
| `save-assets` | 1: 1P/0F/0B | 正常（仅「不崩」；两宿主都是占位实现） | findBy, waitForSelector, waitSelectorTimeout, selector, type, url, filename, saveDownloadIds, variableName, saveToGDrive |
| `press-key` | 2: 2P/0F/0B | 正常 | pressTime, action |
| `handle-dialog` | 3: 3P/0F/0B | 正常 | — |
| `handle-download` | 1: 1P/0F/0B | 正常 | downloadId |
| `save-local` | 1: 1P/0F/0B | 正常 | — |
| `reload-tab` | 1: 1P/0F/0B | 正常 | — |
| `delete-data` | 3: 3P/0F/0B | 正常 | — |
| `wait-connections` | 2: 1P/1F/0B | 部分不通过（汇合语义单路径引擎无法实现） | specificFlow, flowBlockId |
| `notification` | 1: 1P/0F/0B | 正常 | — |
| `log-data` | 1: 1P/0F/0B | 正常 | — |
| `tab-url` | 2: 2P/0F/0B | 正常 | — |
| `slice-variable` | 2: 2P/0F/0B | 正常 | — |
| `increase-variable` | 2: 2P/0F/0B | 正常 | — |
| `regex-variable` | 2: 2P/0F/0B | 正常 | — |
| `data-mapping` | 1: 1P/0F/0B | 正常 | — |
| `sort-data` | 3: 3P/0F/0B | 正常 | — |
| `create-element` | 2: 2P/0F/0B | 正常 | preloadScripts, findBy, insertAt, runBeforeLoad, waitForSelector, waitSelectorTimeout, selector |
| `cookie` | 2: 2P/0F/0B | 正常 | — |
| `block-package` | 0 | 不可测（cloud-only 块） | — |
| `note` | 1: 1P/0F/0B | 正常 | — |
| `workflow-state` | 2: 2P/0F/0B | 正常 | exceptCurrent, workflowsToStop |
| `parameter-prompt` | 1: 1P/0F/0B | 正常 | timeout |
| `ai-agent` | 1: 0P/0F/1B | 环境阻塞（无 `BC_LLM_*` 模型配置） | — |
| `ocr` | 1: 1P/0F/0B | 正常 | — |
| `set-variable` | 2: 2P/0F/0B | 正常 | — |
| `get-secret` | 1: 1P/0F/0B | 正常 | — |

## 7. 已知边界

- `ai-workflow` / `block-package` / `google-sheets-drive` 是 cloud-only 块（`isCloudBlock`），本地面板不展示、本地执行拒绝，不构成本地缺陷。
- `google-sheets` / `google-drive` 需要真实 Google 授权，本环境无凭据。
- `trigger-event` / `interact-handle-download` 一类依赖原生弹窗、真实用户手势或 OS 剪贴板权限的路径，在 Playwright 无头环境里的表现与扩展内不完全一致，结论必须区分「产品缺陷」与「端口能力缺失」。
- 引擎是单路径执行（`runNode` 只跟随 `resolver ?? defaultNext`，没有入边队列），因此 `wait-connections` 承诺的「等待所有入边汇合」在任何图上都不成立；这不是参数漂移，是语义无法实现。

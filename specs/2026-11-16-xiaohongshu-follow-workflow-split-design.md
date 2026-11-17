# 小红书"点赞收藏关注评论"工作流拆分设计 / Xiaohongshu engagement workflow split design

## 现状与目标 / Context and goal

用户给出的需求原文（goalText）：

> 我需要你在小红书通过给别人 点赞 收藏 关注+评论方式来增加自己被关注的目的 来生成一个工作流，要新建一个表格记录是否已经关注过这个博主，如果已经关注过，就不再打开笔记；只打开未关注过的 且筛选出点赞较少的笔记进行关注；关注的博主要进行追加记录到表里，评论过的笔记也要加到表里。

问题背景：由大模型一次性生成这种"多阶段 + 有状态 + 跨运行累积"的大工作流，token 消耗高、失败率高。本文验证并细化"按功能拆成多个子工作流 + 1 个 orchestrator"的方案，产出可落地的块序列、传参字段和判存逻辑。

结论先行：**拆分方向可行且项目原生支持**（`execute-workflow` 块 + `builtin-plan` 技能里的"已批准拆分"路径）。但拆分只解决"生成得准"，解决不了"跑得对"——该需求的真正难点是**跨运行持久化的记录表 + 按博主判存去重**，当前引擎没有这两项原生能力，必须用 `export-data` + `parse-excel` 的文件闭环 + `conditions.code` 自己搭出来。不补这一层，无论拆多少个流程，第二次运行都会重复关注。

## 关键事实（以源码为准 / Verified facts）

以下每条都来自本仓库源码，是设计的硬约束，不是推测：

1. **子工作流调用**：`execute-workflow` 块（`catalog.ts:172`）字段为 `workflowId` / `executeId` / `globalData` / `insertAllVars` / `insertAllGlobalData`。引擎 `runSubWorkflow`（`engine.ts:1952`）**直接把父的变量袋 `variables` 传给子流程共享**，并做 `parentWorkflowIds` 自环防护。也就是说：编排器与子流程之间传参靠**共享变量名**，不是靠 `globalData`（`globalData` 只在 `executors.ts:2113` 一处用于 code 节点取值，不是主通道）。
2. **编排约定**：`builtin-skills.ts:155-159` 的 `plan` 技能写明拆分判据（子任务独立/触发时机不同 → 拆）与组合方式（orchestrator 用 `wf_op_execute-workflow` 依次调用）；`:172` 写明"已批准拆分"录制路径：每段 `compose_workflow(name)` 保存后再录下一段，最后录 orchestrator。
3. **数据表是运行内内存**：`data-table-usage.ts:5` 明确 "no table schema node"；`variables.dataTable` 是行对象数组，由 `get-text(saveData:true, dataColumn)` / `insert-data` 写入，被 `loop-data` / `export-data` / `sort-data` / `data-mapping` 读取。**运行结束即消失**。
4. **持久化唯一闭环**：`export-data(name, type:'csv')` 把整张 dataTable 覆盖式写到下载目录（写全量文本，`executors.ts:1751-1828`），`parse-excel(sourceMode:'file-path'|'user-select', filePath, variableName)` 把 CSV 读回成对象数组（`operator-tools.ts:683`）。`google-sheets` 是 cloud 块、OAuth 未接（`executors.ts:1765` 直接抛错），不可用。
5. **没有原生"按主键判存/去重"**：`UI_ONLY_KEYS` 注释明确 `onConflict` / `refKey` **没有任何 executor 读取**（`operator-tools.ts:371-376`）。条件块的比较符有 `eq/contains/gt/lt/rgx` 等（`condition-tree.ts:270-314`）；`conditions` 块支持 `code` JS 表达式且在页面里对 `vars` 求值（`executors.ts:3637-3678`）——这是声明式判存的正道，不算 `javascript-code` 逃生舱。
6. **循环**：`loop-data`（`catalog.ts:970`）用 `loopThrough:'data-columns'` 遍历表或 `loopThrough:'variable'` + `variableName` 遍历变量数组，`maxLoop` 限量；每轮把当前行写入 `{{loopItem}}`、序号写入 `{{loopIndex}}`（`engine.ts:1836-1837`），**不是**写进 `variableName`；`loop-breakpoint`（`catalog.ts:1042`）跳过本次迭代。逐条打开笔记属于 operator-guide `:36-38` 的"采集列表每条详情"固定写法。
7. **采集列**：`get-text(multiple:true, saveData:true, dataColumn:'列名')` 一次收一整列（`operator-guide.ts:79`）；`export-data` 表为空会直接报错（`:1796`）。
8. **代码节点是最后手段**：`javascript-code` 默认禁止，必须有 `justification` 或 `capabilityGap`（`operator-guide.ts:87-104`）。本方案**不需要**代码节点——所有逻辑用声明式算子 + `conditions.code` 表达。
9. **导航等待**：`new-tab` / 导致跳转的 `event-click` 后接 `wait-connections(timeout:10000)` 或交互节点的 `waitForSelector:true`（`operator-guide.ts:32-34,178-179`）。
10. **自撰文案**：评论内容由 agent 撰写，必须先 `ai-agent(prompt, actOnPage:false, variableName)` 再 `forms(value:'{{变量}}')`，不得字面量直填（`operator-guide.ts:180-183`）。

## 数据流设计 / Data flow

跨运行持久化的"记录表"落地为一个固定文件（下载目录内相对路径）：

- 文件名：`xhs-follow-ledger.csv`（固定，`filePath` 用相对路径，不用时间戳，否则下次读不到）
- 列（首行表头即列名）：
  - `authorId` — 博主主页的唯一标识（URL 末段 id，**比昵称稳定，判存主键**）
  - `authorName` — 博主昵称（展示用）
  - `noteUrl` — 笔记链接
  - `noteId` — 笔记 id（评论判存主键）
  - `likeCount` — 采集时点赞数（用于筛选阈值留痕）
  - `action` — `follow` 或 `comment`
  - `ts` — 记录时间

两类判存：

- **关注判存**：`authorId` 是否在 ledger 中 `action==='follow'` 的行里 → 在则跳过整条笔记（不打开）。
- **评论判存**：`noteId` 是否在 ledger 中 `action==='comment'` 的行里 → 在则本条不评论（避免重复刷评）。

变量袋里的运行内变量（子流程共享）：

| 变量                     | 生产者                                              | 消费者                                   | 说明                                                                                                |
| ------------------------ | --------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ledgerRows`             | WF-1 `parse-excel(variableName:'ledgerRows')`       | WF-2/WF-4 判存                           | 历史台账对象数组                                                                                    |
| `dataTable`              | WF-1 `get-text(saveData:true)` / WF-2 `insert-data` | WF-2/WF-3/WF-4                           | 内置运行内表：WF-1 采的候选源 + WF-2 筛出的候选行 + WF-3 本次新增记录（可用不同 `dataColumn` 分区） |
| `candidateRows`（备选）  | WF-2 循环内 `set-variable` 累加                     | WF-3 `loop-data(loopThrough:'variable')` | 若不用表分区，可改用变量数组，当前行仍是 `{{loopItem}}`                                             |
| `loopItem` / `loopIndex` | 引擎 `loop-data` 每轮写入                           | WF-2/WF-3 判存、记录                     | 循环当前行对象 / 序号（`engine.ts:1836-1837`）                                                      |
| `curAuthorId`            | WF-3 `regex-variable`                               | WF-3 判存、记录                          | 从博主主页 URL 提取的稳定主键                                                                       |
| `likeThreshold`          | orchestrator 触发器参数（默认 100）                 | WF-2 筛选                                | "点赞较少"的阈值                                                                                    |
| `runDate`                | orchestrator 触发器参数（生成当天日期）             | WF-3 `ts` 列                             | 记录时间戳，无内置变量可用                                                                          |
| `aiComment`              | WF-3 `ai-agent`                                     | WF-3 `forms`                             | 当次生成的评论文案                                                                                  |

## 编排器与 4 个子流程 / Orchestrator and 4 sub-workflows

拆分遵循 `builtin-plan` 的判据：采集 / 筛选 / 互动 / 落账四段相互独立（不同页面职责、可单独重跑与维护），强顺序依赖由 orchestrator 用 `execute-workflow` 串起来。

### WF-0 orchestrator（编排器）

```
trigger(type:'manual', goalText:'<需求原文>',
        parameters:[{name:'likeThreshold', default:'100'}, {name:'maxNotes', default:'5'},
                    {name:'runDate', default:'<生成当天 YYYY-MM-DD>'}])
  └─ execute-workflow(workflowId:'<WF-1 id>', description:'读取历史台账并采集当次笔记列表')
       └─ execute-workflow(workflowId:'<WF-2 id>', description:'按未关注+低点赞筛选候选笔记')
            └─ execute-workflow(workflowId:'<WF-3 id>', description:'对候选笔记执行点赞收藏关注评论并追加记录')
                 └─ execute-workflow(workflowId:'<WF-4 id>', description:'把当次新增记录合并写回台账 CSV')
```

- 触发参数用 `inputName` 命名（`likeThreshold`、`maxNotes`、`runDate`），开箱有默认值、可在触发器改（`operator-guide.ts:68-69`）。
- 每段之间共享同一个变量袋（`engine.ts:1972` 把父 `variables` 直接传给子流程），因此 `ledgerRows`、`dataTable`（含候选行）无需显式传参。`execute-workflow` 的 `globalData` / `insertAllVars` 字段不是主传参通道，别指望靠它们搬数据。
- 落账放最后一段：只有互动成功才写回，避免"记了却没做"。

### WF-1 采集（read ledger + collect list）

```
trigger(manual)
  └─ parse-excel(sourceMode:'file-path', filePath:'xhs-follow-ledger.csv',
                 variableName:'ledgerRows', hasHeader:true,
                 description:'读回历史台账作为判存依据')
       └─ new-tab(url:'https://www.xiaohongshu.com/', waitTabLoaded:true)
            └─ wait-connections(timeout:10000)
                 └─ [搜索/进入目标话题页：用站点自带筛选或搜索框 forms]
                      └─ get-text(selector:'<笔记卡片作者容器>', multiple:true, saveData:true,
                                  dataColumn:'authorName', description:'采集整列博主昵称')
                           └─ get-text(selector:'<点赞数容器>', multiple:true, saveData:true,
                                       dataColumn:'likeCount', description:'补采整列点赞数')
                                └─ attribute-value(selector:'<笔记链接锚点>', attributeName:'href',
                                                    action:'get', multiple:true, saveData:true,
                                                    dataColumn:'noteUrl',
                                                    description:'补采整列笔记链接（读 href 用 attribute-value，get-text 无 attribute 字段）')
```

- `parse-excel` 的 `filePath` 必须是**固定相对路径**；首次运行文件不存在时需人工建一个只有表头的 CSV（见"落地步骤"），否则 `parse-excel` 报错。这是已知缺口，WF-1 的 `element-exists`/容错分支暂不覆盖，`catch` 到错误时提示用户先建表头。
- 三次 `get-text` 用同一 `selector` 序号对齐列名（operator-guide `:79,188-191`）。
- `authorId` 不在列表页直接可得时，在 WF-3 打开笔记后从 URL 取（见 WF-3），WF-1 只采 `authorName`/`noteUrl`/`likeCount`。这要求 WF-3 的判存用 `authorName` 兜底或补采 `authorId`——设计取舍见"风险"。

### WF-2 筛选（未关注 + 点赞较少）

```
trigger(manual)
  └─ set-variable(variables:[{name:'candidateRows', value:'[]'}],
                  description:'初始化候选数组为空')
       └─ loop-data(loopThrough:'data-columns', maxLoop:'{{maxNotes}}',
                    description:'遍历 WF-1 采集的笔记表，当前行是 {{loopItem}}')
            └─ conditions(code:
                 "!(vars.ledgerRows||[]).some(r => r.action==='follow' && String(r.authorName).trim()===String(vars.loopItem.authorName||'').trim()) && Number(String(vars.loopItem.likeCount||'').replace(/[^0-9.]/g,'')) <= Number(vars.likeThreshold||100)",
                 description:'未关注 且 点赞数≤阈值 才进入候选')
                 └─ [true 路] set-variable + insert-data 把 {{loopItem}} 收进候选
                    （用 insert-data 的 dataList 写 authorName/noteUrl/noteId/likeCount，
                      并让写入落到候选表；false 路直接回到 loop 走下一行）
```

- 判存表达式用 `vars.ledgerRows`（WF-1 产出）+ `vars.loopItem`（当前行）+ `conditions.code` 在页面里求值，声明式、可读变量袋（`executors.ts:3668`）。`contains` 只能做子串、`eq` 只能等值，无法表达"数组里按 action 过滤再比主键"，故用 `code`——这是 operator-guide 允许的表达式形态，不是 `javascript-code` 节点。
- `loopThrough:'data-columns'` 遍历 WF-1 采集的 `dataTable`，当前行同样由引擎写入 `{{loopItem}}`（不是自定义别名）。"点赞较少"用正则去非数字后转 Number 比较，小红书的"1.2万"这类带单位文本需额外换算（见"风险"）。
- 候选数组的落点：最简单是让 WF-2 用 `insert-data` 把命中行写进一张专用列（如 `candidate` 表），WF-3 用 `loop-data(loopThrough:'data-columns')` 直接遍历它；若坚持用变量 `candidateRows`，需在循环内用 `set-variable` 逐行累加（`{{candidateRows}}` + 当前行），二者择一，落地时以保持列对齐为准。
- "点赞较少"阈值 `likeThreshold` 来自 orchestrator 输入，避免把数字冻死在节点里（operator-guide `:56-60`）。

### WF-3 互动（逐条打开 + 点赞收藏关注评论 + 追加记录）

```
trigger(manual)
  └─ loop-data(loopThrough:'data-columns', maxLoop:'{{maxNotes}}',
               description:'遍历 WF-2 写入的候选表，逐条互动')
       # 引擎把当前行写进 {{loopItem}}、当前序号写进 {{loopIndex}}（engine.ts:1836-1837）；
       # variableName 在 loopThrough:'variable' 下是“数据源变量名”，不是当前行别名。
       ├─ [判存：已关注则整条跳过]
       │   conditions(code:
       │     "(vars.ledgerRows||[]).some(r => r.action==='follow' && (r.authorId===vars.loopItem.authorId || String(r.authorName).trim()===String(vars.loopItem.authorName||'').trim()))",
       │     description:'已关注过该博主则跳过本条笔记')
       │     └─ loop-breakpoint(description:'跳过已关注博主，不打开笔记')
       │
       └─ new-tab(url:'{{loopItem.noteUrl}}', waitTabLoaded:true)
            └─ wait-connections(timeout:10000)
                 ├─ attribute-value(selector:'<博主主页入口>', attributeName:'href',
                 │                   action:'get', variableName:'curAuthorHref',
                 │                   description:'读博主主页链接，供提取博主 id')
                 │    └─ regex-variable(variableName:'curAuthorHref',
                 │                      regex:'/user/profile/([^?/]+)', assignVariable:true,
                 │                      outputVariable:'curAuthorId',
                 │                      description:'从主页 URL 提取博主 id 作为稳定主键')
                 └─ [评论判存：已评论过这条笔记则不再评论]
                     conditions(code:
                       "(vars.ledgerRows||[]).some(r => r.action==='comment' && r.noteId===vars.loopItem.noteId)",
                       description:'本条笔记已评论过则跳过评论')
                       └─ loop-breakpoint(description:'已评论，不重复刷评')
                 |
                 └─ event-click(selector:'<点赞按钮>', waitForSelector:true)
                      └─ event-click(selector:'<收藏按钮>', waitForSelector:true)
                           └─ event-click(selector:'<关注按钮>', waitForSelector:true)
                                └─ ai-agent(prompt:'写一条真诚自然的中文评论，不超过30字',
                                            actOnPage:false, variableName:'aiComment')
                                     └─ forms(selector:'<评论输入框>', type:'text-field',
                                              value:'{{aiComment}}', clearValue:true)
                                          └─ press-key(key:'Enter')
                                               └─ insert-data(dataList:[
                                                    {type:'variable', name:'authorId', value:'{{curAuthorId}}'},
                                                    {type:'variable', name:'authorName', value:'{{loopItem.authorName}}'},
                                                    {type:'variable', name:'noteId', value:'{{loopItem.noteId}}'},
                                                    {type:'variable', name:'noteUrl', value:'{{loopItem.noteUrl}}'},
                                                    {type:'variable', name:'likeCount', value:'{{loopItem.likeCount}}'},
                                                    {type:'variable', name:'action', value:'follow/comment 各插一行'},
                                                    {type:'variable', name:'ts', value:'{{runDate}}'}],
                                                  description:'把关注的博主和评论的笔记各追加一行到本次记录表')
```

- **循环变量**：无论 `loopThrough` 取 `data-columns` 还是 `variable`，当前行都由引擎写入 `{{loopItem}}`、序号写入 `{{loopIndex}}`（`engine.ts:1776-1780,1836-1837`）。`variableName` 只在 `loopThrough:'variable'` 时表示数据源变量名。**不要**写 `variableName:'curRow'` 再引用 `{{curRow.*}}`——那样取到的是空值。本文主线用 `data-columns` 遍历候选表。
- `ts` 用 `{{runDate}}`：由 orchestrator 触发器输入提供默认值（生成当天日期字符串，用户可改），**不要写 `{{$now}}` 之类未定义的内置变量**——引擎没有这个变量，引用了只会得到空值。
- `authorId` 作为判存主键：列表页拿不到时，打开笔记后用 `attribute-value(action:'get', attributeName:'href')` 读博主主页链接，再用 `regex-variable` 声明式提取 `/user/profile/xxx` 的末段 id（不必写 JS）；`authorName` 仅作兜底比对。昵称会改、id 不会，所以 WF-1 能采 id 就采 id。
- 关注/评论分两行 `action`，满足需求"关注的博主要追加记录、评论过的笔记也要加到表里"。
- 两个 `conditions.code` + `loop-breakpoint` 分别实现"已关注跳过"和"已评论跳过"，都是声明式，不是 `javascript-code` 节点。
- 逐个动作都是不可逆操作（关注/评论），`__reliability` 契约按 operator-guide `:43-46` 带 intent/idempotency/postconditions。

### WF-4 落账（合并写回台账）

```
trigger(manual)
  └─ conditions(code:
       "(vars.ledgerRows||[]).length > 0 ||
        (Array.isArray(vars.dataTable) && vars.dataTable.length > 0)",
       description:'有历史或有新增才写文件，避免导出空表')
       └─ data-mapping(dataSource:'table', sources:[...], varSourceName:'dataTable',
                       assignVariable:true, variableName:'mergedLedger',
                       description:'历史行 + 本次新增行合并成一个数组')
            └─ export-data(name:'xhs-follow-ledger.csv', type:'csv', addBOMHeader:true,
                           dataToExport:'variable', variableName:'mergedLedger',
                           description:'覆盖写回台账 CSV，供下次运行判存')
```

- `export-data` 是**覆盖式**写整份表（`executors.ts:1821`），所以必须把历史 `ledgerRows` 与本次新增合并后再写，否则每次只剩当次记录、判存失效——这是本设计最关键的一步。
- `name` 固定为 `xhs-follow-ledger.csv`，与 WF-1 的 `filePath` 对齐；`addBOMHeader:true` 让中文表头在 Excel 里不乱码。
- 合并用 `data-mapping`（声明式）；历史为空时直接写本次新增。

## 落地步骤 / Implementation steps

1. **建种子台账**：在"设置 → 下载目录"下手工建 `xhs-follow-ledger.csv`，首行表头：
   `authorId,authorName,noteUrl,noteId,likeCount,action,ts`。这是 `parse-excel` 首次能读到的前提。
2. **先录制 4 个子流程**：进入工作流生成模式，对每段调用 `prepare_workflow_goal`，按上面的块序列用 `wf_op_*` 逐段"跑通即录制"；每段完成调用 `compose_workflow(name=该段名)` 保存。**动手前** `use_operators` 声明需要的类别（`interaction`/`browser`/`data`/`conditions`/`general`），避免类别被整体替换。
3. **最后录 orchestrator**：`wf_op_execute-workflow` 依次引用 4 个子流程 id（从保存结果取），`workflowId` 是结构性参数用字面量、`likeThreshold` 用触发器输入。
4. **每张页面先探查**：`new-tab` 进入小红书后先用 `snapshot_page` / `read_current_page` 确认笔记卡片、点赞数、关注按钮的真实选择器，`waitForSelector:true`；不要照抄本文占位的 `<...>` 选择器。
5. **端到端试跑**：先 `maxNotes=1` 跑通一遍，确认台账 CSV 追加了 `follow` 与 `comment` 两行；再跑第二遍确认**同一博主被跳过、不打开笔记**——这是判存闭环是否成立的唯一验收点。
6. 登录后状态：小红书需登录，账号密码按 operator-guide `:114-121` 处理（用户名普通输入、密码 `get-secret`）。

## 验证 / Verification

- 静态：`pnpm typecheck && pnpm test && pnpm build`（本文不改代码，仅回归确认基线绿）。
- 实机（关键）：
  1. 首次运行：CSV 从"只有表头"变成含 N 行记录。
  2. 二次运行（不换目标）：日志出现"已关注跳过"、"不打开笔记"，CSV 行数不因同一博主重复关注而膨胀。
  3. 中途失败：`execute-workflow` 的共享 checkpoint（engine `:1985-1988`）能让暂停后续跑，恢复后 `loop-data` 从 `<childId>:<loopId>` 进度继续、不从头重扫（`engine.ts:1981-1983`）。
  4. 阈值变化：改 `likeThreshold` 后候选集合随之变化，证明数字不是冻死的字面量。

## 风险与取舍 / Risks and trade-offs

| 风险                    | 说明                                                    | 缓解                                                                                                    |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 拆分不解决持久化        | 4 段再正确，缺台账闭环则第二次必重复关注                | WF-4 合并写回 + WF-1 读回，`export-data` 覆盖式写是唯一可靠闭环                                         |
| `authorId` 列表页不可得 | 只能打开后从主页链接取，判存退化为 `authorName`（会改） | 优先采 id；WF-3 打开后补采 id 并写回台账，后续以 id 为准                                                |
| 小红书反爬/风控         | 高频点赞关注评论触发限制                                | `maxLoop` 限量、动作间 `delay`、使用站点自带筛选近似"点赞较少"                                          |
| 选择器脆弱              | 小红书改版即失效                                        | `waitForSelector:true` + 稳定属性，避免 nth-child 长链（operator-guide `:30-31`）                       |
| 首次无 CSV              | `parse-excel(file-path)` 读不到台账会报错               | 实测生成器会自建仅表头的 `xhs-follow-ledger.csv`；或由前一段 `export-data` 先写空表，全程无需人工选文件 |
| 不可逆操作              | 关注/评论无法自动回滚                                   | 先 `maxNotes=1` 小流量试跑，`__reliability` 契约带 postconditions                                       |
| 并发写文件              | 两个运行同时 `export-data` 同一文件会互相覆盖           | 单实例顺序执行，不给本工作流建并发定时任务                                                              |

## 为什么拆分仍然值得做 / Why split is still worth it

- **降 token**：生成时若首回合广告全部 ~54 个算子 schema（旧行为每轮 ~9.8k tokens，`operator-categories.ts:4`），拆成短流程后每段只需 `use_operators` 声明相关类别，注入载荷显著下降。
- **提成功率**：LLM 生成"单一职责的短链"远比"40 步大一统图"准确；失败时能定位到具体子流程（`onStep` 前缀 `[子]`，engine `:1995`）。
- **可单独重跑**：某段（如筛选阈值）改了只需重录该段，不动其余。
- **边界**：本方案**不**声称拆分本身能提高运行时成功率——那靠的是台账闭环。两者叠加才是完整答案。

## 实测验证（2026-11-16 执行记录）/ Live execution findings

按"执行这个计划"在真实浏览器（小红书已登录）上用 `generate_workflow` + 自动试跑验证，得到三条一手证据，**修正了上面对瓶颈的估计**：

| 试验                                                                                       | 结果                                          | 关键数据                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WF-1 采集（prompt 未约束选择器）                                                           | **失败** `verified:false`                     | 7 节点；模型自主选 `nth-of-type` 位置选择器 → 第 2/7 步 get-text 读不到（隐藏/遮挡）；`parse-excel` 生成期失败被丢弃；4 处 `LOCATOR_POSITIONAL` 警告。废案 id `mwj643ty-ozwdmsl6`                                                                                                                                            |
| WF-1 采集（prompt 约束稳定选择器 + `wait-connections` + `waitForSelector` + 禁位置选择器） | **通过** `verified:true`                      | 6/6 步全过，12.6s 试跑；选择器 `a.author .name` / `.like-wrapper .count` / `a.title[href*="/explore/"]`，三列 `multiple+saveData` 对齐；8.6 万 token 级生成耗时 ~173s。有效 id `mwj68puk-405af4f8`                                                                                                                           |
| WF-2 筛选 v1（`parse-excel` 用 `user-select`）                                             | **失败** `verified:false`                     | 8 节点，341s；`user-select` 无人值守时无人可选文件 → 步骤被丢弃 → 第 3/7 步 loop-data 变量未赋值。废案 `mwj6hnue-qn5ns1fo`                                                                                                                                                                                                   |
| WF-2 筛选 v2（`parse-excel` 改用 `file-path`）                                             | **文件闭环成立，生成质量崩** `verified:false` | 17 节点，907s；`file-path` 全程无人值守可读，生成器发现台账不存在还**自动在下载目录新建了只有表头的 `xhs-follow-ledger.csv`**，未弹选文件框；但模型把同一筛选逻辑重复录 3 遍（4×conditions + 2×loop-data + 2×insert-data）、混入探索节点、条件落入否则分支，第 6/16 步失败，生成器自己建议不要保存。废案 `mwj7i35n-znieqila` |

**修正后的结论**：

1. **成败主因是选择器质量，不是工作流大小**。同一段采集，仅因 prompt 里约束了选择器写法就从"第 2 步挂"变成"6/6 全过"。这比拆分本身更值得投入——把"稳定选择器规则"固化进生成 prompt / operator-guide 的收益，大于单纯拆流程。
2. **跨运行持久化链用 `file-path` 可以全程无人值守**（推翻早先"走不通"的判断）。源码核实：`parse-excel(file-path)` 经 `downloadPathFile`（`executors.ts:2795`）读下载目录相对路径，`export-data` 经 `writeToConfiguredDir`（`:1649`）写同一根，两者对齐且支持子目录（`download-dir.ts:260-289`）；文件不存在时生成器能自建表头种子文件。因此 `user-select` 是错误选择，正确做法是 **`export-data` 写固定文件名 + `parse-excel(file-path)` 读回**，台账预置也可由流程自身完成。
3. **真正的卡点转移到"生成机制不适合纯数据段"**。无人值守"边操作边录"依赖页面动作产生节点；纯数据算子（parse-excel/loop-data/conditions/insert-data）没有页面动作，模型只能硬凑步骤 → 15 分钟 + 结构重复 + 验证失败。这类段应改用**手工编排 / 直接构造 workflow JSON**（本 MCP 通道未提供该工具），而不是继续让生成器试。
4. **环境限制**：当前 MCP 通道只暴露 `generate_workflow` / `compose_workflow` / `verify_workflow`，`load_tools` 不可用 → `wf_op_*` 手动精确录制路径不可用。所以本轮只能用"无人值守生成 + 自动试跑"落地，无法按"实现"章节设想的手动逐节点控制。
5. **未执行 WF-3 互动段**：点赞/收藏/关注/评论是真实、公开、不可回滚的账号操作，生成与试跑都会真做。按安全边界，在用户明确授权"在当前已登录账号上产生真实互动"之前不执行。

**建议调整落地优先级**：① 稳定选择器写法已沉淀为 skill/prompt 模板（最高 ROI，已完成）；② 持久化文件读写统一改 `file-path`（已验证可行，不需要人工）；③ 纯数据段（WF-2/WF-4）改用手工编排或直接构造 JSON，不要再交给无人值守生成器；④ WF-3 取得账号操作授权后单独录制，并先 `maxNotes=1` 小流量试跑。

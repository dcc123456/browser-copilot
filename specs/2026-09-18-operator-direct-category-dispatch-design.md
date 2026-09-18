# 设计：工作流生成 = 算子直出 + 按分类分发

日期：2026-09-18（晚，推翻当日的 `2026-09-18-record-then-compile-*`）
状态：**已实施**

## 用户要求（原文）

1. 拥有全自动模式下的所有功能，但功能实现都通过**工作流算子节点工具**。
2. 算子节点都封装成工具、可在配置中查看，但**只能在工作流生成模式下使用**，避免 token 消耗过多。
3. 算子工具要**分类**，模型每次调用工具前按分类传给它，例如要操作页面就只传"操作网页"那一类。
4. 完成任务后**默认弹出保存成工作流的卡片**，让用户确认。
5. 保存的工作流要**直接可运行**，不能中途丢节点、丢变量。
6. 节点里保存到本地的数据，默认存到**配置中的下载路径**，成功/失败都有提示。

## 一句话方案

模型用 `wf_op_*` 算子工具真实完成任务（每次调用**既操作页面、也记录节点**），
工具面**只常驻 4 个跨类高频算子**，其余按 **5 个分类**由模型用 `use_operators` 声明后发送
（**替换**语义，不是累加），回合结束由保存卡片确认。

## 为什么推翻「先跑通再编译」

|            | 先跑通再编译                             | 算子直出                     |
| ---------- | ---------------------------------------- | ---------------------------- |
| 模型用什么 | `click` / `fill` / `open_url` 等动作工具 | `wf_op_*` 算子工具           |
| 节点从哪来 | 回合结束编译 action history              | 调用即记录，草稿**必然非空** |
| 保存卡片   | 依赖编译结果，草稿为空时整条链路失效     | 依赖草稿，正常路径必然有内容 |

**决定性缺陷**：动作工具不记录任何节点。只要它们在工具面里，模型就会优先用它们
（名字更短、更熟悉），于是草稿永远是空的 —— 而 `workflows.draft.get` 里一行
`if ('error' in out) return` 把回落分支挡在门外，**保存卡片彻底消失**。

同时，「模型猜不出算子」这个前提也是错的：算子工具名本身就是动作语义
（`wf_op_event-click` = 点击、`wf_op_forms` = 填表）。真正的问题是**一次把 54 个全广告出去**
（32.4k 字符 schema，每轮重发）。

## 分类体系（现成，零维护）

`BlockCatalogEntry.category` 本来就有，画布调色板已按它分组。实测：

| 分类             | 数量 | 覆盖                                                            |
| ---------------- | ---- | --------------------------------------------------------------- |
| `interaction`    | 13   | 点击、填写、悬停、上传、读文本/属性                             |
| `browser`        | 14   | 标签页、导航、Cookie、弹窗、下载、截图、OCR、写文件、**读页面** |
| `general`        | 11   | 等待、子工作流、webhook、通知、剪贴板、嵌套 AI                  |
| `data`           | 10   | 变量、映射、正则、排序、切片、数据表、密钥                      |
| `conditions`     | 6    | if/exists 分支、各类循环                                        |
| `onlineServices` | 0    | 全是 cloud 块，**不广告**                                       |
| `package`        | 0    | 全是 cloud 块，**不广告**                                       |

54 个声明式算子 + 1 个 escape（`javascript-code`）= 55。

`src/lib/workflow/operator-categories.ts` 是单一真相源，全部**派生**自
`PALETTE_BLOCKS`：新收录一个块会自动落进它自己的分类，这里不用改。
模块位于 `operator-class` 与 `operator-tools` **之间**（依赖单向，别把
`JAVASCRIPT_BLOCK_ID` 之类搬回去造成环）。

## 常驻 4 个算子

`new-tab` / `event-click` / `forms` / `get-text` —— 任何页面任务的不可再分核心
（导航、点击、填写或读取字段、读文本）。合计约 3.5k 字符。

选它们的理由：都是 `interaction` 的成员（`new-tab` 属 `browser`），所以
**模型一个分类都不声明也能直接动手**，不必先花一轮声明。

## 分发语义：替换，不是累加

- 模型调 `use_operators({categories:[…]})` → 该集合**替换**当前激活集合。
- 描述里明写 `REPLACES`：从抓取切到数据清洗时，模型必须能**丢掉** `interaction`，
  否则集合只会涨回"全部"，省下的 token 又还回去。
- 越界调用（调了未激活分类下的算子）→ **激活该分类 + 让模型立即重试**，
  而不是回一句 error。弱模型收到 error 会放弃并谎称"工具受限"。
  代价是白花一轮，所以提示词要求先声明。
- 激活单位是**分类**而不是整包：`wf_op_loop-data` 落到 `conditions`，不是 `operators_author`。
  这个优先级在 `TOOL_GROUP_BY_NAME` 里显式写死（`operators_escape` 优先，
  否则 `wf_op_javascript-code` 会通过激活分类变得可达）。

## 实测（2026-09-18，非估算）

| 场景                                      | tools     | system | total                |
| ----------------------------------------- | --------- | ------ | -------------------- |
| full auto                                 | 13,084    | 3,976  | 17,060               |
| **workflow 第 1 轮**                      | **8,940** | 6,513  | **15,453**           |
| workflow + interaction (13)               | 17,608    |        | 24,121               |
| workflow + browser (14)                   | 16,461    |        | 22,974               |
| workflow + general (11)                   | 14,386    |        | 20,899               |
| workflow + conditions (6)                 | 13,250    |        | 19,763               |
| workflow + data (10)                      | 12,589    |        | 19,102               |
| workflow + 全部分类（= operators_author） | 38,534    |        | 45,047               |
| workflow + 全部 + escape                  | 39,763    |        | 46,276               |
| （对比）朴素算子直出：全 55 个 schema     |           |        | 32,418+（仅 schema） |

- 第 1 轮**比 full auto 还小 9.4%**（工具面 0.683×，总载荷 0.906×）。
- 单类上限 ≈ 24.1k，比"一次全给"的 45.0k 省 46%。
- 守门测试 `tests/agent-payload-size.spec.ts`：第 1 轮 ≤16k、单类 ≤25k、
  全类 ≤46k、全部+escape ≤48k、工具面比 ≤0.75、总载荷比 ≤0.95、无重名工具。
- 常驻 4 个算子的 schema 合计 4,052 字符（`core=4`）。

> 数字随算子增删而变化，**改完算子面请重跑守门测试取新值**，不要从这里抄。

## 「可运行」的两条保障（要求 5）

1. **引用完整性**（`src/lib/workflow/integrity.ts`，纯函数）：保存前查
   悬空 `{{变量}}`（既无生产者、触发器也没声明）/ 孤儿节点 / 不可达节点。
   生产者搜索是**全图**而非"仅上游"——静态分析判断不了分支与循环里的顺序，
   猜错会在能跑的图上误报；"整张图都产不出这个引用"才是能站得住的结论。
2. **选择器探测**（`lib/workflow/selector-probe.ts` + `background/selector-probe.ts`）：
   逐节点在真实页面数命中数，1=唯一 / 0=失效 / >1=歧义 / -1=非法；
   返回 `null` 的语义是**未经验证**而不是"全部通过"。
   **已拆成独立命令 `workflows.probe`，不阻塞弹窗**——卡片先弹，结果异步回填。

## 落盘（要求 6）

`save-local` 一直写配置的下载目录；**`export-data` 原本不写文件**
（catalog 描述写着 `Write collected data out to a file`，执行器却只写了个变量）。
现在两者共用 `writeTextToConfiguredDir(filename, text, ctx)`：
写配置目录 → 失败则回退另存为 → 三种结果（saved / canceled / failed）都有 emit 提示。
`save-assets` 是占位实现，描述已标注。

`askSaveViaSidePanel` 补了 `typeof chrome === 'undefined'` 守卫：此前它在无扩展上下文时
抛 `ReferenceError`，会让**整条工作流**失败而不是这一步失败。

## 读页面 + 采集（补做，2026-09-18 晚）

### 问题：整条「采集 → 导出」链是断的

`get-text` 的 `multiple` / `saveData` / `dataColumn` 三个参数**在 catalog 里声明了、
在编辑器里有 UI、在算子指南的采集配方里被引用** —— 但没有任何执行器读它们：
`readTextInPage` 只做 `querySelector(selector).textContent`，三个参数全部被忽略。

而 `dataTable`（`export-data` 唯一的读取来源）**只能**被 `insert-data` 以字面量 JSON 写入，
那正是动态数据门禁拒绝的"死数据"。于是 `export-data` 永远写出**空文件**，并且报告成功。

同时 `read_current_page`（对话模式的工具）**没有对应的块**：它不在 `ACTION_TO_BLOCK` 里，
也没有选择器参数，所以"读整页"这件事在生成模式下**无节点可记**，读完即丢。

### 做法

1. **新块 `read-page`**（`browser` 分类，`operatorExecClass = 'execute'`）：
   `source: 'text' | 'selection' | 'html'` 三选一，可选用 `selector` 限定范围、
   `maxChars` 截断。它就是 `read_current_page` 的可录制形态。
   - `refDataKeys: ['variableName']` —— **故意不列 `selector`**：`refDataKeys` 同时驱动
     `takesElementTarget`，会往块上嫁接 `ref`/`target`/`label` 元素定位参数，
     并覆盖 `selector` 的描述。一个只做"读"的块不该有元素定位参数。
2. **两个共享辅助**（`background/workflow-engine/executors.ts`）：
   - `collectIntoDataTable(ctx, column, values)`：行号 = 循环里取 `loopIndex`，否则取匹配序号。
     **同列写第二遍是合并单元格，不是追加行** —— 这样"读标题 → 再读链接"得到的是
     一张两列的表，而不是两张半截的表。行数上限 `MAX_TABLE_ROWS = 100_000`。
   - `publishRead(ctx, data, values, fallbackVariable)`：写输出变量、写 `lastText`/
     `lastReadPage` 兜底，并在 `saveData` 开了但 `dataColumn` 空时 **emit 一条 info**
     （静默丢数据正是上面那个 bug 的形态）。
3. **`get-text` 重写**：`readTextsInPage(selector, multiple, useTextContent, includeTags)`
   返回 `string[]`（**破坏性变更**：注入函数从返回 `string` 变成返回数组，
   测试桩要跟着改）。`multiple` 决定取全部匹配还是第一个。
4. **采集三参数按块放行**：`COLLECTING_BLOCK_IDS = {get-text, read-page}`。
   另外 ~16 个块也在 catalog 里声明了 `saveData`/`dataColumn`，但它们的执行器不读 ——
   若一并广告，就是把上面那个 bug 重新制造一遍（广告一个静默无效的功能）。
   所以 `dataSchemaFromEntry` 只在 `COLLECTING_BLOCK_IDS` 成员上重新暴露这三个键。

### 测试

`tests/read-page.spec.ts`（24 条）覆盖块定义、工具 schema、执行器四种读取路径、
采集的行寻址（`multiple` / 第二列合并 / `loopIndex` / 关闭 `saveData` / 缺 `dataColumn` 告警 /
行数上限），以及"三参数只在这两个块上可达"。
`tests/edit-forms-registry.spec.ts` 守 `editComponent` → `EditForms` 的全局配对。

## 配置页（要求 2）

设置页新增只读的「工作流算子工具」分组：按 5 类折叠，复用
`OPERATOR_CATEGORY_ENTRIES` + `blockDisplayName` / `categoryDisplayName`
（编辑器自带的中英词典，无需新词条）。**不接 `disabledTools`** —— 它们是工作流生成的
组成部分，不是可以关掉的工具。

## 保存卡片（要求 4）

`resolveWorkflowForSave`（`background/history-compile.ts`）是唯一决策点，
返回判别联合 `{workflow, source} | {empty}`：

1. **算子草稿优先**（模型已经决定了图长什么样）；
2. 否则**回落编译 action history**（历史遗留会话的兜底）；
3. 否则**说明为什么是空的**：`no-actions`（没碰页面）还是 `all-failed`（都失败了）——
   只有后者值得让用户重试。

三条路径都**可见**：卡片、或一行提示。**绝不静默**——静默的回合与坏掉的功能无法区分，
这正是本次故障的教训。另加一个不依赖自动弹窗的手动入口（工作流模式下常驻）。

## 测试

| 文件                                | 守住什么                                                             |
| ----------------------------------- | -------------------------------------------------------------------- |
| `tests/save-resolution.spec.ts`     | 「草稿为空 → 回落 history」「error 不提前终止」——本次故障的回归      |
| `tests/operator-tool-tiers.spec.ts` | 分类分区：无算子不可达、分类互不重叠、author = 分类并集、escape 独处 |
| `tests/operator-categories.spec.ts` | 菜单只列有成员的分类、提示词说了 REPLACES、覆盖自有块                |
| `tests/agent-payload-size.spec.ts`  | 上表全部预算 + 无重名工具 + 分类不串味                               |
| `tests/agent-tool-groups.spec.ts`   | 动作工具退场、越界只激活分类、use_operators 替换语义                 |
| `tests/workflow-integrity.spec.ts`  | 悬空引用/孤儿/不可达，且不误报（引擎别名、属性访问、触发器字面量）   |
| `tests/chat-save-dialog.spec.tsx`   | 空结果有提示、手动入口可用、模式外隐藏                               |
| `tests/workflow-phase4.spec.ts`     | export-data 真的写文件（内存假目录）                                 |
| `tests/read-page.spec.ts`           | read-page 四种读取路径 + 采集行寻址（合并列、`loopIndex`、上限）     |
| `tests/edit-forms-registry.spec.ts` | 每个可编辑调色板块的 `editComponent` 都在 `EditForms` 里注册         |

## 遗留

1. ~~`read_current_page` 不可重放~~ **已解决**：新增 `read-page` 块（见「读页面 + 采集」）。
   仍存的一点是**提示词要求**而非能力保障 —— 模型得记得用 `wf_op_read-page`，
   若它调了对话模式的 `read_current_page`，那次读取不进图。
2. **凭证捕获**：`credentialFillPath` 靠 `locator.type` 判断密码框，
   而 history entry 不记字段类型。走 history 回落路径时密码可能被当普通业务数据
   声明成输入（明文默认值）。修法：`hydrateRecordArgs` 时把字段 type 一并落历史。
   算子路径不受影响（`forms` 的 `type` 参数是显式的）。
3. 选择器探测只覆盖 CSS 选择器，不覆盖 rich locator 里的非 CSS 策略。
4. `use_skill` 未进工作流模式工具面，所以 `workflow-generator` 技能的正文仍不可达；
   当前靠系统提示 + `use_operators` 菜单 + 算子工具自带描述覆盖同样的信息。

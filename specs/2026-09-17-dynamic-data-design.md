# 动态数据约束（工作流生成模式禁止死数据）

日期：2026-09-17　状态：已实现并通过全量验证
相关：`2026-09-17-workflow-generation-mode-design.md`（本约束是该模式的延伸）

## 1. 问题

用户要求：聊天生成的工作流里**禁止出现死数据（字面量被冻进节点），必须全部动态化**，
否则工作流只是"这一轮的录像"，重放时永远重复那一次，没有意义。

## 2. 探索时的三个关键发现（决定了方案）

1. **死数据的直接成因在指南里**：`src/lib/workflow/operator-guide.ts`
   原第 60 行教模型"字面量内容直接写进 forms.value，不要绕道 AI"。这是源头。
2. **运行期变量作用域是空的**：全仓库所有 `executeWorkflow` 调用点都**不传 `variables`**，
   变量只能靠工作流自己的上游节点产出。所以"只教模型改用 `{{引用}}`"在没有产出方时会
   解析成空串——比死数据更糟。必须有运行期取值来源。
3. **`parameter-prompt` 输入口是坏的**：执行器读 `prompt`/`defaultValue`/`variableName`，
   而 catalog 与编辑器用 `parameters: WorkflowParameter[]`——字段完全对不上；
   且 `parameters` / `preferParamsInTab` 在 `src/background/` 与 `src/lib/workflow/` 里
   **零消费**，运行期根本没人收集声明。

## 3. 设计（用户确认的方向）

- **值来源**：触发器参数预置（2）+ 上游节点产出（4）；不引入运行期弹窗。
- **字面量处理**：数据类参数收到字面量时，**照常执行驱动页面，记录时自动改写成 `{{引用}}`**。
- **`parameter-prompt` 一并修好**：作为真正的输入声明点。

### 3.1 数据 vs 结构性 参数分类（`src/lib/workflow/data-params.ts`）

每个块的参数分成两类，**单一真相源**被改写器与校验器共用：

- `data`（业务数据，必须是 `{{引用}}`，记录时字面量被改写）：
  填表内容、网址、请求体、通知文案、比较值、AI 提示词、condition 的 right 操作数等。
  支持嵌套路径（`conditions[].right`）。
- `structural`（结构性，字面量才是正确的形式）：
  `selector` / `findBy` / `target`（元素定位）、`variableName`、`attributeName`、
  `type` / `method` / `responseType`（枚举）、`days` / `shortcut` / `interval` / `time`（配置）、
  `workflowId`。把选择器写成 `{{x}}` 只会让节点既读不懂也重放不了。

### 3.2 字面量自动改写（`src/lib/workflow/dynamic-data.ts`）

- `rewriteDataParams`：扫描数据类参数里的字面量，改写：
  1. 若某变量的值已等于该字面量（`buildVariableIndex` 由 `draft.variables`
     建立"值→变量名"索引，与 `buildSecretIndex` 同构）→ 直接复用 `{{已有变量}}`。
  2. 否则声明成一个**工作流输入** `{{名字}}`，记录默认值。
  - **不改写原始 `data`**：原始参数仍要真实驱动页面；只返回改写后的副本 + 新输入清单。
  - 命名：`inputName` 提示优先（用用途词如 `keyword`/`city`），否则按算子自动生成
    （用路径最后一段，如 `formsValue` 而非 `dataValue`）。

### 3.3 输入声明落到触发器（`src/lib/workflow/types.ts` + `migrate.ts` + `trigger-patch.ts`）

- 把 `WorkflowParameter` 从编辑器 `ParameterFields.tsx` 提到 `lib/workflow/types.ts` 共享。
- 给 `WorkflowTrigger` 加 `parameters?: WorkflowParameter[]`。
- `triggerFromNodes` 现在透传 `parameters`（之前只搬 type/enabled/urlPattern/menuItemId）。
- `operator-tool-handler.ts` 新增 `declareWorkflowInputs`：把新输入写入 trigger 节点
  `data.parameters` **与**顶层镜像（两处都要改，因为 `visit-web`/`context-menu`
  运行期读镜像）。
- `withInputDefault`：保存卡片改默认值，落在节点上（镜像会重新派生，落镜像会被覆盖）。

### 3.4 录制路径接线（`src/background/operator-tool-run.ts`）

- 在 `redactRecordedParams`（凭证改写，已存在）之后调用 `rewriteForRecording`：
  从 `draft.variables`（排除凭证键）建索引 → `rewriteDataParams` →
  `declareWorkflowInputs` 写回 → 把"哪些参数被改写成了什么引用"回传给模型。
- `runOperatorTool`（handler 里的记录-only 路径）同样应用改写，避免第二条追加路径漏掉约束。
- `inputName` 作为 draft-only 提示，加入 `stripDraftOnlyKeys`（不进持久化节点）。

### 3.5 修好 `parameter-prompt`（`src/background/workflow-engine/executors.ts`）

- 改为读 `parameters: WorkflowParameter[]`，逐个 `interpolate` 默认值后填进变量袋。
- 缺必填值时**抛错**（`throw`，因为 `BlockExecutor` 无错误返回通道，失败靠抛），
  不再静默传空串。

### 3.6 运行期变量预置（`src/background/workflow-engine/run-workflow.ts`）

- `executeWorkflow` 仍不传 `variables`（调用点太多），改为在引擎内部从
  `workflow.trigger.parameters` 的 `defaultValue` 预置变量袋：
  `variables = { ...seedWorkflowInputs(trigger), ...opts.variables }`。
- resume（断点续跑）路径也叠在 seed 之上，不丢默认值。
- 未来 `visit-web` 的 query / 飞书命令参数可覆盖同名输入（本期未接，留接口）。

### 3.7 提示词与保存卡片

- `operator-guide.ts`：删掉"字面量直接写 forms.value"，新增"业务数据必须 `{{引用}}`，
  结构性参数保持字面量"规则段落（指南在 8000 字预算内，实测有余量）。
- `agent.ts` 工作流分支系统提示：加一句"业务数据用 `{{引用}}`，结构参数用字面量，
  字面量会被自动改写成输入；可以把 `inputName` 给输入起名"。载荷测试仍在预算内。
- `ChatTab.tsx` 保存卡片：声明输入清单（双语 `chatWorkflowInputsTitle`/`Hint`），
  展示 `{{名称}}` 与默认值，让用户知道这些会每次运行重新提示/可覆盖。

### 3.8 残留死数据校验（`src/lib/workflow/validation.ts`）

- `validateWorkflowForRun` 遍历动作节点，对数据类参数里的字面量（非 `{{引用}}`）
  给 **warning**（不阻断）：步骤仍跑，只是用冻值；是否该动态化由用户判断。
  hand-edited / 导入 / 旧版保存的工作流仍可能带死数据，warning 比 error 合适。

## 4. 接线点清单（改功能前先读）

| 关注点         | 文件                                                             | 说明                                                        |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| 参数分类真相源 | `src/lib/workflow/data-params.ts`                                | `dataParamSpecs` / `dataValueSites`                         |
| 字面量改写     | `src/lib/workflow/dynamic-data.ts`                               | `rewriteDataParams` / `buildVariableIndex` / `hasReference` |
| 输入读写       | `src/lib/workflow/workflow-inputs.ts`                            | `seedWorkflowInputs` / `missingRequiredInputs`              |
| 类型           | `src/lib/workflow/types.ts`                                      | `WorkflowParameter` 提到此处；`WorkflowTrigger.parameters`  |
| 触发器派生     | `src/lib/workflow/migrate.ts`                                    | `triggerFromNodes` 透传 parameters                          |
| 声明写回       | `src/background/operator-tool-handler.ts`                        | `declareWorkflowInputs` / `stripDraftOnlyKeys`              |
| 录制接线       | `src/background/operator-tool-run.ts`                            | `rewriteForRecording`                                       |
| 执行器修复     | `src/background/workflow-engine/executors.ts`                    | `parameter-prompt`                                          |
| 运行期预置     | `src/background/workflow-engine/run-workflow.ts`                 | `seedWorkflowInputs`                                        |
| 校验           | `src/lib/workflow/validation.ts`                                 | `validateWorkflowForRun` 死数据 warning                     |
| 提示词         | `src/lib/workflow/operator-guide.ts` / `src/background/agent.ts` | 规则文案                                                    |
| UI             | `src/sidepanel/ChatTab.tsx` / `src/lib/i18n.ts`                  | 保存卡片输入清单                                            |

## 5. 验证

- 单元：`tests/data-params.spec.ts`(15) / `dynamic-data.spec.ts`(22) / `workflow-inputs.spec.ts`(18)
- 端到端：`tests/dynamic-data-flow.spec.ts`(11) —— 从生成（字面量→`{{引用}}`+声明输入）
  到重放（`parameter-prompt` 从默认值填变量）打通。
- 全量：141 文件 / 1741 tests；tsc 两 tsconfig 0 错误；eslint src tests 干净；
  prettier 干净；`verify:injected` OK。
- 注入函数产物验证（`tmp/verify-injected-build.mjs`，参数化目录）本期未重跑——本轮未碰
  `executeScript` 注入点，守卫已覆盖。

## 6. 遗留 / 注意

- 运行期弹窗（侧边栏询问）与页内询问（`preferParamsInTab`）本期**未接**，
  按用户选择只走"触发器预置 + 上游产出"。`preferParamsInTab` 字段仍无人消费。
- `visit-web` query 覆盖、飞书命令参数覆盖同名输入：留了接口（`variables` 叠在 seed 之上），
  本期未接。
- 载荷预算（agent-payload-size）余量仅 ~460 字，加提示词已贴边，**新增系统提示文案需先量预算**。

---

## 7. 修订（2026-09-18）：补上"没有来源"这一类

### 7.1 症状

用户在聊天里让工作流生成模式做「帮我在微博上 查前20条热搜 并下载到本地」，
拿到的工作流只有三个节点：

```
trigger(manual) → new-tab(url={{newTabUrl}}) → save-local(filename={{saveLocalFilename}},
                                                          value={{saveLocalValue}})
```

其中 `saveLocalValue` 的默认值是一整份 20 行 CSV——**生成时页面上的那份**。
工作流里没有任何节点读取微博，重放时它只会把那份旧快照再写一遍文件。

### 7.2 根因：第 3.2 节的分类少了一格

3.2 把字面量分成两类来源：**上游产出**（改成 `{{变量}}`）与**只能从外部传入**
（声明成工作流输入，观察值作默认值）。这个二分法漏掉了一整类：

> **页面内容**——既不是上游节点产出的，也不是用户会提供的。它是模型用**自己的
> 读取工具**（`snapshot_page` 等）看到的，然后在脑子里整理好，再塞给某个汇点算子。

模型正是这么做的：它读了页面、自己拼出 CSV、把 CSV 交给 `save-local`。
改写器按 3.2 的第 2 条把它"合法化"成一个**工作流输入**——于是本该是
「工作流抓不到数据」的明显故障，变成了一张看起来正常的输入声明卡片，
**所有报错信号都被抹掉了**。这是比死数据更坏的结果：死数据至少还看得出是硬编码。

判据缺口很清楚：`rewriteDataParams` 无法区分"用户会填的输入"和"页面该抓的内容"，
而且**默认偏向后者**（无来源就声明成输入）。这个默认值对用户旋钮是对的，
对页面内容恰好是错的。

### 7.3 判据：用"体积"作代理

没有可靠的语义信号能区分二者，但有一个很强的**形态**信号：
**用户旋钮是短的、单行的**（关键词、文件名、邮箱、URL）。
没有人会往触发器输入框里粘贴 20 行表格。

于是 `looksLikeBulkContent(value)`：

| 条件                      | 捕获的形态               |
| ------------------------- | ------------------------ |
| `length > 400`            | 单行塞进一整份清单       |
| `length > 200` 且换行 ≥ 8 | 整段粘贴的多行列表 / CSV |

两个阈值都**故意放宽**。理由：这道闸门只要抓住"把快照交给汇点"这个明显形态即可，
不需要裁决每一个值。漏判退化成旧行为（仍是死数据，但校验会给 warning）；
误判则**挡住一次合法调用**，代价不对称。

### 7.4 为什么不用"多行"单独作判据

第一版规则是 `含换行 || 超长`。写测试时发现它会误伤
**多行 JSON 配置体**——webhook 的 body 模板天然是多行的，而它是**合法的常量**
（属于"用户提供"那一侧）。测试里为此固定了一条用例
（`accepts a multi-line config body`）。所以改成"行数 + 长度"双条件。

### 7.5 设计

**常量层**（`src/lib/workflow/data-params.ts`）

- `DataParamSpec.allowBulk`：唯一豁免。只给 `ai-agent.prompt`——
  指令是**说给工作流听的**（属于"用户提供"），不是工作流**要去取的**，
  长提示词声明成输入恰恰是对的。
- `DataValueSite.allowBulk` 透传该标志，让 gate 不必自己重查分类表。

**闸门层**（`src/lib/workflow/dynamic-data.ts`）

- `unproducedBulkData(blockId, data, variableIndex)`：返回**第一个**可疑站点（不是布尔），
  这样拒绝文案能点名到具体参数。跳过三种情况：已有 `{{引用}}`、上游变量里有这个值、
  参数带 `allowBulk`。
- `unproducedDataRefusal(blockId, site)`：拒绝文案**逐个点名算子**并给出采集配方
  （`get-text` + `multiple`+`saveData`+`dataColumn`、`attribute-value`、`ai-agent`、
  `export-data`），并点明 `save-local` 只适合单个值、导出整表要用 `export-data`。
  泛泛的"请先记录读取步骤"会被模型无视——这是脚本闸门那轮已经验证过的经验。
- **两条记录路径共用**（`operator-tool-run` 执行路径 + `operator-tool-handler` 纯记录路径），
  与脚本闸门同样的理由："没有任何路径记录无来源内容"比"某条路径不记录"更便宜。
- **在任何副作用之前拒绝**：不碰页面、不写草稿。执行路径里放在
  `executeOperatorNode` 之前。

**为什么也拦 `set-variable`**：否则模型可以把 CSV 先塞进变量再引用，
同一份快照换一个跳板。测试里专门有一条 `cannot be laundered through set-variable`。

**提示词与指南**

- `agent.ts` 工作流段落把原来那句"或让桥接声明成工作流输入"（**正是它诱导了这次故障**）
  换成硬规则：页面内容必须由某个步骤**生产**；采集用 `get-text`
  （`multiple`+`saveData`+`dataColumn`），理解用 `ai-agent`，导出用 `export-data`。
- `operator-guide.ts`：
  - 「save-local 尤其要注意」整段重写——原文写的是"内容没有活来源时，让它成为工作流输入"，
    这条规则直接导致了本次故障，必须改掉。
  - 新增「页面内容必须有'生产者'节点」小节 + 采集清单的固定写法。
  - 「三种固定搭配」新增第 4 条：采集并导出页面清单（先采、再导）。
  - 「节点取舍」里"一次性读取"那条补上反向情形：**若后续步骤要用这份内容，
    这个读取就是生产者，必须保留**——原表述可能被理解成"读来自己看的都可以删"。

### 7.6 接线点

| 关注点         | 文件                                      | 说明                                                                                               |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 闸门本体       | `src/lib/workflow/dynamic-data.ts`        | `looksLikeBulkContent` / `unproducedBulkData` / `unproducedDataRefusal` / `MAX_BULK_LITERAL_CHARS` |
| 豁免标志       | `src/lib/workflow/data-params.ts`         | `DataParamSpec.allowBulk`（仅 `ai-agent.prompt`）、`DataValueSite.allowBulk`                       |
| 执行路径接线   | `src/background/operator-tool-run.ts`     | `executeOperatorNode` 之前                                                                         |
| 纯记录路径接线 | `src/background/operator-tool-handler.ts` | `rewriteDataParams` 之前                                                                           |
| 提示词         | `src/background/agent.ts`                 | 工作流模式段落                                                                                     |
| 领域指南       | `src/lib/workflow/operator-guide.ts`      | 生成技能说明 + 保存前 AI 审查共用                                                                  |

### 7.7 验证

- 新增 `tests/data-producer-gate.spec.ts`（22 例）：形态判定边界、
  四种"合法来源"全部放行、`set-variable` 洗白被拦、端到端复现用户报告的故障
  （拒绝 + **未执行任何块** + **草稿零节点**）、修正后的管线通过且记录成 `{{hotList}}`。
- 新增 `tests/skills.spec.ts` 两条护栏：内置技能指令不得超 `MAX_INSTRUCTIONS_LENGTH`，
  且 workflow-generator 指南至少留 200 字余量。理由：技能存储对超长指令是
  `.slice` **静默截断**，而截掉的正好是**末尾的任务指令**——指南一路变长，
  迟早会在没人察觉的情况下丢掉模型真正照着做的那段。
- **变异实测**：把 `unproducedBulkData` 的站点循环改成空数组（等于关掉闸门），
  **恰好 6 个用例失败**，其余 16 个通过——断言确实卡在闸门上，不是复述实现。
- 全量：146 文件 / 1809 用例全绿；两个 tsconfig 0 错；`eslint src tests` 干净；
  prettier 干净。
- 载荷（工作流第 1 轮）：**23913/24000，余量 87 字**。新增规则的同时压缩了同段冗余句
  （"EXACTLY like full auto"、"read it, fix the parameters, and call it again" 等），
  净增仅 45 字。**余量已经比上一轮更紧，再改这个模式的提示词必须先跑
  `tests/agent-payload-size.spec.ts`。**
- 指南：`builtin-workflow-generator` 指令 **7708 / 8000**（余量 292）。

### 7.8 遗留 / 注意

- **闸门是形态启发式，不是证明**。8 行以下、且总长不到 400 的粘贴内容会漏过。
  残留死数据仍有 `validateWorkflowForRun` 的 warning 兜底。
- **"合法长常量"没有逃生口**。若模型确实要往文件/请求体里写一段多行长文本
  （不是页面内容），会被拒绝且无处申辩。判断依据是这种需求在浏览器自动化里
  极罕见，而给它开逃生口等于把闸门重新变成建议。若将来确有需要，
  应当按脚本闸门那样加**必填理由**，而不是放宽形态判定。
- 历史 → 工作流的编译路径（`workflowFromHistory`）**不经过**这道闸门——
  它编译的是既有记录而非模型实时调用。该路径的批量内容仍可能死数据化。
- `new-tab.url` 仍会被声明成工作流输入（`{{newTabUrl}}`）。它短、单行，
  属于"用户可改的目标站点"，本期判定为可接受，未动。

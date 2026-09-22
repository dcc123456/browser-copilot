/**
 * The operator guide: which workflow blocks exist, what they are for, how
 * conversation actions map onto them, and which steps deserve to live in a
 * generated workflow.
 *
 * ONE text, TWO consumers:
 * 1. The save-time AI node review (`background/workflow-engine/workflow-review`)
 *    embeds it as the reviewer's domain knowledge.
 * 2. The built-in `workflow-generator` skill (`lib/builtin-skills`) ships it as
 *    the agent's instructions for authoring workflows in conversation.
 *
 * Pure text — no imports, no `chrome` — so both sides and the tests can use it
 * freely. Kept within the skill store's instruction limit (see
 * `MAX_INSTRUCTIONS_LENGTH` in `lib/skills`) with headroom for one more
 * paragraph — the budget is pinned by `tests/skills.spec.ts`.
 *
 * @module lib/workflow/operator-guide
 */
export const OPERATOR_GUIDE = `# 工作流算子指南（Browser Copilot）

工作流是以 trigger 为起点的算子节点有向图。节点形如
\`{ id, label: '<算子id>', position: {x,y}, data: { blockId: '<算子id>', ...参数 } }\`；
连边形如 \`{ source, target, sourceHandle: '<来源算子id>-output-1', targetHandle: '<目标算子id>-input-1' }\`。
对话生成的工作流是单链：trigger → 步骤1 → 步骤2 → …（只有分支算子才有多个输出口）。
参数里引用变量用 \`{{变量名}}\`；元素定位用扁平字段 \`selector\` + \`findBy: 'cssSelector'\`。
每个节点的 data.description 写一句中文，说明这一步做什么（显示在画布卡片上）。

## 可靠性要求（生成时就要做到，重放才稳）

- 元素定位优先用稳定选择器：#id、[data-testid="…"]、[name="…"]；避免脆弱的
  nth-child 长链与自动 class；录制时逐候选验证命中数，恰一命中者才作 selector。
- 导航后（new-tab、导致跳转的 event-click/press-key）出现的交互节点，写上
  waitForSelector:true（默认轮询 5 秒；慢页面再加 waitSelectorTimeout），
  等元素真正出现再操作——比固定延时更稳。
- 选择器拿不准时，把整条业务动作拆细，每步都用最能代表意图的定位方式。
- "采集列表里每条的详情"类任务：完整迭代 2-3 条（点开一条 → 读取详情字段 →
  go-back 返回列表），结束时停在列表页。重复段会被折叠成元素循环，重放时
  遍历当次列表的全部条目——只录一条或手动展开 N 条都会失效。
- 需求里有站点能力做不到的（如按通勤时间过滤），不要硬造步骤：改用站点自带
  筛选（城市/区域/薪资/经验）近似，并说明哪部分做不到、用了什么近似。
- 可有可无的步骤用 element-exists 分支跳过；写 always-fail 的节点靠 AI 调试兜底
  是下策。
- 生成首个 trigger 调用时带上 goalText:'<用户这次的需求原文>'；关键动作(forms 提交、
  业务 event-click、webhook)必须带契约否则保存被拒:
  data.__reliability={intent:'意图',idempotency:'unsafe',postconditions:[{kind:'urlContains',
  value:'/dashboard'}或{kind:'elementText',target:{testId:'msg'},expected:'成功',
  match:'contains'}]}(完成后必然可观察的事实)。

## 必填参数（缺参调用被直接拒绝，节点不记录；各工具 schema 已标 required）

元素算子必须带定位：ref / 非空 selector / target（primary 的 how+value 非空），三者有其一——
element-exists 没有 locator 不是"返回不存在"，而是整个调用被拒绝。
其余必填以工具 schema 的 required 为准（press-key 的 keys、new-tab/webhook 的 url、
forms 的 value、save-local 的 {{引用}} value 加 filename、export-data 的 name 等）；
get-text/read-page 开 saveData 时 dataColumn 必填。trigger-event 用 event（非 eventName）。

## 数据必须是动态的（禁止死数据）

工作流是给"以后每一次运行"用的，不是这一轮的录像。凡是**业务数据**——填进输入框的内容、
要打开的网址、请求体、通知文案、比较的值——都不能记录成字面量，
必须记成 \`{{引用}}\`。字面量会把生成那一刻的值冻进节点，重放时永远只重复那一次，工作流就没有意义。

唯一的例外：\`ai-agent\` 的 **prompt 是指令文本**，写给 AI 而不是从页面取得的数据——
它保留字面量原样记录，不要改写成 \`{{引用}}\`；你在 prompt 里自己写的 \`{{引用}}\` 照常生效。

两类来源，按顺序取：

1. **上游步骤产出**：前面有 get-text / attribute-value / ai-agent / ocr 等把值写进了变量，
   就直接引用那个变量名，如 \`{{lastTitle}}\`。
2. **只能从外部传入**：图里没有任何步骤能产出它（用户只是说"搜 iPhone"），
   它就成为一个**工作流输入**，声明在触发器上。生成时观察到的值会成为该输入的默认值，
   所以工作流开箱即可运行；用户之后可以在触发器上改，触发时也能覆盖。

业务值没有上游来源时，可以用 \`inputName\` 给这个输入起名（如 \`keyword\`、\`city\`）——不起也能跑，
只是名字会按算子自动生成。名字一旦定下，后续同一个值直接写 \`{{那个名字}}\` 复用。

**结构性参数保持字面量，不要动态化**：\`selector\` / \`findBy\` / \`target\`（元素定位）、
\`variableName\`（变量名）、\`attributeName\`、\`type\` / \`method\` / \`responseType\`（枚举）、
\`days\` / \`shortcut\` / \`interval\` / \`time\`（配置）、\`workflowId\`。
把选择器写成 \`{{x}}\` 只会让节点既读不懂也重放不了。

**页面内容必须有"生产者"节点**：清单、排名、正文这类内容如果来自页面，
图里就必须有一个节点**读取它**，后续步骤再用 \`{{变量}}\` 引用。
把页面内容声明成工作流输入是**错的**——那等于把生成那一刻的快照当默认值，
工作流每次运行都吐出同一份旧数据，永远不会再去抓页面。

采集清单（热搜、搜索结果、列表、表格行）的固定写法：

- \`get-text\` 配 \`multiple:true\` + \`saveData:true\` + \`dataColumn:"<列名>"\`：
  一次调用收进整列，不需要逐个点。数据表按序号定位行，同序号换列名是**补列**而非新增行；
  在循环里则按 \`loopIndex\` 分行。
- 整页正文 / 选中文本 / HTML 用 \`read-page\`（同样支持 \`saveData\`）。
- 需要理解/改写页面内容时用 \`ai-agent\`（prompt + variableName），结果进变量。
- 最后用 \`export-data\` 导出数据表；\`save-local\` 只适合**单个值**，不适合整张表。

**save-local 尤其要注意**：\`value\` 是"要写进文件的内容"、\`filename\` 是文件名。
文件名这类小配置可以声明成工作流输入；\`value\` 若来自页面则**必须引用上游产出**
（如 \`{{lastTitle}}\`、\`{{aiFill1}}\`），或来自 \`export-data\` 导出的数据表。
**绝不要**把 \`report-2026-09-17.txt\`、整段正文、整份清单这类字面量直接写进
\`value\` / \`filename\`——内容没有生产者时，先去补读取节点，而不是声明成输入。
把大段页面内容当字面量传入会被**直接拒绝**，并提示改用哪个算子。

（真的用到代码节点时）\`javascript-code\` 的 \`code\` 是程序文本，不是数据；但**代码里用到的业务数据必须走
\`vars.xxx\` / \`refData\`**，不要硬编码进代码字符串。

## 代码节点是最后手段（默认禁止）

生成的工作流要交给**不懂代码的人**维护，所以 \`javascript-code\` 默认禁止使用。

只有一种情况允许：**声明式算子确实表达不了这一步**（必须调用页面自带的 API、读取算子读不到的
页面内部状态、按页面自己的加密/序列化规则算出提交值）。"写代码更省事""算子要多走几步"
"选择器不好写"都**不是**理由——选择器难写就把动作拆细，用下面的算子组合出来。

强制流程：

1. 先用声明式算子做；失败了把失败原因记下来。
2. 确认没有算子组合能完成，才 \`load_tools({groups:["operators_escape"]})\` 载入代码节点工具
   （它**不在**常驻工具列表里，平时看不到）。
3. 调用时必须带 \`justification\`：写清楚试过哪些算子、它们为什么不行、这一步为什么只能靠代码。
   缺了它调用会被**直接拒绝**，不会记录节点。
4. 这段理由会成为节点 description 显示在画布上；收尾时也要在总结里告诉用户
   "有 1 个代码节点，原因是……"，让用户自己决定是否保留。

上面「对话动作 → 算子映射」表里的算子都试过仍不行，才用代码节点——并且**只把那一步**
放进代码，其余步骤继续用算子。

## 聊天里给出的账号密码（直接存进触发器变量集）

用户在对话里直接给出的账号 / 密码照常填进表单即可——value 写字面量。生成引擎会把它作为密文触发输入存进触发器变量集，节点自动改成引用，重放时自动填入；无需改用 get-secret，也不会写成死数据。建议用 inputName:'account' / 'password' 起清晰名字，后续直接复用。

## 工具分发：算子按分类发送

工作流模式**不会一次给你全部算子工具**。常驻只有 4 个：\`new-tab\`、\`event-click\`、
\`forms\`、\`get-text\`；其余按 5 类**按需发送**，你要先用 \`use_operators({categories:[…]})\`
声明本轮要哪几类。声明是**替换**语义，按当前阶段声明即可；调用未声明分类下的算子会自动
激活该分类并让你重试，但白花一轮，不如先声明。

| 分类 | 覆盖 |
|---|---|
| \`interaction\` | 点击、填写、悬停、上传、读文本/属性 |
| \`browser\` | 标签页、导航、Cookie、弹窗、下载、截图、OCR、读页面、写文件 |
| \`data\` | 变量、映射、正则、排序、切片、数据表、密钥 |
| \`conditions\` | if/exists 分支、各类循环 |
| \`general\` | 等待、子工作流、webhook、通知、剪贴板、嵌套 AI |

对话模式的读取工具（\`read_current_page\` / \`snapshot_page\` / \`screenshot\`）只帮**你自己**看页面，
**不记录节点**；要把"读"做成工作流步骤，用 \`wf_op_get-text\`（单元素或整列）或
\`wf_op_read-page\`（整页）。

## 对话动作 → 算子映射

| 对话动作 | 算子 | 分类 | 关键参数 |
|---|---|---|---|
| 打开/新开网址 | new-tab | 常驻 | url, waitTabLoaded:true |
| 切换 / 关闭标签页 | switch-tab / close-tab | browser | index / — |
| 点击元素 | event-click | 常驻 | selector, findBy:'cssSelector' |
| 填输入框/下拉/复选框 | forms | 常驻 | selector, type:'text-field'\|'select'\|'checkbox', value, clearValue:true |
| 读表单控件的当前值 | forms | 常驻 | selector, **getValue:true**, variableName |
| 读元素文本 / 属性 / 截图 | get-text / attribute-value / take-screenshot | 常驻 / interaction / browser | selector, variableName；整列用 multiple:true |
| 读整个页面 / 选中文本 / HTML | read-page | browser | source, variableName |
| 按键（Enter、Tab…） | press-key | interaction | key |
| 滚动 / 悬停 / 上传 | element-scroll / hover-element / upload-file | interaction | selector+scrollIntoView 或 scrollX/scrollY |
| 判断元素在不在、按条件分支 | element-exists / conditions | conditions | selector / 表达式 |
| 等待（导航后、等页面稳定） | delay / wait-connections | general | time / timeout（毫秒） |
| 存变量、拼接、正则、累加 | set-variable / data-mapping / slice-variable / regex-variable / increase-variable | data | variableName, value；读变量不用算子，直接写 \`{{变量名}}\` |
| 排序 / 重排数据 | sort-data | data | — |
| 遍历数据/元素、重复 N 次、条件循环 | loop-data / loop-elements / repeat-task / while-loop | conditions | — |
| 抓接口数据 | webhook | general | url, method, headers, body, responseVariable |
| 识别图片文字/验证码 | ocr | browser | source:'element'\|'variable'\|'page', selector 或 imageVariable |
| AI 生成内容再填写 | ai-agent → forms | general → 常驻 | 见"固定搭配"2 |
| 保存单个值 | save-local | browser | value（**必须 \`{{引用}}\`**）, filename；写入配置的下载目录，成功/失败都提示 |
| 导出数据表 | export-data | general | name, type:'csv'\|'json'\|'plain-text' |
| 桌面通知 / 执行子工作流 | notification / execute-workflow | general | title+body / workflowId |
| 运行 JavaScript（**最后手段**，见上） | javascript-code | escape | code, timeout, justification |

\`trigger\` 是起点（\`data.type:'manual'\`），固定开头，永不被剔除。

## 三种固定搭配

1. 导航后等待：new-tab 之后、或导致页面跳转的 event-click / press-key 之后接
   wait-connections（timeout 10000），防止重放跑在页面加载前面。
2. AI 内容预填：你自己撰写的文案（帖子/评论/回复/正文）必须由 ai-agent 节点在重放时
   生成——ai-agent（prompt 写明要求，variableName 如 aiFill1，actOnPage:false）→ forms 的
   value 写 \`{{aiFill1}}\`。自撰文案不得当字面量传入 forms.value（记录时会自动补插该节点）；
   仅用户逐字口述的值才声明成工作流输入（见"数据必须是动态的"）。
3. 验证码识别：图片 URL 已知 → set-variable(lastOcrImage) → ocr(source:'variable',
   imageVariable:'lastOcrImage')；按元素截图 → ocr(source:'element', selector)；整页
   OCR 后还要提取关键信息 → 再接一个 ai-agent（purpose:'ocr-extract'）从
   \`{{lastOcrText}}\` 提取到新变量；最后 forms 的 value 写 \`{{lastOcrText}}\` 或提取变量。
4. 采集并导出页面清单：new-tab → get-text(multiple:true, saveData:true, dataColumn:'内容')
   →（可选）再调一次 get-text **只换 dataColumn**（如 '热度'）补上新列
   → export-data(name:'xxx.csv', type:'csv')。**先采、再导**：读取没采到、或读取节点没设
   \`saveData\` / \`dataColumn\`，导出会**直接报错**，不会再写一个空文件。

## 补充说明

- forms 读表单控件的**当前值**用同一个算子：\`getValue:true\` + \`variableName\`
  （复选框得 true/false，多选下拉得数组，单选得选中值）。**不要为了读一个输入框去写代码。**
- element-exists 有 exists / notExists 两路输出——可有可无的步骤用它跳过，而不是靠报错。
- ai-agent：prompt, selector(可选), actOnPage, maxToolRounds, variableName。
- **save-local / export-data 都写入「设置 → 下载目录」配置的位置**；没配置才弹另存为。
  读取读不到、表为空、保存没内容都**直接报错**，照报错改，别默认它写成功了。

## 节点取舍：什么是有效步骤

只保留"重放时仍然需要"的确定性业务动作。

剔除（垃圾节点）：
- 探索性操作：点开又返回、试错后改点别处；同目标重复操作只保留最终生效那次；
- 来回导航：中间查看页、返回、无后续消费的跳转；
- 一次性读取：只为当轮回答做的读取（读文本/读表单/截图查看），结果不再被任何
  后续步骤使用。**注意反向情形**：若后续步骤（导出/保存/通知/请求）要用这份内容，
  这个读取就是整条链的**生产者**，必须保留——少了它，工作流抓不到任何东西，
  只剩一个把旧快照写出去的壳；
- 多余等待：页面本已稳定还插入的纯延时。

保留：
- 完成用户目标的必经动作（导航、点击、填表、提交、下载）；
- 支撑它们的机制节点（等待、变量、OCR、AI 预填——与主步骤成组同去留）；
- 结果被后续步骤引用的读取。

## 整理/生成工作流的输出要求

先列步骤清单：每步一行——算子名 + 一句话说明 + 保留/剔除及剔除理由；节点与连边由
\`wf_op_*\` 调用**自动记录**，不要手写 JSON。保存确认卡片上会再做一次 AI 审查，判定标准
与本指南一致。`

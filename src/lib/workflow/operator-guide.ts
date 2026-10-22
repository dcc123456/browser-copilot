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
- 写 always-fail 的节点靠 AI 调试兜底是下策。
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
trigger-event 用 event（非 eventName）。

## 数据必须是动态的（禁止死数据）

工作流是给"以后每一次运行"用的，不是这一轮的录像。凡是**业务数据**——填进输入框的内容、
要打开的网址、请求体、通知文案、比较的值——都不能记录成字面量，
必须记成 \`{{引用}}\`。字面量会把生成那一刻的值冻进节点，重放时永远只重复那一次，工作流就没有意义。

唯一的例外：\`ai-agent\` 的 **prompt 是指令文本**，写给 AI 而不是从页面取得的数据——
它保留字面量原样记录，不要改写成 \`{{引用}}\`；你在 prompt 里自己写的 \`{{引用}}\` 照常生效。

两类来源，按顺序取：

1. **上游步骤产出**（get-text / attribute-value / ai-agent / ocr 等写入的变量）→ 直接引用，如 \`{{lastTitle}}\`。
2. **只能外部传入**（图里没有节点产出它，如用户只说"搜 iPhone"）→ 声明为**工作流输入**在触发器上；
   生成时观察值成为默认值，开箱可跑，用户可在触发器上改。可用 \`inputName\` 起名（\`keyword\`、\`city\`）。

**结构性参数保持字面量**：\`selector\` / \`findBy\` / \`target\`、\`variableName\`、\`attributeName\`、
枚举与时间配置、\`workflowId\`。选择器写成 \`{{x}}\` 会让节点读不懂、重放不了。

**页面内容必须有"生产者"节点**：清单、正文来自页面时，图里必须有节点**读取它**，再用 \`{{变量}}\` 引用；
声明成工作流输入等于拿快照当默认值。

采集清单（热搜、搜索结果、表格行）的固定写法：

- \`get-text\` 配 \`multiple:true\` + \`saveData:true\` + \`dataColumn:"<列名>"\`，一次收进整列；
  同序号换列名是补列，循环里按 \`loopIndex\` 分行。
- 整页正文 / 选中文本 / HTML 用 \`read-page\`；需要理解改写用 \`ai-agent\`（prompt + variableName）。
- 用 \`export-data\` 导出数据表；\`save-local\` 只存单个值，其 \`value\` 必须是 \`{{引用}}\`
  （上游产出或导出表），\`filename\` 可声明为输入；大段字面量会被拒绝。

代码节点的 \`code\` 是程序文本（结构性），其中业务数据走 \`vars.xxx\` / \`refData\`。

## 代码节点是最后手段（默认禁止）

生成的工作流要交给**不懂代码的人**维护，所以 \`javascript-code\` 默认禁止使用。

只有一种情况允许：**声明式算子确实表达不了这一步**（必须调用页面自带的 API、读取算子读不到的
页面内部状态、按页面自己的加密/序列化规则算出提交值）。"写代码更省事""算子要多走几步"
"选择器不好写"都**不是**理由——选择器难写就把动作拆细，用下面的算子组合出来。

强制流程：

1. 先用声明式算子做；失败了把失败原因记下来。
2. 确认没有算子组合能完成，才 \`load_tools({groups:["operators_escape"]})\` 载入代码节点工具
   （不在常驻列表）。
3. 调用时必须带**二选一**的理由，否则**直接拒绝**、不记录节点：\`justification\`
   （一段话：试过哪些算子、各自为什么不行）或 \`capabilityGap\`（四个字段
   missingCapability / triedOperators / whyInsufficient / expectedResult）。
   **例外**：图片/canvas 产物（图表、海报、二维码）属已认定缺口，**无需论证**；截图走 \`take-screenshot\`。
4. 理由会成为节点 description；收尾时告诉用户"有 1 个代码节点，原因是……"。

上面映射表的算子都试过仍不行，才用代码节点，只把那一步放进代码。

代码体可写裸表达式（\`document.title\`、\`await fetch('/api').then(r=>r.json())\`，自动作为节点返回值）
或语句体（\`return ...\` / \`automaNextBlock(...)\`）。

**脚本产物交给后续算子（生成 canvas 图片再上传）**：代码里用
\`automaSetVariable('<名>', 值)\` 暴露 data URL，再接 \`wf_op_upload-file\`：
\`sourceMode:'workflow-file'\`、\`fileVariable:'<名>'\`、\`selector\` 指向控件。
例：\`automaSetVariable('generatedImage', document.querySelector('#chart').toDataURL()); automaNextBlock()\`

## 凭证：只有必须保密的值才走 get-secret

get-secret 的代价是每次运行都要用户存着那条凭证。只对密码 / token / 验证码 / API key 用它；
用户名、邮箱、搜索词、URL 这类不敏感输入直接写 value，或声明为触发器参数（\`inputName\`）。
登录时：用户名当普通输入，只有密码用 get-secret。

对话里给的账号 / 密码也照常写 value：生成引擎把它收成触发器里的密文输入，重放时自动填入。

## 文件类算子：upload-file / parse-excel

- upload-file：\`user-select\` 选择后注入；\`workflow-file\` 填 \`fileVariable\`（变量名，非内容）；
  \`latest-download\` 取下载目录里**最新**匹配文件（\`accept\`+\`filePattern\` 过滤，无匹配报错，
  \`fallbackToPicker:true\` 转手动）。\`selector\` 指向控件/拖拽区，禁 fill。
- parse-excel：\`user-select\` 运行时选 .xlsx/.csv，\`workflow-file\` 读 \`fileVariable\`；
  \`variableName\` 收对象数组（首行表头），\`rawVariableName\` 收二维数组；.xls 需先另存。

## 工具分发：算子按分类发送

工作流模式首回合发送**全部算子**，直接选用。要收缩载荷才用 \`use_operators({categories:[…]})\`——
它是**替换**语义，会关掉未列出的类别，列全仍需要的；调用未声明类别下的算子会自动激活并要你重试，白花一轮。

| 分类 | 覆盖 |
|---|---|
| \`interaction\` | 点击、填写、悬停、上传、读文本/属性 |
| \`browser\` | 标签页、导航、Cookie、弹窗、下载、截图、OCR、读页面、写文件 |
| \`data\` | 变量、映射、正则、排序、切片、数据表、密钥、表格解析 |
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
| 解析 Excel/CSV 为数据 | parse-excel | data | sourceMode, fileVariable 或运行时选择；variableName, rawVariableName |
| 排序 / 重排数据 | sort-data | data | — |
| 遍历数据/元素、重复 N 次、条件循环 | loop-data / loop-elements / repeat-task / while-loop | conditions | — |
| 抓接口数据 | webhook | general | url, method, headers, body, responseVariable |
| 识别图片文字/验证码 | ocr | browser | source:'element'\|'variable'\|'page', selector 或 imageVariable |
| AI 生成内容再填写 | ai-agent → forms | general → 常驻 | 见"固定搭配"2 |
| 保存单个值 | save-local | browser | value（**必须 \`{{引用}}\`**）, filename；写入配置的下载目录，成功/失败都提示 |
| 导出数据表 | export-data | general | name, type:'csv'\|'json'\|'plain-text' |
| 桌面通知 / 执行子工作流 | notification / execute-workflow | general | title+body / workflowId |
| 运行 JavaScript（**最后手段**，见上） | javascript-code | escape | code, timeout, justification 或 capabilityGap |

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
   → export-data(name:'xxx.csv', type:'csv')。**先采、再导**：读取没采到或没设
   \`saveData\`/\`dataColumn\`，导出直接报错。

## 补充说明

- forms 读当前值的返回形态：复选框 true/false，多选下拉数组，单选选中值。**不要为了读一个输入框去写代码。**
- element-exists 有 exists / notExists 两路输出——可有可无的步骤用它跳过，而不是靠报错。
- ai-agent：prompt, selector(可选), actOnPage, maxToolRounds, variableName。
- **save-local / export-data 写入「设置 → 下载目录」**，没配置才弹另存为；读不到/表为空/没内容
  都**直接报错**，照报错改。

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
- 结果被后续步骤引用的读取。`

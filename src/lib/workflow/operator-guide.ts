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
 * freely. Kept under the skill store's 8000-char instruction limit.
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

## 对话动作 → 算子映射（从会话生成工作流时的固定映射）

| 对话动作 | 算子 blockId | 关键参数 |
|---|---|---|
| 打开/新开网址 | new-tab | url, waitTabLoaded:true |
| 切换标签页 | switch-tab | index |
| 关闭标签页 | close-tab | — |
| 点击元素 | event-click | selector, findBy:'cssSelector' |
| 填输入框/下拉/复选框 | forms | selector, type:'text-field'|'select'|'checkbox', value, clearValue:true |
| 按键（Enter、Tab…） | press-key | key |
| 滚动页面/元素 | element-scroll | selector+scrollIntoView:true，或 scrollX/scrollY |
| 等待 | delay / wait-connections | delay: time(毫秒)；wait-connections: timeout(毫秒) |
| 运行 JavaScript | javascript-code | code, timeout |
| 识别图片文字/验证码 | ocr | source:'element'|'variable'|'page', selector 或 imageVariable, variableName:'lastOcrText', preprocess |
| AI 生成内容再填写 | ai-agent → forms | 见"固定搭配"2 |
| 存变量 | set-variable | variableName, value |

## 三种固定搭配

1. 导航后等待：new-tab 之后、或导致页面跳转的 event-click / press-key 之后接
   wait-connections（timeout 10000），防止重放跑在页面加载前面。
2. AI 内容预填：需要 AI 撰写内容填表时 → ai-agent（prompt 说明要生成什么，
   variableName 如 aiFill1，actOnPage:false）→ 后一个 forms 的 value 写 \`{{aiFill1}}\`。
   字面量内容直接写进 forms.value，不要绕道 AI。
3. 验证码识别：图片 URL 已知 → set-variable(lastOcrImage) → ocr(source:'variable',
   imageVariable:'lastOcrImage')；按元素截图 → ocr(source:'element', selector)；整页
   OCR 后还要提取关键信息 → 再接一个 ai-agent（purpose:'ocr-extract'）从
   \`{{lastOcrText}}\` 提取到新变量；最后 forms 的 value 写 \`{{lastOcrText}}\` 或提取变量。

## 常用算子速查

- trigger 触发器：起点，data.type:'manual'。生成的工作流固定以它开头，永不被剔除。
- event-click 点击元素：selector, findBy。
- forms 填写表单：selector, type('text-field'|'select'|'checkbox'), value(可 \`{{var}}\`), clearValue。
- press-key 按键：key。
- element-scroll 滚动：selector+scrollIntoView 或 scrollX/scrollY。
- delay 延时：time（毫秒）。wait-connections 等网络空闲：timeout（毫秒）。
- new-tab 新建标签页：url, waitTabLoaded。switch-tab 切换：index。close-tab 关闭。
- javascript-code JS 代码：code, timeout。仅在声明式算子表达不了时使用。
- ocr 本地 OCR 识别：见"固定搭配"3，识别文本存入 variableName（默认 lastOcrText）。
- ai-agent AI 智能体：prompt, selector(可选), actOnPage(是否操作页面), maxToolRounds, variableName(结果存入)。
- set-variable 设置变量：variableName, value。get-variable 读取变量。
- get-text 读元素文本 / get-form 读表单 / take-screenshot 截图：结果存入 variableName。
- element-exists 元素是否存在：selector，exists / notExists 两路输出——可有可无的
  步骤用它的分支跳过，而不是靠报错。
- conditions 条件 / condition 条件判断：按表达式分支流转。
- loop-data 遍历数据 / loop-elements 遍历元素 / repeat-task 重复 / while-loop 条件循环。
- webhook HTTP 请求：url, method, headers, body, responseVariable。
- save-local 保存文件：value, filename。notification 桌面通知：title, body。
- execute-workflow 执行子工作流：workflowId。

## 节点取舍：什么是有效步骤

生成/整理工作流时，只保留"重放时仍然需要"的确定性业务动作。

剔除（垃圾节点）：
- 探索性操作：点开又返回、试错后改点别处；同目标重复操作只保留最终生效那次；
- 来回导航：中间查看页、返回、无后续消费的跳转；
- 一次性读取：只为当轮回答做的读取（读文本/读表单/截图查看），结果不再被任何
  后续步骤使用；
- 多余等待：页面本已稳定还插入的纯延时。

保留：
- 完成用户目标的必经动作（导航、点击、填表、提交、下载）；
- 支撑它们的机制节点（等待、变量、OCR、AI 预填——与主步骤成组同去留）；
- 结果被后续步骤引用的读取。

## 整理/生成工作流的输出要求

先列步骤清单：每步一行——算子名 + 一句话说明 + 保留/剔除及剔除理由；然后给出与
清单一致的节点与连边数据。保存确认卡片上会再做一次 AI 审查，判定标准与本指南一致。`

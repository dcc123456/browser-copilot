/**
 * Block registry (palette metadata): the MVP set of installable workflow
 * blocks, grouped by category.
 *
 * Pure data — no `chrome` dependency — so it can be imported freely by the
 * editor UI, the palette, and the executor registry without pulling in any
 * runtime environment.
 *
 * @module lib/workflow/registry
 */

import type { BlockCategory, BlockDefinition } from './types'

/** The six palette categories, in display order. */
export const BLOCK_CATEGORIES: BlockCategory[] = [
  'browser',
  'navigation',
  'data',
  'control-flow',
  'integration',
  'trigger',
]

/**
 * The MVP block templates. Every block id is unique and matches the key the
 * execution engine dispatches on (`background/workflow-engine/executors.ts`).
 */
export const WORKFLOW_BLOCKS: BlockDefinition[] = [
  // --- Browser ---------------------------------------------------------------
  {
    id: 'click',
    category: 'browser',
    label: '点击元素',
    description: '点击匹配 CSS 选择器的元素。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
    ],
  },
  {
    id: 'fill',
    category: 'browser',
    label: '填写输入',
    description: '向匹配 CSS 选择器的输入框填写文本。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'value', label: '填写内容', type: 'string', required: true },
    ],
  },
  {
    id: 'select-option',
    category: 'browser',
    label: '选择下拉项',
    description: '在下拉列表中选择指定选项。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'value', label: '选项值', type: 'string', required: true },
    ],
  },
  {
    id: 'scroll',
    category: 'browser',
    label: '滚动页面',
    description: '滚动到页面顶部/底部/指定偏移，或按增量平滑滚动，也可将元素滚入视野。',
    params: [
      {
        name: 'mode',
        label: '滚动方式',
        type: 'select',
        default: 'into_view',
        options: ['into_view', 'top', 'bottom', 'by', 'incremental'],
      },
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string' },
      { name: 'x', label: '横向偏移', type: 'number', default: 0 },
      { name: 'y', label: '纵向偏移', type: 'number', default: 0 },
      {
        name: 'scrollBehavior',
        label: '滚动行为',
        type: 'select',
        default: 'auto',
        options: ['auto', 'smooth'],
      },
      {
        name: 'step',
        label: '每次步长(px)',
        type: 'number',
        default: 120,
        description: 'incremental 模式下每次滚动的距离',
      },
    ],
  },
  {
    id: 'press-key',
    category: 'browser',
    label: '按下按键',
    description: '在当前页面模拟一次键盘按键（如 Enter、Tab）。',
    params: [{ name: 'key', label: '按键', type: 'string', required: true }],
  },
  {
    id: 'wait-for',
    category: 'browser',
    label: '等待元素',
    description: '等待匹配 CSS 选择器的元素出现。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'timeout', label: '超时(ms)', type: 'number', default: 5000 },
    ],
  },
  {
    id: 'take-screenshot',
    category: 'browser',
    label: '截图',
    description: '截取可见区域、整个页面或指定元素，结果存入变量。',
    params: [
      {
        name: 'type',
        label: '截图类型',
        type: 'select',
        default: 'page',
        options: ['page', 'fullpage', 'element'],
      },
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastScreenshot' },
    ],
  },
  {
    id: 'get-text',
    category: 'browser',
    label: '读取文本',
    description: '读取第一个匹配 CSS 选择器元素的文本，存入变量 lastText。',
    params: [{ name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true }],
  },
  {
    id: 'hover',
    category: 'browser',
    label: '悬停元素',
    description: '将鼠标悬停在匹配 CSS 选择器的元素上。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
    ],
  },
  {
    id: 'set-checkbox',
    category: 'browser',
    label: '设置复选框',
    description: '勾选或取消勾选匹配 CSS 选择器的复选框。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'checked', label: '勾选', type: 'boolean', default: true },
    ],
  },
  {
    id: 'set-radio',
    category: 'browser',
    label: '选择单选项',
    description: '选中匹配 CSS 选择器的单选按钮。',
    params: [{ name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true }],
  },
  {
    id: 'get-form',
    category: 'browser',
    label: '读取表单',
    description: '读取表单中所有输入项的值，存入变量。可选 cssSelector 限定范围。',
    params: [
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastForm' },
      { name: 'cssSelector', label: 'CSS 选择器(可选)', type: 'string' },
    ],
  },

  // --- Browser actions (automa-aligned) ------------------------------------
  {
    id: 'cookie',
    category: 'browser',
    label: 'Cookie',
    description: '读取/写入/删除浏览器 Cookie，结果存入变量。',
    params: [
      {
        name: 'op',
        label: '操作',
        type: 'select',
        default: 'get',
        options: ['get', 'set', 'remove', 'getAll'],
      },
      { name: 'name', label: 'Cookie 名', type: 'string' },
      { name: 'value', label: '值', type: 'string' },
      { name: 'url', label: 'URL', type: 'string' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastCookie' },
    ],
  },
  {
    id: 'clipboard',
    category: 'browser',
    label: '剪贴板',
    description: '读取或写入系统剪贴板文本（经 offscreen 页面）。',
    params: [
      {
        name: 'op',
        label: '操作',
        type: 'select',
        default: 'get',
        options: ['get', 'insert'],
      },
      { name: 'text', label: '文本', type: 'string' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastClipboard' },
    ],
  },
  {
    id: 'element-exists',
    category: 'browser',
    label: '元素是否存在',
    description: '按 CSS 选择器判断元素是否存在，按 exists / notExists 分支流转。',
    params: [{ name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true }],
    outputs: [
      { id: 'exists', label: '存在', type: 'source' },
      { id: 'notExists', label: '不存在', type: 'source' },
    ],
  },
  {
    id: 'link',
    category: 'browser',
    label: '打开链接',
    description: '打开匹配 CSS 选择器的链接，可控制是否在新标签页打开。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'newTab', label: '新标签页打开', type: 'boolean', default: true },
    ],
  },
  {
    id: 'attribute-value',
    category: 'browser',
    label: '属性值',
    description: '读取或写入元素属性值，结果存入变量。',
    params: [
      {
        name: 'op',
        label: '操作',
        type: 'select',
        default: 'get',
        options: ['get', 'set'],
      },
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'attribute', label: '属性名', type: 'string', required: true },
      { name: 'value', label: '属性值', type: 'string' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastAttribute' },
    ],
  },
  {
    id: 'go-back',
    category: 'navigation',
    label: '后退',
    description: '在活动标签页执行浏览器后退。',
    params: [],
  },
  {
    id: 'forward-page',
    category: 'navigation',
    label: '前进',
    description: '在活动标签页执行浏览器前进。',
    params: [],
  },
  {
    id: 'tab-url',
    category: 'navigation',
    label: '标签页地址',
    description: '读取活动标签页或全部标签页的 URL。',
    params: [
      {
        name: 'scope',
        label: '范围',
        type: 'select',
        default: 'active',
        options: ['active', 'all'],
      },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastTabUrl' },
    ],
  },
  {
    id: 'active-tab',
    category: 'navigation',
    label: '活动标签页',
    description: '读取活动标签页的信息（标题、URL）。',
    params: [{ name: 'variableName', label: '变量名', type: 'string', default: 'lastActiveTab' }],
  },
  {
    id: 'new-window',
    category: 'navigation',
    label: '新建窗口',
    description: '打开一个新的浏览器窗口。',
    params: [{ name: 'url', label: '网址(可选)', type: 'string' }],
  },
  {
    id: 'create-element',
    category: 'browser',
    label: '创建元素',
    description: '在页面中注入一段 HTML。',
    params: [{ name: 'html', label: 'HTML', type: 'string', required: true }],
  },
  {
    id: 'upload-file',
    category: 'browser',
    label: '上传文件',
    description: '向文件输入框填入 data-url，模拟上传文件。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'fileData', label: '文件 Data-URL', type: 'string', required: true },
    ],
  },
  {
    id: 'handle-dialog',
    category: 'browser',
    label: '处理弹窗',
    description: '自动确认或解除页面弹出对话框。',
    params: [],
  },

  // --- Navigation ------------------------------------------------------------
  {
    id: 'open-url',
    category: 'navigation',
    label: '打开网址',
    description: '在当前标签页导航到指定网址（仅 http/https）。',
    params: [{ name: 'url', label: '网址', type: 'string', required: true }],
  },
  {
    id: 'new-tab',
    category: 'navigation',
    label: '新建标签页',
    description: '在新标签页中打开一个网址（仅 http/https）。',
    params: [{ name: 'url', label: '网址', type: 'string', required: true }],
  },
  {
    id: 'switch-tab',
    category: 'navigation',
    label: '切换标签页',
    description: '按索引切换到本窗口中的另一个标签页。',
    params: [{ name: 'index', label: '标签页索引', type: 'number', default: 0 }],
  },
  {
    id: 'close-tab',
    category: 'navigation',
    label: '关闭标签页',
    description: '关闭当前活动标签页。',
    params: [],
  },
  {
    id: 'reload-tab',
    category: 'navigation',
    label: '刷新标签页',
    description: '刷新当前活动标签页。',
    params: [],
  },

  // --- Data ------------------------------------------------------------------
  {
    id: 'set-variable',
    category: 'data',
    label: '设置变量',
    description: '把值存入工作流变量。',
    params: [
      { name: 'variableName', label: '变量名', type: 'string', required: true },
      { name: 'value', label: '值', type: 'string', required: true },
    ],
  },
  {
    id: 'get-variable',
    category: 'data',
    label: '读取变量',
    description: '读取工作流变量的值。',
    params: [{ name: 'variableName', label: '变量名', type: 'string', required: true }],
  },
  {
    id: 'insert-data',
    category: 'data',
    label: '插入数据',
    description: '向数据表新增一行（JSON）。',
    params: [{ name: 'data', label: '数据(JSON)', type: 'json', required: true }],
  },
  {
    id: 'export-data',
    category: 'data',
    label: '导出数据',
    description: '把数据表导出为 CSV 或 JSON。',
    params: [
      {
        name: 'format',
        label: '导出格式',
        type: 'select',
        default: 'json',
        options: ['csv', 'json'],
      },
    ],
  },
  {
    id: 'increase-variable',
    category: 'data',
    label: '变量递增/乘算',
    description: '对数字变量做加法或乘法并写回。',
    params: [
      { name: 'variableName', label: '变量名', type: 'string', required: true },
      { name: 'value', label: '值', type: 'number', default: 1 },
      {
        name: 'incType',
        label: '类型',
        type: 'select',
        default: 'add',
        options: ['add', 'multiply'],
      },
    ],
  },
  {
    id: 'slice-variable',
    category: 'data',
    label: '变量切片',
    description: '对字符串或数组按起止下标切片。',
    params: [
      { name: 'variableName', label: '变量名', type: 'string', required: true },
      { name: 'start', label: '起始', type: 'number', default: 0 },
      { name: 'end', label: '结束(可选)', type: 'number' },
      { name: 'output', label: '输出变量名', type: 'string' },
    ],
  },
  {
    id: 'regex-variable',
    category: 'data',
    label: '正则处理变量',
    description: '对变量做正则匹配或替换。',
    params: [
      { name: 'variableName', label: '变量名', type: 'string', required: true },
      { name: 'pattern', label: '正则', type: 'string', required: true },
      { name: 'flags', label: '标志', type: 'string', default: 'g' },
      { name: 'operation', label: '操作', type: 'select', default: 'match', options: ['match', 'replace'] },
      { name: 'replace', label: '替换串', type: 'string' },
      { name: 'output', label: '输出变量名', type: 'string' },
    ],
  },
  {
    id: 'delete-data',
    category: 'data',
    label: '删除数据行',
    description: '按下标删除数据表的一行，或清空数据表。',
    params: [
      { name: 'key', label: '行下标', type: 'number', default: -1 },
      { name: 'clearAll', label: '清空全部', type: 'boolean', default: false },
    ],
  },
  {
    id: 'sort-data',
    category: 'data',
    label: '排序数据',
    description: '按字段升序或降序排列数据表。',
    params: [
      { name: 'field', label: '字段', type: 'string' },
      { name: 'direction', label: '方向', type: 'select', default: 'asc', options: ['asc', 'desc'] },
    ],
  },
  {
    id: 'data-mapping',
    category: 'data',
    label: '映射数据',
    description: '对数据表每行应用 JS 表达式，结果存入变量。表达式字段为 mapping。',
    params: [
      { name: 'mapping', label: 'JS 表达式', type: 'string', required: true },
      { name: 'output', label: '输出变量名', type: 'string' },
    ],
  },
  {
    id: 'log-data',
    category: 'data',
    label: '记录日志',
    description: '把一段文本写入运行日志。',
    params: [{ name: 'text', label: '文本', type: 'string' }],
  },
  {
    id: 'workflow-state',
    category: 'data',
    label: '工作流状态',
    description: '读取或写入一个工作流状态变量。',
    params: [
      {
        name: 'op',
        label: '操作',
        type: 'select',
        default: 'get',
        options: ['get', 'set'],
      },
      { name: 'variableName', label: '变量名', type: 'string', default: 'state' },
      { name: 'value', label: '值', type: 'string' },
    ],
  },

  // --- Control flow ----------------------------------------------------------
  {
    id: 'condition',
    category: 'control-flow',
    label: '条件判断',
    description: '按 JS 表达式的结果选择执行路径。表达式字段名为 code。',
    params: [{ name: 'code', label: 'JS 表达式', type: 'string', required: true }],
  },
  {
    id: 'loop-data',
    category: 'control-flow',
    label: '遍历数据',
    description: '遍历一项数据（JSON 字符串），逐行执行后续步骤。',
    params: [{ name: 'data', label: '数据(JSON)', type: 'json', required: true }],
  },
  {
    id: 'repeat-task',
    category: 'control-flow',
    label: '重复执行',
    description: '将后续步骤固定重复指定次数。',
    params: [{ name: 'count', label: '重复次数', type: 'number', default: 1 }],
  },
  {
    id: 'while-loop',
    category: 'control-flow',
    label: '条件循环',
    description: '当 JS 表达式为真时反复执行后续步骤。表达式字段为 code。',
    params: [{ name: 'code', label: 'JS 表达式', type: 'string', required: true }],
  },
  {
    id: 'loop-elements',
    category: 'control-flow',
    label: '遍历页面元素',
    description: '按 CSS 选择器遍历页面中的元素，逐元素执行后续步骤，暴露 loopIndex。',
    params: [{ name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true }],
  },
  {
    id: 'delay',
    category: 'control-flow',
    label: '延时',
    description: '暂停指定毫秒数。',
    params: [{ name: 'ms', label: '毫秒', type: 'number', default: 500 }],
  },
  {
    id: 'breakpoint',
    category: 'control-flow',
    label: '断点',
    description: '暂停执行，供调试时检查变量状态。',
    params: [],
  },

  // --- Integration -----------------------------------------------------------
  {
    id: 'webhook',
    category: 'integration',
    label: '发送 Webhook / HTTP 请求',
    description: '向指定 URL 发起 HTTP 请求，支持 method/headers/body/timeout，响应存入变量。',
    params: [
      { name: 'url', label: '请求 URL', type: 'string', required: true },
      {
        name: 'method',
        label: '请求方法',
        type: 'select',
        default: 'POST',
        options: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
      },
      { name: 'headers', label: '请求头(JSON)', type: 'json', default: '{}' },
      { name: 'body', label: '请求体(JSON)', type: 'json', default: '{}' },
      { name: 'timeout', label: '超时(ms)', type: 'number', default: '30000' },
      { name: 'responseVariable', label: '响应变量名', type: 'string', default: 'lastHttpResponse' },
    ],
  },
  {
    id: 'notification',
    category: 'integration',
    label: '发送通知',
    description: '发送一条浏览器桌面通知。',
    params: [
      { name: 'title', label: '标题', type: 'string', required: true },
      { name: 'body', label: '内容', type: 'string' },
    ],
  },
  {
    id: 'javascript-code',
    category: 'integration',
    label: 'JavaScript 代码',
    description: '在沙箱中执行一段自定义 JavaScript。',
    params: [{ name: 'code', label: '代码', type: 'string', required: true }],
  },
  {
    id: 'ai-prompt',
    category: 'integration',
    label: '调用 AI',
    description: '在本步骤调用模型并返回文本结果。',
    params: [{ name: 'prompt', label: '提示词', type: 'string', required: true }],
  },
  {
    id: 'execute-workflow',
    category: 'integration',
    label: '执行子工作流',
    description: '作为子例程调用另一个工作流。',
    params: [{ name: 'workflowId', label: '工作流 ID', type: 'string', required: true }],
  },
  {
    id: 'parameter-prompt',
    category: 'integration',
    label: '参数提示',
    description: '声明一个需要输入/预置的参数变量。',
    params: [
      { name: 'variableName', label: '变量名', type: 'string', default: 'userInput' },
      { name: 'prompt', label: '提示', type: 'string', default: '请输入值' },
      { name: 'defaultValue', label: '默认值', type: 'string' },
    ],
  },
  {
    id: 'switch-to',
    category: 'integration',
    label: '切换 iframe',
    description: '指定后续操作的目标 iframe（驱动端已全框架搜索）。',
    params: [{ name: 'frameSelector', label: 'iframe 选择器', type: 'string' }],
  },
  {
    id: 'trigger-event',
    category: 'browser',
    label: '触发事件',
    description: '在匹配元素上触发一个 DOM 事件，可携带 detail 数据。',
    params: [
      { name: 'cssSelector', label: 'CSS 选择器', type: 'string', required: true },
      { name: 'event', label: '事件名', type: 'string', required: true },
      { name: 'detail', label: 'detail(JSON)', type: 'string', default: 'null' },
    ],
  },
  {
    id: 'browser-event',
    category: 'integration',
    label: '页面事件监听',
    description: '监听页面事件（需常驻 content script，当前为占位）。',
    params: [{ name: 'eventName', label: '事件名', type: 'string' }],
  },
  {
    id: 'handle-download',
    category: 'integration',
    label: '处理下载',
    description: '查找最近匹配的下载项，结果存入变量。',
    params: [
      { name: 'filename', label: '文件名包含', type: 'string' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastDownload' },
    ],
  },
  {
    id: 'save-local',
    category: 'integration',
    label: '保存到本地',
    description: '把变量/数据内容保存为本地文件（可自动保存到下载目录，或让用户选择保存位置）。',
    params: [
      { name: 'value', label: '内容', type: 'string' },
      { name: 'filename', label: '文件名', type: 'string' },
      { name: 'saveMode', label: '保存方式', type: 'string', default: 'auto' },
      { name: 'variableName', label: '变量名', type: 'string', default: 'lastSavedPath' },
    ],
  },
  {
    id: 'save-assets',
    category: 'integration',
    label: '保存资源',
    description: '把资源保存到工作区目标（需目标配置，当前为占位）。',
    params: [],
  },
  {
    id: 'proxy',
    category: 'integration',
    label: '设置代理',
    description: '配置浏览器代理（需浏览器级设置，当前为占位）。',
    params: [{ name: 'server', label: '代理地址', type: 'string' }],
  },
  {
    id: 'google-sheets',
    category: 'integration',
    label: 'Google 表格',
    description: '读写 Google Sheets（需要 OAuth 凭据，当前为占位）。',
    params: [{ name: 'spreadsheetId', label: '表格 ID', type: 'string' }],
  },
  {
    id: 'google-drive',
    category: 'integration',
    label: 'Google 云盘',
    description: '读写 Google Drive（需要 OAuth 凭据，当前为占位）。',
    params: [{ name: 'fileId', label: '文件 ID', type: 'string' }],
  },
  {
    id: 'wait-connections',
    category: 'integration',
    label: '等待网络连接',
    description: '等待页面网络连接空闲（当前为占位）。',
    params: [],
  },
  {
    id: 'note',
    category: 'integration',
    label: '备注',
    description: '在流程中加入一条说明性备注。',
    params: [{ name: 'text', label: '备注内容', type: 'string' }],
  },
  {
    id: 'blocks-group',
    category: 'integration',
    label: '块分组',
    description: '将一组块组织成一个容器（结构性）。',
    params: [],
  },

  // --- Trigger ---------------------------------------------------------------
  {
    id: 'visit-web',
    category: 'trigger',
    label: '访问网址',
    description: '当访问匹配的网址时运行工作流。',
    params: [{ name: 'urlPattern', label: 'URL 匹配(正则)', type: 'string' }],
  },
  {
    id: 'schedule',
    category: 'trigger',
    label: '定时运行',
    description: '在设定的时间或间隔运行工作流。',
    params: [{ name: 'cron', label: '时间表达式', type: 'string' }],
  },
  {
    id: 'manual',
    category: 'trigger',
    label: '手动运行',
    description: '在列表中手动触发工作流。',
    params: [],
  },
  {
    id: 'context-menu',
    category: 'trigger',
    label: '右键菜单',
    description: '通过浏览器右键菜单触发工作流。',
    params: [{ name: 'title', label: '菜单标题', type: 'string' }],
  },
  {
    id: 'on-startup',
    category: 'trigger',
    label: '浏览器启动',
    description: '浏览器启动时运行工作流。',
    params: [],
  },
  {
    id: 'keyboard-shortcut',
    category: 'trigger',
    label: '键盘快捷键',
    description: '按快捷键时运行工作流。',
    params: [{ name: 'shortcut', label: '快捷键', type: 'string', default: 'Ctrl+Shift+Y' }],
  },
  {
    id: 'date',
    category: 'trigger',
    label: '日期触发',
    description: '在指定时刻运行工作流。',
    params: [{ name: 'time', label: '时刻(如 09:00)', type: 'string' }],
  },
  {
    id: 'specific-day',
    category: 'trigger',
    label: '特定星期',
    description: '在指定星期几运行工作流。',
    params: [
      { name: 'days', label: '星期(逗号分隔)', type: 'string', default: '1,2,3,4,5' },
      { name: 'time', label: '时刻(如 09:00)', type: 'string' },
    ],
  },
  {
    id: 'element-change',
    category: 'trigger',
    label: '元素变化',
    description: '页面元素发生变化时运行工作流（需常驻 content script）。',
    params: [{ name: 'cssSelector', label: 'CSS 选择器', type: 'string' }],
  },
]

/** Lookup from block id to its definition; ids are unique by construction. */
export const BLOCK_BY_ID: Map<string, BlockDefinition> = new Map(
  WORKFLOW_BLOCKS.map((block) => [block.id, block]),
)
/**
 * Block display-name localization for the workflow editor.
 *
 * Block identities (ids, data fields, form labels) stay English/Automa-identical
 * for engine compatibility, but the NAME and DESCRIPTION shown on each node and
 * in the palette can follow the UI language. Blocks without an entry keep their
 * English catalog text (the map lookup falls back).
 *
 * @module workflow-editor/block-i18n
 */

/** Chinese (zh-CN) block names, keyed by catalog block id. */
export const BLOCK_NAMES_ZH: Record<string, string> = {
  // Web interaction
  'event-click': '点击元素',
  forms: '填写表单',
  link: '点击链接',
  'get-text': '获取文本',
  'attribute-value': '属性值',
  'hover-element': '悬停元素',
  'press-key': '按键',
  'element-scroll': '滚动元素',
  'trigger-event': '触发事件',
  'element-exists': '元素是否存在',
  'loop-elements': '循环元素',
  'create-element': '创建元素',
  'upload-file': '上传文件',
  'switch-to': '切换框架/窗口',
  // Browser
  'new-tab': '新建标签页',
  'new-window': '新建窗口',
  'switch-tab': '切换标签页',
  'close-tab': '关闭标签页',
  'go-back': '后退',
  'forward-page': '前进',
  'reload-tab': '刷新标签页',
  'tab-url': '标签页网址',
  'active-tab': '当前标签页',
  'take-screenshot': '截图',
  ocr: 'OCR 识别',
  clipboard: '剪贴板',
  cookie: 'Cookie',
  'handle-dialog': '处理对话框',
  'handle-download': '处理下载',
  'save-local': '保存到本地',
  delay: '延时',
  proxy: '代理',
  'wait-connections': '等待连接',
  'save-assets': '保存资源',
  'browser-event': '浏览器事件',
  note: '便签',
  'blocks-group': '分组',
  // General
  trigger: '触发器',
  webhook: 'Webhook',
  notification: '通知',
  'javascript-code': 'JavaScript 代码',
  'parameter-prompt': '参数输入',
  'workflow-state': '工作流状态',
  'execute-workflow': '执行工作流',
  'export-data': '导出数据',
  'ai-agent': 'AI 智能体',
  // Data
  'insert-data': '插入数据',
  'delete-data': '删除数据',
  'increase-variable': '变量自增',
  'slice-variable': '变量切片',
  'regex-variable': '正则变量',
  'sort-data': '排序数据',
  'set-variable': '设置变量',
  'data-mapping': '数据映射',
  'log-data': '日志数据',
  // Conditions / control flow
  conditions: '条件',
  'loop-data': '循环数据',
  'repeat-task': '重复任务',
  'while-loop': 'While 循环',
  'loop-breakpoint': '循环断点',
}

/** Chinese (zh-CN) palette category names, keyed by category id. */
export const CATEGORY_NAMES_ZH: Record<string, string> = {
  general: '通用',
  interaction: '页面交互',
  conditions: '条件控制',
  browser: '浏览器',
  data: '数据',
  trigger: '触发器',
}

/**
 * Chinese (zh-CN) block descriptions, keyed by catalog block id — the one-line
 * text shown as a palette tooltip. Covers every palette id (catalog blocks and
 * the local custom blocks); ids missing here fall back to the English catalog
 * description.
 */
export const BLOCK_DESCRIPTIONS_ZH: Record<string, string> = {
  // Web interaction
  'event-click': '点击页面中的元素',
  forms: '填写或操作输入框、下拉框等表单控件',
  link: '跟随页面中的链接元素',
  'get-text': '读取元素渲染出的文本',
  'attribute-value': '读取或更新元素属性',
  'hover-element': '把指针移动到元素上',
  'press-key': '发送单个按键或组合键',
  'element-scroll': '按指定偏移量滚动元素',
  'trigger-event': '在页面上派发一个事件',
  'element-exists': '根据元素是否存在进行分支',
  'loop-elements': '遍历匹配选择器的页面元素',
  'create-element': '向页面注入新元素',
  'upload-file': '为文件上传控件附加文件',
  'switch-to': '把后续步骤指向主窗口或框架',
  // Browser
  'new-tab': '在全新的浏览器标签页中打开网址',
  'new-window': '在独立浏览器窗口中打开网址',
  'switch-tab': '把匹配的已打开标签页切到前台',
  'close-tab': '关闭当前标签页或浏览器窗口',
  'go-back': '回到浏览历史的上一页',
  'forward-page': '前往浏览历史的下一页',
  'reload-tab': '刷新当前标签页',
  'tab-url': '读取当前或匹配标签页的网址',
  'active-tab': '将当前标签页视为正在操作的标签页',
  'take-screenshot': '截取当前可见页面的图像',
  ocr: '对图片变量、页面元素（img / canvas / 无文本容器）或上一次页面快照运行本地 OCR（Tesseract.js，离线）；识别结果写入输出变量（默认 lastOcrText）',
  clipboard: '读取或写入系统剪贴板',
  cookie: '获取、设置或删除浏览器 Cookie',
  'handle-dialog': '接受或关闭 alert/confirm 等浏览器对话框',
  'handle-download': '管理浏览器下载的文件',
  'save-local': '把值或数据写入本地文件',
  delay: '延时指定时间后再运行下一个算子',
  proxy: '让浏览器网络流量经由代理转发',
  'wait-connections': '等待其他传入流程完成后继续',
  'save-assets': '下载图片、视频、音频等文件',
  'browser-event': '暂停，直到选定的浏览器事件发生',
  note: '在工作流中附加自由备注',
  'blocks-group': '把一组算子打包成组',
  // General
  trigger: '工作流开始运行的入口',
  webhook: '向远程端点发送 HTTP 请求',
  notification: '显示桌面通知',
  'javascript-code': '在页面上下文中执行自定义 JavaScript',
  'parameter-prompt': '在继续执行前询问参数值',
  'workflow-state': '停止或改变工作流执行状态',
  'execute-workflow': '运行另一个工作流并把数据传给它',
  'export-data': '把收集到的数据写入文件',
  'ai-agent': '读取目标元素并交给 AI 智能体分析页面，并（可选）代替你执行操作',
  // Data
  'insert-data': '向数据表或变量追加记录',
  'delete-data': '从数据表或变量中移除记录',
  'increase-variable': '把数值变量增加指定步长',
  'slice-variable': '截取字符串或数组变量的片段',
  'regex-variable': '用正则表达式匹配或变换变量值',
  'sort-data': '对数据集合排序',
  'set-variable': '把值存入工作流变量，供后续算子读取（支持 {{variables}}）',
  'data-mapping': '重排数据表或变量的字段',
  'log-data': '读取工作流最近的日志数据',
  // Conditions / control flow
  conditions: '根据条件测试结果分支执行',
  'loop-data': '遍历数据表行或变量值',
  'repeat-task': '按设定次数运行所连接的分支',
  'while-loop': '在条件成立期间持续运行分支',
  'loop-breakpoint': '在此处停止外层循环',
  // Cloud (Automa service) blocks
  'ai-workflow': '运行由 AI 助手生成的工作流',
  'google-sheets': '读写 Google 表格',
  'google-sheets-drive': '操作存储在 Google Drive 中的表格',
  'google-drive': '上传文件到 Google Drive',
  'block-package': '运行已安装扩展包提供的算子',
}

/** Resolve a block's display name for the current editor locale. */
export function blockDisplayName(
  blockId: string | undefined,
  englishName: string,
  locale: 'en' | 'zh',
): string {
  if (locale !== 'zh' || !blockId) return englishName
  return BLOCK_NAMES_ZH[blockId] ?? englishName
}

/** Resolve a palette category name for the current editor locale. */
export function categoryDisplayName(
  categoryId: string | undefined,
  englishName: string,
  locale: 'en' | 'zh',
): string {
  if (locale !== 'zh' || !categoryId) return englishName
  return CATEGORY_NAMES_ZH[categoryId] ?? englishName
}

/** Resolve a block's catalog description for the current editor locale. */
export function blockDescription(
  blockId: string | undefined,
  englishDescription: string,
  locale: 'en' | 'zh',
): string {
  if (locale !== 'zh' || !blockId || !englishDescription) return englishDescription
  return BLOCK_DESCRIPTIONS_ZH[blockId] ?? englishDescription
}

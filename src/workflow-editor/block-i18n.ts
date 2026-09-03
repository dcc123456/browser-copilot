/**
 * Block display-name localization for the workflow editor.
 *
 * Block identities (ids, data fields, form labels) stay English/Automa-identical
 * for engine compatibility, but the NAME shown on each node and in the palette
 * can follow the UI language. Blocks without an entry keep their English name
 * (the map lookup falls back to the catalog name).
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

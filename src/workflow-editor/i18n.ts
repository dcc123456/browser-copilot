/**
 * Workflow-editor UI translations.
 *
 * Block NAMES and form labels stay in English by requirement (Automa-identical
 * operators); only the editor chrome — toolbar, tabs, palette headings, logs,
 * toasts and empty states — is localized. Language follows the extension's
 * locale setting (lib/i18n), falling back to the browser language.
 *
 * @module workflow-editor/i18n
 */

export type EditorLocale = 'en' | 'zh'

export const EDITOR_STRINGS = {
  en: {
    editor: 'Editor',
    logs: 'Logs',
    untitled: 'Untitled workflow',
    save: 'Save',
    run: 'Run',
    running: 'Running',
    record: 'Record workflow',
    stopRecord: 'Stop recording',
    addBlocks: 'Add blocks',
    toggleSidebar: 'Toggle sidebar',
    togglePalette: 'Toggle blocks',
    autoLayout: 'Auto-layout (beautify)',
    autoLayoutDone: 'Layout tidy applied',
    searchNodes: 'Search nodes',
    searchPlaceholder: 'Search nodes',
    noMatches: 'No matches',
    blocks: 'Blocks',
    details: 'Workflow',
    logsTitle: 'Run logs',
    logsEmpty: 'No runs yet. Press run (Ctrl+Enter) and logs will appear here.',
    saved: 'Workflow saved',
    saveFailed: 'Save failed',
    runFailed: 'Run failed',
    runFinished: 'Run finished',
    recordingStarted: 'Recording started — switch to a page and perform actions',
    recordingStopped: 'Recording stopped',
    recordStartFailed: 'Could not start recording',
    back: 'Back',
    languageLabel: 'Language',
    description: 'Description',
    descriptionPlaceholder: 'What does this workflow do?',
    trigger: 'Trigger',
    triggerType: 'Trigger type',
    triggerEnabled: 'Trigger enabled',
    settings: 'Settings',
    debugMode: 'Debug mode',
    saveLog: 'Save execution logs',
    notifyOnFinish: 'Notify when finished',
    manual: 'Manual',
    scheduled: 'Interval / Cron',
    contextMenu: 'Context menu',
    visitWeb: 'Visit web',
    cronHint: '0 8 * * * (daily at 8:00)',
    urlHint: 'https://example.com/*',
    menuTitle: 'Menu title',
  },
  zh: {
    editor: '编辑',
    logs: '日志',
    untitled: '未命名工作流',
    save: '保存',
    run: '运行',
    running: '运行中',
    record: '录制工作流',
    stopRecord: '停止录制',
    addBlocks: '添加算子',
    toggleSidebar: '切换侧边栏',
    togglePalette: '切换算子面板',
    autoLayout: '一键美化排版',
    autoLayoutDone: '已自动排版',
    searchNodes: '搜索节点',
    searchPlaceholder: '搜索节点',
    noMatches: '无匹配',
    blocks: '算子',
    details: '工作流',
    logsTitle: '运行日志',
    logsEmpty: '还没有运行记录。点击运行（Ctrl+Enter）后日志会显示在这里。',
    saved: '工作流已保存',
    saveFailed: '保存失败',
    runFailed: '运行失败',
    runFinished: '运行完成',
    recordingStarted: '已开始录制 — 请切换到页面执行操作',
    recordingStopped: '录制已停止',
    recordStartFailed: '无法开始录制',
    back: '返回',
    languageLabel: '语言',
    description: '描述',
    descriptionPlaceholder: '这个工作流做什么？',
    trigger: '触发器',
    triggerType: '触发方式',
    triggerEnabled: '启用触发器',
    settings: '设置',
    debugMode: '调试模式',
    saveLog: '保存执行日志',
    notifyOnFinish: '完成时通知',
    manual: '手动',
    scheduled: '定时 / Cron',
    contextMenu: '右键菜单',
    visitWeb: '访问网页',
    cronHint: '0 8 * * *（每天 8:00）',
    urlHint: 'https://example.com/*',
    menuTitle: '菜单名称',
  },
} as const satisfies Record<EditorLocale, Record<string, string>>

export type EditorStringKey = keyof (typeof EDITOR_STRINGS)['en']

export type TranslateFn = (key: EditorStringKey) => string

/** Resolve an editor locale from the stored locale preference. */
export function resolveEditorLocale(stored: string | undefined): EditorLocale {
  if (stored === 'en') return 'en'
  if (stored === 'zh-CN') return 'zh'
  // auto: follow browser language.
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

export function makeTranslate(locale: EditorLocale): TranslateFn {
  const dict = EDITOR_STRINGS[locale]
  return (key) => dict[key] ?? EDITOR_STRINGS.en[key] ?? key
}

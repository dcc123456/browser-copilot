/**
 * Bilingual semantic-intent lexicon and detector.
 *
 * Intent detection must not hinge on a handful of Chinese keywords. This module
 * is the single source of truth for semantic signals: Chinese AND English,
 * word AND phrase AND semantic-pattern forms, grouped by intent. The detector
 * tokenises on word boundaries (so Chinese phrases without spaces still match)
 * and returns every detected intent with the signals that fired — evidence for
 * the caller, never a blind keyword ⇒ winner mapping.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/semantic-intent
 */

/** The control-flow / capability intents the detector recognises. */
export type SemanticIntentName =
  | 'for-each'
  | 'all'
  | 'while-until'
  | 'if-else'
  | 'repeat-retry'
  | 'pagination'
  | 'interaction-click'
  | 'interaction-fill'
  | 'reading'
  | 'data-transform'
  | 'storage-output'
  | 'verification'
  | 'semantic-generation'

/** One detected intent with its evidence. */
export interface DetectedIntent {
  intent: SemanticIntentName
  /** Signal phrases that fired. */
  signals: string[]
  /** Deterministic confidence 0..1 from how strongly signals matched. */
  score: number
}

/** A signal group: phrases are matched literally (case-insensitive). */
interface SignalGroup {
  intent: SemanticIntentName
  phrases: readonly string[]
  /** Relative weight of this group when computing a score. */
  weight: number
}

// --- Control-flow signals --------------------------------------------------------

const FOR_EACH: SignalGroup = {
  intent: 'for-each',
  weight: 1,
  phrases: [
    // Chinese
    '遍历', '逐个', '逐一', '每一条', '每一个', '每一项', '所有', '各个', '分别',
    '每一行', '逐个处理', '逐项', '依次', '挨个', '批量', '针对所有', '每',
    // English
    'for each', 'foreach', 'every ', 'each ', 'iterate over', 'iterate through',
    'loop through', 'all of the', 'process every', 'one by one', 'item by item',
    'iterate ', 'loop over', 'traverse', 'process each', 'all ', 'all items',
  ],
}

const ALL: SignalGroup = {
  intent: 'all',
  weight: 0.7,
  phrases: [
    '全部', '所有', '全量', '整个', '统统', '所有结果', '每一条',
    'all ', 'entire ', 'whole ', 'every ', 'full set', 'in full',
  ],
}

const WHILE_UNTIL: SignalGroup = {
  intent: 'while-until',
  weight: 1,
  phrases: [
    '直到', '直到没有', '直到出现', '一直', '持续到', '等到', '循环直到',
    '直至', '直到完成', '只要',
    'until', 'while', 'as long as', 'keep doing', 'keep going until',
    'repeat until', 'stop when', 'continue until', 'until no more',
    'until it appears', 'until it succeeds',
  ],
}

const IF_ELSE: SignalGroup = {
  intent: 'if-else',
  weight: 1,
  phrases: [
    '如果', '假如', '若', '一旦', '万一', '否则', '不然', '条件是', '当', '除非',
    '当……时', '提交时',
    'if', 'when', 'whenever', 'provided that', 'in case', 'then', 'otherwise',
    'else', 'unless', 'condition is met', 'condition fails',
  ],
}

const RETRY: SignalGroup = {
  intent: 'repeat-retry',
  weight: 1,
  phrases: [
    '重复', '重试', '再试', '重新运行', '再来一次', '最多重试', '再次',
    '继续尝试', '反复', '最多尝试',
    'repeat', 'again', 'retry', 're-run', 'run again', 'try again',
    'repeat n times', 'up to n attempts', 'retry on failure', 'keep retrying',
    'repeatedly', 'up to ', 'retry the call',
  ],
}

const PAGINATION: SignalGroup = {
  intent: 'pagination',
  weight: 1,
  phrases: [
    '下一页', '翻页', '分页', '加载更多', '逐页', '页面导航', '翻到下一页',
    'next page', 'paginate', 'pagination', 'page through', 'all pages',
    'load more', 'until no more results', 'continue to the next page',
    'load more items', 'until no more',
  ],
}

// --- Capability signals ----------------------------------------------------------

const CLICK: SignalGroup = {
  intent: 'interaction-click',
  weight: 1,
  phrases: [
    '点击', '单击', '点一下', '点按', '按下', '勾选', '取消勾选', '悬停', '展开', '收起',
    'click', 'tap', 'press', 'check', 'uncheck', 'hover', 'submit', 'expand', 'collapse',
  ],
}

const FILL: SignalGroup = {
  intent: 'interaction-fill',
  weight: 1,
  phrases: [
    '填写', '输入', '键入', '填入', '选择', '上传',
    'type', 'enter', 'fill', 'input', 'select', 'choose', 'upload',
  ],
}

const READING: SignalGroup = {
  intent: 'reading',
  weight: 1,
  phrases: [
    '读取', '获取', '查看', '提取', '抓取', '采集', '读文本', '读属性', '获取链接', '获取url',
    'read', 'get', 'extract', 'scrape', 'collect', 'inspect', 'retrieve',
    'fetch text', 'read attribute', 'get url', 'capture data',
  ],
}

const DATA_TRANSFORM: SignalGroup = {
  intent: 'data-transform',
  weight: 1,
  phrases: [
    '过滤', '筛选', '排序', '映射', '转换', '替换', '正则', '截取', '切片', '去重',
    '统计', '聚合', '拆分', '合并', '提取',
    'filter', 'map', 'transform', 'convert', 'replace', 'regex', 'slice',
    'split', 'join', 'deduplicate', 'sort', 'aggregate', 'count', 'normalize',
    'extract', 'merge',
  ],
}

const STORAGE: SignalGroup = {
  intent: 'storage-output',
  weight: 1,
  phrases: [
    '保存', '存储', '下载', '导出', '写入文件', '存到本地', '通知',
    'save', 'store', 'download', 'export', 'write to file', 'save locally',
    'notify', 'notification',
  ],
}

const VERIFICATION: SignalGroup = {
  intent: 'verification',
  weight: 1,
  phrases: [
    '验证', '确认', '检查', '判断', '确保', '校验', '证明', '是否',
    'verify', 'confirm', 'check', 'assert', 'ensure', 'validate', 'make sure',
    'determine whether',
  ],
}

const SEMANTIC_GENERATION: SignalGroup = {
  intent: 'semantic-generation',
  weight: 1,
  phrases: [
    '生成', '撰写', '拟定', '起草', '总结', '改写', '回复', '拟', '帮我写', '编一段',
    '润色', '个性化', '根据上下文',
    'generate', 'write', 'draft', 'compose', 'summarize', 'summarise', 'rewrite',
    'reply', 'come up with', 'personalized', 'personalised', 'rephrase', 'polish',
  ],
}

const GROUPS: readonly SignalGroup[] = [
  FOR_EACH, ALL, WHILE_UNTIL, IF_ELSE, RETRY, PAGINATION,
  CLICK, FILL, READING, DATA_TRANSFORM, STORAGE, VERIFICATION, SEMANTIC_GENERATION,
]

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/\s+/g, ' ')} `
}

/**
 * Detect every semantic intent present in the text.
 *
 * `pageSignals` (optional, see §15) let callers fold page-structure evidence
 * in — e.g. a list/grid raises the score of `for-each` even without an
 * explicit "for each" phrase.
 */
export function detectSemanticIntents(
  text: string,
  pageSignals?: PageStructureSignals,
): DetectedIntent[] {
  const haystack = normalise(text)
  const results: DetectedIntent[] = []
  for (const group of GROUPS) {
    const fired: string[] = []
    for (const phrase of group.phrases) {
      const needle = phrase.toLowerCase()
      // Chinese phrases are matched without boundary padding; English words
      // use the padded haystack so "all" does not fire inside "mall".
      const isCjk = /[\u4e00-\u9fff]/.test(needle)
      const matched = isCjk ? text.toLowerCase().includes(needle) : haystack.includes(` ${needle}`)
      if (matched && !fired.includes(phrase)) fired.push(phrase)
    }
    if (fired.length === 0 && !pageBoost(group.intent, pageSignals)) continue
    // Diminishing returns for additional fired signals; capped at 1.
    const signalScore = Math.min(1, 0.45 + fired.length * 0.22)
    const boost = pageBoost(group.intent, pageSignals)
    const score = Math.min(1, (signalScore + boost) * group.weight)
    results.push({ intent: group.intent, signals: fired, score: Number(score.toFixed(3)) })
  }
  return results.sort((a, b) => b.score - a.score)
}

/** Page-structure evidence (spec §15) that can corroborate an intent. */
export interface PageStructureSignals {
  /** Repeated list/grid rows observed on the page. */
  repeatedRows?: number
  /** Pagination controls ("next page", page numbers) observed. */
  hasPaginationControl?: boolean
  /** A form is present on the page. */
  hasForm?: boolean
}

function pageBoost(intent: SemanticIntentName, signals?: PageStructureSignals): number {
  if (!signals) return 0
  if (intent === 'for-each' && signals.repeatedRows && signals.repeatedRows >= 2) return 0.3
  if (intent === 'pagination' && signals.hasPaginationControl) return 0.35
  if (intent === 'interaction-fill' && signals.hasForm) return 0.2
  return 0
}

/** Convenience: highest-scoring detected intent, if any. */
export function topSemanticIntent(text: string, pageSignals?: PageStructureSignals): DetectedIntent | undefined {
  return detectSemanticIntents(text, pageSignals)[0]
}

/** Whether a specific intent is present above an optional threshold. */
export function hasIntent(
  text: string,
  intent: SemanticIntentName,
  threshold = 0.4,
): boolean {
  return detectSemanticIntents(text).some((d) => d.intent === intent && d.score >= threshold)
}

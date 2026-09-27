import { describe, expect, it } from 'vitest'
import { detectSemanticIntents } from '../src/lib/workflow/semantic-intent'
function kinds(text: string): string[] {
  return detectSemanticIntents(text).map((d) => d.intent)
}
const zhControl = [
  '每个商品', '每一项', '每一条', '每一行', '逐个处理', '逐项检查', '依次执行', '挨个查看', '遍历列表',
  '批量处理', '针对所有行', '所有订单', '直到完成', '直至成功', '持续到加载完成', '只要存在',
  '当提交时', '如果失败', '若报错', '除非成功', '否则停止', '不然重试', '重复执行', '再次检查',
  '反复点击', '重试接口', '继续尝试', '最多尝试 3 次', '翻页处理', '点击下一页', '加载更多', '直到没有更多',
]
const enControl = [
  'each item', 'every product', 'for each row', 'for every order', 'all items', 'process all',
  'one by one', 'item by item', 'iterate the list', 'loop over the rows', 'traverse the tree',
  'process each card', 'until done', 'while loading', 'as long as needed', 'when clicked',
  'whenever it fails', 'if missing', 'unless complete', 'otherwise stop', 'else continue',
  'repeat the step', 'run again', 'repeatedly check', 'retry the call', 'try again',
  'up to 3 attempts', 'paginate the results', 'go to the next page', 'load more items', 'until no more results',
]
describe('V33 Chinese control-flow semantic coverage', () => {
  it.each(zhControl)('detects a control flow intent for: %s', (text) => {
    const detected = kinds(text)
    expect(detected.some((d) => ['for-each','while-until','if-else','repeat-retry','pagination'].includes(d))).toBe(true)
  })
})
describe('V34 English control-flow semantic coverage', () => {
  it.each(enControl)('detects a control flow intent for: %s', (text) => {
    const detected = kinds(text)
    expect(detected.some((d) => ['for-each','while-until','if-else','repeat-retry','pagination'].includes(d))).toBe(true)
  })
})
describe('V35 synonymous phrasings converge', () => {
  const variants = [
    '遍历所有商品', '逐个处理商品', '挨个查看每一项商品', '对所有商品依次执行', '每一个商品都处理一遍',
  ]
  it('all variants detect for-each', () => {
    for (const text of variants) expect(kinds(text)).toContain('for-each')
  })
})
const zhData = ['提取标题', '筛选结果', '过滤无效项', '排序价格', '映射字段', '转换格式', '截取前10条', '去重', '合并数据', '拆分数值']
const enData = ['extract titles', 'filter rows', 'sort prices', 'map fields', 'transform format', 'slice the list', 'deduplicate items', 'merge data', 'split the value']
describe('V36 data-processing semantics', () => {
  it.each([...zhData, ...enData])('detects a data-transform intent for: %s', (text) => {
    expect(kinds(text)).toContain('data-transform')
  })
})
const zhVerify = ['确认提交成功', '验证元素', '检查状态', '判断是否成功', '确认是否存在']
const enVerify = ['verify the result', 'validate the form', 'check the status', 'confirm submission', 'make sure it saved', 'ensure it works']
describe('V37 verification semantics', () => {
  it.each([...zhVerify, ...enVerify])('detects a verification intent for: %s', (text) => {
    expect(kinds(text)).toContain('verification')
  })
})
describe('V39 page-structure corroboration', () => {
  it('detects for-each/pagination from structure even without keywords', () => {
    const detected = detectSemanticIntents('collect the items', { repeatedRows: 20, hasPaginationControl: true })
    const map = new Set(detected.map((d) => d.intent))
    expect(map.has('for-each') && map.has('pagination')).toBe(true)
  })
})
describe('V40 explicit loop with no repeated structure', () => {
  it('does not boost for-each without corroborating structure', () => {
    const detected = detectSemanticIntents('open the dialog', { repeatedRows: 0 })
    const forEach = detected.find((d) => d.intent === 'for-each')
    expect(forEach?.score ?? 0).toBeLessThan(0.4)
  })
})
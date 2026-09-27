/**
 * Workflow Generation Goal Contract — the top-level contract established
 * BEFORE any operator executes.
 *
 * One `prepare_workflow_goal` call produces this contract: the workflow name,
 * the machine-checkable goal spec, the required capabilities, constraints and
 * expected inputs. It is the contract the dispatcher gates on (no contract ⇒
 * no `wf_op_*` execution), and what final L3 verification certifies against.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/generation-goal
 */

import type { WorkflowCondition } from './conditions'
import { workflowConditionsOf } from './conditions'
import type { WorkflowGoalSpec } from './reliability'
import { normalizeGoalSpec } from './goal'

/** A named workflow input the contract expects the trigger to declare. */
export interface ExpectedWorkflowInput {
  name: string
  type?: 'string' | 'number' | 'boolean' | 'json'
  description?: string
  defaultValue?: string
  secret?: boolean
}

/** The full contract `prepare_workflow_goal` establishes. */
export interface WorkflowGenerationGoalContract {
  version: 1
  /** Human-readable workflow name, never `workflow-xxxx` or `new workflow`. */
  name: string
  /** The goal spec final L3 verification certifies against. */
  goalSpec: WorkflowGoalSpec
  /** Capabilities the task requires (semantic capability ids). */
  requiredCapabilities: string[]
  /** Hard constraints the workflow must respect. */
  constraints?: string[]
  /** Inputs the workflow needs but cannot produce itself. */
  expectedInputs?: ExpectedWorkflowInput[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && !!item.trim())
}

function expectedInputsOf(value: unknown): ExpectedWorkflowInput[] {
  if (!Array.isArray(value)) return []
  const out: ExpectedWorkflowInput[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item['name'] !== 'string' || !item['name'].trim()) continue
    const type = item['type']
    const input: ExpectedWorkflowInput = {
      name: item['name'],
      ...(type === 'string' || type === 'number' || type === 'boolean' || type === 'json'
        ? { type }
        : {}),
      ...(typeof item['description'] === 'string' ? { description: item['description'] } : {}),
      ...(typeof item['defaultValue'] === 'string' ? { defaultValue: item['defaultValue'] } : {}),
      ...(item['secret'] === true ? { secret: true } : {}),
    }
    out.push(input)
  }
  return out
}

/** Normalise an untrusted generation-goal-contract shape. */
export function normalizeGenerationGoalContract(
  value: unknown,
): WorkflowGenerationGoalContract | undefined {
  if (!isRecord(value)) return undefined
  if (value['version'] !== 1 && value['version'] !== undefined) return undefined
  if (typeof value['name'] !== 'string' || !value['name'].trim()) return undefined
  const goalSpec = normalizeGoalSpec(value['goalSpec'])
  if (!goalSpec) return undefined
  const requiredCapabilities = stringList(value['requiredCapabilities'])
  const constraints = stringList(value['constraints'])
  const expectedInputs = expectedInputsOf(value['expectedInputs'])
  return {
    version: 1,
    name: value['name'],
    goalSpec,
    requiredCapabilities,
    ...(constraints.length ? { constraints } : {}),
    ...(expectedInputs.length ? { expectedInputs } : {}),
  }
}

// --- Workflow name generation ---------------------------------------------------

/**
 * Bilingual (zh/en) keyword → short name fragments. The first matching fragment
 * wins; ordering matters (more specific verbs first).
 */
const NAME_RULES: ReadonlyArray<{ test: RegExp; en: string; zh: string }> = [
  { test: /(创建|新建|新增|create|new|add)/i, en: 'Create', zh: '创建' },
  { test: /(发送|邮件|send|email|mail|message)/i, en: 'Send', zh: '发送' },
  { test: /(提交|submit|apply)/i, en: 'Submit', zh: '提交' },
  { test: /(抓取|采集|爬取|提取|scrape|extract|collect|crawl)/i, en: 'Scrape', zh: '采集' },
  { test: /(下载|download|export|导出)/i, en: 'Download', zh: '下载' },
  { test: /(填写|填|fill)/i, en: 'Fill', zh: '填写' },
  { test: /(搜索|查询|查找|search|query|find|lookup)/i, en: 'Search', zh: '搜索' },
  { test: /(删除|delete|remove)/i, en: 'Delete', zh: '删除' },
  { test: /(更新|修改|编辑|update|edit|modify)/i, en: 'Update', zh: '更新' },
  { test: /(登录|登陆|登入|logs?in|signs?in)/i, en: 'Login', zh: '登录' },
  { test: /(注册|register|signs?up)/i, en: 'Register', zh: '注册' },
  { test: /(预约|book|reserve|schedule|appointment)/i, en: 'Book', zh: '预约' },
  { test: /(报表|报告|汇总|统计|report|summary|aggregate)/i, en: 'Report', zh: '汇总' },
]

const OBJECT_RULES: ReadonlyArray<{ test: RegExp; en: string; zh: string }> = [
  { test: /(客户|customer|client)/i, en: 'Customer', zh: '客户' },
  { test: /(商品|产品|product|item)/i, en: 'Product', zh: '商品' },
  { test: /(订单|order)/i, en: 'Order', zh: '订单' },
  { test: /(邮件|email|mail)/i, en: 'Email', zh: '邮件' },
  { test: /(申请|application|request form)/i, en: 'Application', zh: '申请' },
  { test: /(数据|data)/i, en: 'Data', zh: '数据' },
  { test: /(帖子|post)/i, en: 'Post', zh: '帖子' },
  { test: /(评论|comment|review)/i, en: 'Comment', zh: '评论' },
  { test: /(表格|sheet|spreadsheet)/i, en: 'Sheet', zh: '表格' },
  { test: /(发票|invoice)/i, en: 'Invoice', zh: '发票' },
]

/** Names that must never be accepted. */
const FORBIDDEN_NAMES = /^(workflow-[a-z0-9]+|new workflow|test|untitled|未命名工作流)$/i

/** Whether a candidate name is acceptable (meaningful, not a placeholder). */
export function isAcceptableWorkflowName(name: string): boolean {
  const trimmed = name.trim()
  return !!trimmed && !FORBIDDEN_NAMES.test(trimmed) && !/^[a-z0-9]{8,}$/i.test(trimmed)
}

/**
 * Deterministically derive a stable, meaningful workflow name from the user
 * request / goal summary. Same request ⇒ same name; no random ids.
 */
export function generateWorkflowName(requestText: string): string {
  const text = requestText.trim()
  const verb = NAME_RULES.find((rule) => rule.test.test(text))
  const object = OBJECT_RULES.find((rule) => rule.test.test(text))
  // Chinese request → Chinese name, otherwise English.
  const isChinese = /[\u4e00-\u9fff]/.test(text)
  if (isChinese) {
    if (verb && object) return `${verb.zh}${object.zh}`
    if (verb) return `${verb.zh}工作流`
    if (object) return `处理${object.zh}`
    return fallbackZh(text)
  }
  if (verb && object) return `${verb.en} ${object.en}`
  if (verb) return `${verb.en} Workflow`
  if (object) return `Process ${object.en}`
  return fallbackEn(text)
}

function fallbackZh(text: string): string {
  // Use the first short Chinese clause, capped, so the name stays meaningful.
  const clause = text.split(/[，。,.\n]/)[0]?.trim() ?? ''
  return clause.length > 16 ? `${clause.slice(0, 16)}…` : clause || '工作流'
}

function fallbackEn(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4)
  const joined = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word.toLowerCase(),
    )
    .join(' ')
  return joined || 'Workflow'
}

/** Validate that a success-criteria list is usable for a contract. */
export function validateSuccessCriteria(value: unknown): WorkflowCondition[] {
  return workflowConditionsOf(value)
}

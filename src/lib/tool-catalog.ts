import type { Messages } from './i18n'

/**
 * Human-readable metadata for each agent tool, shared by the tool definitions
 * in `background/agent.ts` and the Settings UI that lets users disable tools.
 *
 * Keeping it here (rather than in the agent module) means the side panel can
 * import labels/warnings without pulling in the whole background/Chrome stack.
 *
 * @module lib/tool-catalog
 */

export type ToolCategory = 'read' | 'act' | 'nav' | 'data'

type MessageKey = {
  [K in keyof Messages]: Messages[K] extends string ? K : never
}[keyof Messages]

export interface ToolMeta {
  name: string
  category: ToolCategory
  /** i18n key for a short label shown in the settings list. */
  labelKey: MessageKey
  /** i18n key for what breaks if this tool is disabled. */
  warningKey: MessageKey
}

/**
 * Every tool the agent can call. Order here drives the settings list order.
 * Disabling a tool removes its schema from the request and the agent simply
 * never sees it; warnings below describe the user-visible consequence.
 */
export const TOOL_META: ToolMeta[] = [
  {
    name: 'read_current_page',
    category: 'read',
    labelKey: 'toolReadPage',
    warningKey: 'toolReadPageWarn',
  },
  {
    name: 'snapshot_page',
    category: 'read',
    labelKey: 'toolSnapshot',
    warningKey: 'toolSnapshotWarn',
  },
  {
    name: 'list_tabs',
    category: 'nav',
    labelKey: 'toolListTabs',
    warningKey: 'toolListTabsWarn',
  },
  { name: 'click', category: 'act', labelKey: 'toolClick', warningKey: 'toolClickWarn' },
  { name: 'fill', category: 'act', labelKey: 'toolFill', warningKey: 'toolFillWarn' },
  {
    name: 'select_option',
    category: 'act',
    labelKey: 'toolSelect',
    warningKey: 'toolSelectWarn',
  },
  {
    name: 'set_checkbox',
    category: 'act',
    labelKey: 'toolCheckbox',
    warningKey: 'toolCheckboxWarn',
  },
  { name: 'press_key', category: 'act', labelKey: 'toolPressKey', warningKey: 'toolPressKeyWarn' },
  { name: 'scroll', category: 'act', labelKey: 'toolScroll', warningKey: 'toolScrollWarn' },
  { name: 'wait_for', category: 'act', labelKey: 'toolWait', warningKey: 'toolWaitWarn' },
  { name: 'open_url', category: 'nav', labelKey: 'toolOpenUrl', warningKey: 'toolOpenUrlWarn' },
  { name: 'tab_new', category: 'nav', labelKey: 'toolTabNew', warningKey: 'toolTabNewWarn' },
  {
    name: 'tab_switch',
    category: 'nav',
    labelKey: 'toolTabSwitch',
    warningKey: 'toolTabSwitchWarn',
  },
  {
    name: 'tab_close',
    category: 'nav',
    labelKey: 'toolTabClose',
    warningKey: 'toolTabCloseWarn',
  },
  {
    name: 'run_javascript',
    category: 'act',
    labelKey: 'toolRunJs',
    warningKey: 'toolRunJsWarn',
  },
  {
    name: 'get_my_profile',
    category: 'data',
    labelKey: 'toolProfile',
    warningKey: 'toolProfileWarn',
  },
  {
    name: 'list_secrets',
    category: 'data',
    labelKey: 'toolListSecrets',
    warningKey: 'toolListSecretsWarn',
  },
  { name: 'get_secret', category: 'data', labelKey: 'toolSecret', warningKey: 'toolSecretWarn' },
  { name: 'use_skill', category: 'data', labelKey: 'toolSkill', warningKey: 'toolSkillWarn' },
  {
    name: 'list_scheduled_tasks',
    category: 'data',
    labelKey: 'toolListTasks',
    warningKey: 'toolListTasksWarn',
  },
]

export const TOOL_META_BY_NAME = new Map(TOOL_META.map((meta) => [meta.name, meta]))

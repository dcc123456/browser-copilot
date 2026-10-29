import {
  OPERATOR_NAMES,
  WORKFLOW_AUTHOR_OPERATOR_NAMES,
  WORKFLOW_CATEGORY_TOOL_GROUPS,
  WORKFLOW_ESCAPE_OPERATOR_NAMES,
} from './workflow/operator-tools'

/**
 * On-demand tool groups, loaded conversation-wide by the `load_tools` tool.
 * Group names appear in the load_tools schema and in system-prompt rule 14.
 * Every tool NOT listed here (plus `load_tools` itself) is core and always
 * advertised in non-chat modes.
 *
 * Lives in `lib` (chrome-free) so the Settings list can group the tools by the
 * same buckets the agent loads them in — one definition, not a UI copy that
 * drifts.
 */
export const TOOL_GROUPS: Record<string, readonly string[]> = {
  tabs: ['list_tabs', 'tab_new', 'tab_switch', 'tab_close', 'pin_tab', 'unpin_tab'],
  data: ['save_local', 'get_my_profile', 'list_secrets', 'get_secret'],
  skills: ['use_skill', 'create_skill'],
  ops: [
    'list_network_requests',
    'list_console_messages',
    'list_scheduled_tasks',
    'create_scheduled_task',
  ],
  // Page work beyond the universal browse loop (read → snapshot → click/fill →
  // navigate), split by capability so a conversation only pays for what it
  // touches. Each group self-heals on a stray call (see the auto-load branch in
  // runOneToolCall), and `run_plan` executes hidden tools directly, so moving a
  // tool here costs at most one load round per conversation, never a failure.
  forms: ['select_option', 'set_checkbox'],
  flow: ['scroll', 'wait_for'],
  keys: ['press_key'],
  vision: ['screenshot', 'recognize_image'],
  script: ['run_javascript'],
  // Multi-agent delegation. On demand like the others so it stays out of the
  // first-round payload; never loaded for a sub-agent (recursion guard).
  delegate: ['delegate_to_agent'],
  // Workflow generation. Legacy "everything at once" group, kept so a
  // conversation that already loaded `operators` keeps working. It is a
  // superset of `operators_author` + `operators_escape`, so `advertiseTools`
  // treats it as "both on-demand tiers loaded".
  operators: ['compose_workflow', ...OPERATOR_NAMES],
  // The whole categorized operator set in one group: the "give me everything"
  // escape hatch. It is the union of the per-category groups below, so the two
  // tiers overlap on purpose and `TOOL_GROUP_BY_NAME` is built explicitly (see
  // there) rather than by walking this object.
  operators_author: [...WORKFLOW_AUTHOR_OPERATOR_NAMES],
  // The escape hatch, on its own group so it can never arrive as a side effect
  // of loading the authoring tail. `wf_op_javascript-code` lives here and
  // nowhere else: a generated workflow must stay maintainable by someone who
  // does not read code, so the block is reachable only after a deliberate load
  // and only with a justification (see `operator-tool-run`).
  operators_escape: [...WORKFLOW_ESCAPE_OPERATOR_NAMES],
  // One group per advertisable catalog category (`op_interaction`,
  // `op_browser`, …). This is the workflow-mode dispatch mechanism: the model
  // declares the categories it needs through `use_operators` and only those
  // schemas are advertised, which is what keeps the per-round payload from
  // carrying all 54 operator schemas.
  ...WORKFLOW_CATEGORY_TOOL_GROUPS,
}

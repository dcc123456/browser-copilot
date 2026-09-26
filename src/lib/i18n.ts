/**
 * UI translations.
 *
 * ## Why not `chrome.i18n` / `_locales`
 *
 * The native extension i18n system resolves messages from the *browser's* UI
 * language and offers no runtime override: `chrome.i18n.getMessage` cannot be
 * asked for a different locale. Users routinely run an English-language Chrome
 * while wanting a Chinese panel (or the reverse), so language has to be a
 * setting, which means owning the dictionary here.
 *
 * It also keeps translation inside the type system: `Messages` is a closed shape,
 * so a key added to one locale and forgotten in another fails `tsc` instead of
 * rendering a blank label.
 *
 * `manifest.json` strings (the extension name and tooltip) still come from
 * Chrome and are intentionally left untranslated, since they are read before any
 * setting is available.
 *
 * @module lib/i18n
 */

/** Languages with a full dictionary. */
export const LOCALES = ['en', 'zh-CN'] as const

export type Locale = (typeof LOCALES)[number]

/** The stored preference; `'auto'` follows the browser. */
export type LocaleSetting = Locale | 'auto'

/** Native names, so each option is legible to the person who needs it. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

/**
 * The full message set.
 *
 * Values may be plain strings or functions taking named parameters. Functions are
 * used wherever a sentence interpolates a value, because word order differs
 * between languages and string concatenation at the call site would hard-code
 * English grammar.
 */
export interface Messages {
  // Tabs
  tabChat: string
  tabSkills: string
  tabAgents: string
  tabTasks: string
  tabWorkflows: string
  tabData: string
  tabSettings: string
  tabHistory: string
  tabMore: string

  // Panel minimize (floating page button)
  panelMinimize: string

  // Workflow upload-file block (user-select mode runtime prompt)
  uploadFileWaiting: string
  uploadFileChoose: string
  uploadFileReading: string

  // Multi-window picker (unattended window policy = ask)
  windowPickTitle: string
  windowPickHint: string
  windowPickBadgeThisPanel: string
  windowPickBadgeMinimized: string

  // Settings: unattended window policy
  settingsWindowPolicyLabel: string
  settingsWindowPolicyLatest: string
  settingsWindowPolicyAsk: string
  settingsWindowPolicyFixed: string
  settingsWindowPolicyHelp: string
  settingsWindowPolicyFixedWindow: string

  // History tab
  histConversations: string
  histTasks: string
  histWorkflows: string
  histOperations: string
  histEmpty: string
  histBatchDelete: string
  histDeleteSelected: string
  histSelectAll: string
  histDeleteConfirm: (params: { count: number }) => string
  histWorkflowRuns: string
  histTaskRuns: string
  histDetailTitle: string
  histEmptyRuns: string
  histOutcomeOk: string
  histOutcomeFailed: string
  histOutcomeCancelled: string
  histOutcomeSkipped: string
  /** Read-only JSON block label for a history entry's arguments. */
  histArgs: string
  /** Shown when a run has no recorded steps and is expanded. */
  histNoSteps: string

  // Tasks
  tasksTitle: string
  tasksSubtitle: string
  taskNew: string
  taskName: string
  taskKind: string
  taskKindGithub: string
  taskKindPrompt: string
  taskKindWorkflow: string
  taskPrompt: string
  taskPromptHint: string
  taskWorkflow: string
  taskWorkflowPlaceholder: string
  taskWorkflowHint: string
  taskSchedule: string
  taskSchedDaily: string
  taskSchedWeekdays: string
  taskSchedWeekly: string
  taskSchedInterval: string
  taskSchedManual: string
  taskManualHint: string
  taskManualChip: string
  taskEvery: string
  taskMinutes: string
  taskMaxRounds: string
  taskMaxRoundsHint: string
  taskDaysAll: string
  taskDaysWeekdays: string
  taskDaysWeekend: string
  taskClearFinished: string
  taskDeleteFinishedConfirm: string
  taskClearFinishedConfirm: string
  taskNotifyFeishu: string
  taskEnabled: string
  taskRunNow: string
  taskLastRun: string
  taskNever: string
  taskStatusOk: string
  taskStatusFailed: string
  taskStatusSkipped: string
  taskSave: string
  taskSaved: string
  taskDeleteConfirm: string
  taskRuns: string
  taskRunsEmpty: string
  taskRunsClear: string
  taskTriggerSchedule: string
  taskTriggerManual: string
  taskTriggerFeishu: string
  taskTriggerChat: string
  tasksRunning: string
  tasksRunningEmpty: string
  tasksActivity: string
  tasksMine: string
  tasksEmpty: string
  tasksFeishuSection: string
  tasksRunHistory: string
  tasksRecentlyFinished: string
  taskOutcomeOk: string
  taskOutcomeFailed: string
  taskOutcomeCancelled: string
  taskOutcomeSkipped: string
  taskUntitled: string
  taskTerminate: string
  taskCancelling: string
  taskStartedAt: string
  taskSourceChat: string
  taskSourceSchedule: string
  taskSourceManual: string
  taskSourceFeishu: string
  tasksFeishuTitle: string
  tasksFeishuWebhook: string
  tasksFeishuWebhookSecret: string
  tasksFeishuSecretHint: string
  tasksFeishuBot: string
  tasksFeishuAppId: string
  tasksFeishuAppSecret: string
  tasksFeishuBotHint: string
  tasksFeishuTest: string
  tasksFeishuTestOk: string
  tasksFeishuBotWarn: string
  taskTemplateGithubName: string

  // Workflows
  workflowsEmpty: string
  workflowsNew: string
  workflowsRunNow: string
  workflowsEdit: string
  workflowsDeleteConfirm: string
  workflowsTriggerManual: string
  workflowsTriggerScheduled: string
  workflowsTriggerContextMenu: string
  workflowsTriggerVisitWeb: string
  workflowsTriggerGithub: string
  workflowsTriggerFeishu: string
  workflowsTriggerInterval: string
  workflowsTriggerDate: string
  workflowsTriggerSpecificDay: string
  workflowsTriggerStartup: string
  workflowsTriggerShortcut: string
  workflowsTriggerElementChange: string
  workflowsTriggerNone: string
  workflowsLastRun: string
  workflowsRunHistory: string
  workflowsRunStatusNever: string
  workflowsExport: string
  workflowsImport: string
  workflowsImportInvalid: string
  workflowsImported: (params: { count: number }) => string
  /** Select-all checkbox in the Workflows tab toolbar (batch management). */
  workflowsSelectAll: string
  /** Icon-only batch-delete button in the Workflows tab toolbar (needs a selection). */
  workflowsBatchDelete: string
  /** Confirm dialog body for deleting every checked workflow at once. */
  workflowsBatchDeleteConfirm: (params: { count: number }) => string
  /** Success banner after a batch delete. */
  workflowsBatchDeleteDone: (params: { count: number }) => string
  /** Shown on a failed-run banner in the Workflows tab; the banner is clickable and jumps to the run's history entry. */
  workflowsRunFailedHint: string
  /**
   * M4: "Resume" button on a workflow card — re-runs the workflow from the
   * step after its last clean checkpoint instead of its trigger, so a login or
   * a submit that already happened is not repeated.
   */
  workflowsResume: string
  /** Tooltip explaining what resume skips. */
  workflowsResumeTitle: string
  /** Banner when a resume request had no resumable point and started fresh. */
  workflowsResumeNone: string
  /** Banner after a resumed run finished; `{ step }` is the 1-based step it resumed after. */
  workflowsResumedOk: (params: { step: number }) => string
  /** Debug button on each workflow card: run once, then AI takes over failed nodes. */
  workflowsDebug: string
  /** Debug button label while the AI debug session is running for that workflow. */
  workflowsDebugging: string
  /** Banner when the debug run passed on the first attempt (no AI takeover needed). */
  workflowsDebugOkNoChanges: string
  /** Banner when the fixed workflow passed a takeover-free verify run. */
  workflowsDebugVerified: (params: { count: number }) => string
  /** Banner when the audit rebuilt the whole graph and the rebuild verified. */
  workflowsDebugRewriteVerified: (params: { count: number }) => string
  /** Confirm dialog before replacing the workflow with the AI-rebuilt graph. */
  workflowsDebugRewriteConfirmTitle: string
  workflowsDebugRewriteConfirmMessage: (params: { diagnosis: string }) => string
  workflowsDebugRewriteApply: string
  /** Banner after the rebuilt workflow was applied. */
  workflowsDebugRewriteApplied: string
  /** CRITICAL rewrite-risk second confirmation (P2, spec §8.4). */
  workflowsRewriteRiskTitle: string
  workflowsRewriteRiskMessage: (params: { level: string }) => string
  workflowsRewriteRiskAccept: string
  /** Banner when the run passed via AI but the fixes did NOT verify. */
  workflowsDebugNotVerified: string
  /** Lifetime takeover success-rate line in the debug modal footer. */
  workflowsDebugStats: (params: { rate: number; total: number }) => string
  workflowsDebugSessionStats: (params: { rate: number; total: number; p50: number }) => string
  /** Classified takeover failure reasons (stats line). */
  workflowsDebugReasonAuth: string
  workflowsDebugReasonCaptcha: string
  workflowsDebugReasonNotfound: string
  workflowsDebugReasonTimeout: string
  workflowsDebugReasonNetwork: string
  workflowsDebugReasonOther: string
  workflowsDebugReasonUnclassified: string
  /** Banner when the AI debug session ended without a passing run. */
  workflowsDebugFailed: string
  /** Banner when AI takeover completed {count} failed node(s) and the run passed. */
  workflowsDebugTakeoverDone: (params: { count: number }) => string
  /** Live AI debug log modal. */
  workflowsDebugLogTitle: string
  /** Badge while the debug session is still running. */
  workflowsDebugLogLive: string
  /** Badge once the debug session has settled. */
  workflowsDebugLogDone: string
  /** Empty state before the first debug step lands. */
  workflowsDebugLogEmpty: string
  workflowsDebugLogClose: string
  /** Confirm dialog title before applying the AI's proposed node fixes. */
  workflowsDebugTakeoverConfirmTitle: string
  /** Confirm dialog body asking the user to apply the takeover's node fixes. */
  workflowsDebugTakeoverConfirmMessage: string
  workflowsDebugTakeoverApply: string
  workflowsDebugTakeoverDiscard: string
  /** Banner after the fixes were applied to the workflow. */
  workflowsDebugTakeoverApplied: string
  /** Banner when there was nothing applicable to apply. */
  workflowsDebugTakeoverNothing: string
  /** Banner after the fixes were discarded. */
  workflowsDebugTakeoverDiscarded: string
  /** Pending chip on cards with unanswered takeover fixes: hint with time + count. */
  workflowsDebugTakeoverPendingHint: (params: { time: string; changes: number }) => string

  // Unified workflow repair (spec §12)
  workflowsRepairAnalyze: string
  workflowsRepairSuggest: string
  workflowsRepairAuto: string
  workflowsRepairRunning: string
  workflowsRepairTitle: string
  workflowsRepairFailedNode: string
  workflowsRepairRootCause: string
  workflowsRepairVariables: string
  workflowsRepairPatch: string
  workflowsRepairReplay: string
  workflowsRepairVerification: string
  workflowsRepairStatusOk: string
  workflowsRepairStatusMissing: string
  workflowsRepairStatusEmpty: string
  workflowsRepairStatusType: string
  workflowsRepairVerified: string
  workflowsRepairNotVerified: string
  workflowsRepairRetryHint: string
  workflowsRepairNoProvider: string
  workflowsRepairCommit: string
  workflowsRepairDiscard: string
  workflowsRepairCommitted: string
  workflowsRepairClose: string
  workflowsRepairConfidence: (params: { percent: number }) => string
  /** Low-confidence proposal needs explicit human confirmation (P2). */
  workflowsRepairLowConfidenceTitle: string
  workflowsRepairLowConfidenceHint: string
  workflowsRepairLowConfidenceAccept: string
  workflowsRepairBeforeAfter: string

  /** Activity board (History tab) collapse/expand toggle title. */
  tasksActivityCollapse: string
  tasksActivityExpand: string

  // Common
  save: string
  cancel: string
  edit: string
  delete: string
  loading: string
  tryAgain: string
  reloadPanel: string
  /** Generic confirm dialog button. */
  dialogConfirm: string
  /** Confirm dialog title for destructive deletions. */
  dialogDeleteTitle: string
  /** Warning dialog title (e.g. enabling full-auto mode). */
  dialogWarningTitle: string
  /** Alert dialog acknowledgement button. */
  dialogOK: string

  // Chat
  chatEmpty: string
  chatPlaceholder: string
  chatSend: string
  chatStop: string
  chatNewChat: string
  chatAttachSelection: string
  /** Composer 📎 button tooltip. */
  chatAttach: string
  /** Remove button on a pending attachment chip. */
  chatAttachmentRemove: string
  /** One file exceeds the per-file size limit. */
  chatAttachmentTooLarge: (params: { name: string }) => string
  /** One file is neither an allowed image type nor an inlinable text type. */
  chatAttachmentUnsupported: (params: { name: string }) => string
  /** More than the allowed number of files on one message. */
  chatAttachmentTooMany: string
  /** One message's attachments together exceed the total size cap. */
  chatAttachmentTotalTooLarge: string
  chatReattached: string
  chatConnectionDropped: string
  chatExtensionReloaded: string
  /** Progress phases shown between send and the first token. */
  phasePreparing: string
  phaseReadingPage: string
  phaseSending: string
  phaseThinking: string
  phaseResponding: string
  /** Header of the collapsible model-reasoning (`<think>`) block. */
  chatThinking: string
  /** Inline label while a tool call in an assistant turn is still running. */
  chatToolRunning: string
  chatApprove: string
  chatDecline: string
  chatConfirmTitle: (params: { name: string }) => string
  chatSkillActive: (params: { name: string }) => string
  /** Sent as the user turn when a skill is active but the user typed nothing. */
  chatSkillGo: (params: { name: string }) => string
  /** Same as above, but the user also attached their current page selection. */
  chatSkillGoSelection: (params: { name: string }) => string
  /** Composer hint shown once at least one skill exists. */
  chatPlaceholderWithSkills: string
  /** Shown in the slash menu when no skill matches what was typed. */
  chatSlashNoMatch: string
  /** Ask whether to persist this session's operations as a reusable workflow. */
  chatSaveWorkflowPrompt: (params: { steps: number }) => string
  /** Card title in workflow-generation mode (draft comes from operator tools, not history). */
  chatSaveWorkflowDraftPrompt: (params: { steps: number }) => string
  chatSaveWorkflowSave: string
  chatSaveWorkflowSkip: string
  /**
   * Shown when a workflow-generation turn recorded nothing: the model never
   * changed the page. Silence here is indistinguishable from a broken feature.
   */
  chatWorkflowNothingSaved: string
  chatWorkflowNotRunnable: (detail: string) => string
  /** Button on the not-runnable notice: feed the missing steps back and re-run. */
  chatWorkflowRegenerate: string
  /** Tooltip for the regenerate button. */
  chatWorkflowRegenerateHint: string
  /** Message sent to the model when regenerating after a validation failure. */
  chatWorkflowRegeneratePrompt: (detail: string) => string
  /** Same, but the model tried and every action failed — worth retrying. */
  chatWorkflowNothingSavedFailed: string
  /** The selector probe is still running, so nothing is known yet. */
  chatWorkflowProbeChecking: string
  /** Heading of the graph-consistency list on the save card. */
  chatWorkflowIntegrityTitle: string
  /** Heading of the runnability (required-parameter) list on the save card. */
  chatWorkflowRunIssuesTitle: string
  /** Prefix for one blocking runnability problem on the save card. */
  chatWorkflowRunIssuesError: string
  /** Prefix for one non-blocking runnability warning on the save card. */
  chatWorkflowRunIssuesWarning: string
  /** Hint under blocking runnability problems: save is disabled. */
  chatWorkflowRunIssuesBlocked: string
  /** Non-blocking hint: the workflow can still be saved despite these findings. */
  chatWorkflowRunIssuesNonBlocking: string
  /** Save first, then run the AI debug session on the saved workflow. */
  chatWorkflowSaveThenDebug: string
  chatWorkflowSaveThenDebugHint: string
  chatWorkflowSaveThenDebugStarted: string
  /** One `{{reference}}` no block produces and no input declares. */
  chatWorkflowIntegrityDangling: (params: { blockId: string }) => string
  /** Steps the trigger head cannot reach, so the replay will never run them. */
  chatWorkflowIntegrityUnreachable: (params: { count: number }) => string
  chatSaveWorkflowSaved: (params: { name: string }) => string
  /** Title of the AI-prefill checkbox list on the workflow save card. */
  chatSaveWorkflowAiTitle: string
  /** Heading for the declared-inputs list on the workflow save card. */
  chatWorkflowInputsTitle: string
  /** Heading for the generation pipeline stages on the save card. */
  generationStagesTitle: string
  /** Stage label: normalize. */
  generationStageNormalize: string
  /** Stage label: generalize inputs. */
  generationStageGeneralizeInputs: string
  /** Stage label: harden targets. */
  generationStageHardenTargets: string
  /** Stage label: build reliability contract. */
  generationStageBuildReliability: string
  /** Stage label: static validate. */
  generationStageStaticValidate: string
  /** Stage label: independent verify. */
  generationStageIndependentVerify: string
  /** The single AI repair CTA on a failed workflow. */
  failureCenterAiRepair: string
  /** Failure center dialog title. */
  failureCenterTitle: string
  /** Button: confirm the proposed repair. */
  failureCenterConfirmRepair: string
  /** Button: cancel the recovery. */
  failureCenterCancel: string
  /** Button: confirm overwrite of the formal workflow. */
  failureCenterConfirmOverwrite: string
  /** Button: keep the current workflow (do not overwrite). */
  failureCenterKeepCurrent: string
  /** Generic close button for terminal states. */
  failureCenterClose: string
  /** Title for the per-node change list. */
  proposalChangesTitle: string
  /** Risk label with level. */
  proposalRiskLabel: (params: { level: string }) => string
  /** Evidence section title. */
  proposalEvidenceTitle: string
  /** Verification plan section title. */
  proposalVerificationTitle: string
  /** Affected nodes section title. */
  proposalAffectedTitle: string
  /** Health status stable. */
  healthStatusStable: string
  /** Health status needs attention. */
  healthStatusNeedsAttention: string
  /** Health status no data. */
  healthStatusNoData: string
  /** Health pass ratio: passed / total runs. */
  healthRunsPassed: (params: { passed: number; total: number }) => string
  /** Health line: last verified at a relative/absolute time. */
  healthLastVerified: (params: { time: string }) => string
  /** Health line: last failure category. */
  healthLastFailure: (params: { category: string }) => string
  /** Health recovery line: repaired and resumed counts. */
  healthRecoveryCounts: (params: { repaired: number; resumed: number }) => string
  /** Hint under the declared-inputs list: the recorded value is a default. */
  chatWorkflowInputsHint: string
  /** Heading of the "this workflow needs code" list on the save card. */
  chatWorkflowCodeNodesTitle: string
  /** Hint under the code-node list: why it matters to a non-coder. */
  chatWorkflowCodeNodesHint: string
  /** Heading of the selector-health list on the save card. */
  chatWorkflowProbeTitle: string
  /** Every probed selector matched exactly one element. */
  chatWorkflowProbeAllOk: (params: { count: number }) => string
  /** The page could not be probed, so nothing was verified. */
  chatWorkflowProbeUnverified: string
  /** One probed selector matched nothing — the step will do nothing at replay. */
  chatWorkflowProbeMissing: string
  /** One probed selector matched several elements — the executor may pick the wrong one. */
  chatWorkflowProbeAmbiguous: (params: { count: number }) => string
  /** Checkbox on the save card: run the workflow once (with AI repair) right after saving. */
  chatWorkflowVerifyRun: string
  /** Hint under that checkbox: what it really does (side effects + model call). */
  chatWorkflowVerifyRunHint: string
  /** Status line once the verify run has been handed to the background. */
  chatWorkflowVerifyStarted: string
  /** The verify run finished green. */
  chatWorkflowVerifyPassed: (params: { summary: string }) => string
  /** The verify run failed; the reason is the run's own error text. */
  chatWorkflowVerifyFailed: (params: { reason: string }) => string
  /** The verify run passed via AI takeover, with fixes awaiting confirmation. */
  chatWorkflowVerifyPending: (params: { count: number }) => string
  /** Fallback label for a code node that carries no description of its own. */
  chatWorkflowCodeNodesNoReason: string
  /** Heading of the independent-verification section on the save card. */
  chatWorkflowRepairTitle: string
  /** The generated workflow ran independently without AI takeover. */
  chatWorkflowRepairVerified: string
  /** The repair loop ended without an independent verification. */
  chatWorkflowRepairNotVerified: string
  /** Label for the failed (symptom) node row on the save card. */
  chatWorkflowRepairFailedNode: (params: { nodeId: string }) => string
  /** Label for the root-cause node list on the save card. */
  chatWorkflowRepairRootCauses: (params: { nodes: string }) => string
  /** Hint that verification did not block saving; AI debug can continue repair. */
  chatWorkflowRepairHint: string
  /** Optional button on the save card that runs the (token-costly) AI review. */
  chatSaveWorkflowAiReview: string
  /** Heading of the trigger picker on the save-as-workflow card. */
  chatSaveWorkflowTriggerTitle: string
  /** Shown when the chosen trigger never fires on its own. */
  chatSaveWorkflowTriggerHintManual: string
  /** Shown when the chosen trigger fires automatically after saving. */
  chatSaveWorkflowTriggerHintAuto: string
  chatSaveWorkflowTriggerShortcut: string
  chatSaveWorkflowTriggerMenuName: string
  chatSaveWorkflowTriggerUrl: string
  chatSaveWorkflowTriggerInterval: string
  chatSaveWorkflowTriggerDate: string
  chatSaveWorkflowTriggerTime: string
  /** Element-change trigger: the selector of the element to watch. */
  chatSaveWorkflowTriggerElementSelector: string
  /** Element-change trigger: URL glob the observer applies to. */
  chatSaveWorkflowTriggerElementPattern: string
  /** Element-change trigger: which mutations count as a change. */
  chatSaveWorkflowTriggerElementSubtree: string
  chatSaveWorkflowTriggerElementChildList: string
  chatSaveWorkflowTriggerElementAttributes: string
  chatSaveWorkflowTriggerElementCharacterData: string
  /** Labels of the trigger kinds offered by the picker. */
  triggerKindManual: string
  triggerKindOnStartup: string
  triggerKindKeyboardShortcut: string
  triggerKindContextMenu: string
  triggerKindVisitWeb: string
  triggerKindInterval: string
  triggerKindSpecificDay: string
  triggerKindDate: string
  triggerKindElementChange: string
  /** Heading of the "fold repeated steps into a loop" section. */
  chatFoldTitle: string
  /** Why folding matters, and what a varying fold depends on. */
  chatFoldHint: string
  chatFoldApply: string
  chatFoldBusy: string
  /** Confirmation after a successful fold. */
  chatFoldApplied: string
  /** Shown when a fold was refused (no page-verified selector). */
  chatFoldRefused: string
  /** In-progress line while the AI node review is running. */
  chatWorkflowReviewing: string
  /** Hint shown when the AI node review is unavailable (no provider / failure). */
  chatWorkflowReviewUnavailable: string
  /** One-line count of steps the AI judged garbage. */
  chatWorkflowReviewDropped: (params: { count: number }) => string
  /** One-line count when the AI found no garbage steps. */
  chatWorkflowReviewAllKept: string
  /** Title of the step checklist on the save card / review dialog. */
  chatWorkflowStepsTitle: string
  /** Title of the history-tab review dialog. */
  workflowReviewDialogTitle: string
  workflowReviewDialogConfirm: string
  workflowReviewDialogCancel: string
  /** Retry button after a failed/unavailable review. */
  workflowReviewDialogRetry: string
  /** Collapsible live-log section header in the review dialog. */
  workflowReviewLogTitle: string
  workflowReviewLogCollapse: string
  workflowReviewLogExpand: string
  /** First review-log line: the step list was sent to the reviewer. */
  workflowReviewLogStart: (params: { steps: number }) => string
  /** Review-log line for a failed attempt (timeout / endpoint / parse). */
  workflowReviewLogFailed: string

  // Agent mode
  modeLabel: string
  modeChat: string
  modeReadonly: string
  modeSemi: string
  modeFull: string
  modeWorkflow: string
  modeChatHint: string
  modeReadonlyHint: string
  modeSemiHint: string
  modeFullHint: string
  modeFullWarning: string
  modeWorkflowWarning: string
  modeWorkflowHint: string

  // Plan card (present_plan tool)
  /** Card title for an agent-submitted execution plan. */
  planCardTitle: string
  /** Section label above the goal line. */
  planCardGoal: string
  /** Section label above the numbered step list. */
  planCardSteps: string
  /** Section label above the risk notes (login, CAPTCHA, irreversible steps). */
  planCardRisks: string
  /** Section label above the split/composition note (multi-workflow plans). */
  planCardSplit: string
  /** Approve button: unlock execution of the submitted plan. */
  planApprove: string
  /** Reject button: opens the feedback input for a revision. */
  planRevise: string
  /** Placeholder of the rejection feedback textarea. */
  planFeedbackPlaceholder: string
  /** Submit button of the rejection feedback input. */
  planFeedbackSend: string
  /** Read-only state label after the plan was approved. */
  planApprovedChip: string
  /** Read-only state label after the plan was rejected. */
  planRejectedChip: string
  /** Aria label for the plan approval card region. */
  planCardAria: string
  /** Status line shown when the conversation history is compacted mid-turn. */
  contextCompacted: string
  /** Prefix stamped on the user-role message that carries the compaction summary. */
  contextCompactedMarker: string

  // Token usage
  tokenUsage: string
  tokenTotal: string
  tokenInput: string
  tokenOutput: string
  tokenCached: string
  tokenReasoning: string
  tokenCacheRate: string
  tokenSession: string
  tokenLastTurn: string
  tokenNone: string

  // Markdown rendering
  /** Copy button on a fenced code block. */
  mdCopy: string
  /** Transient confirmation after a successful copy. */
  mdCopied: string
  /** Shown when the browser refused clipboard access. */
  mdCopyFailed: string
  /** Language label for a fence with no language given. */
  mdCodePlain: string

  // Skills
  skillsTitle: string
  skillsIntro: string
  skillsEmpty: string
  skillsAdd: string
  skillsName: string
  skillsNamePlaceholder: string
  skillsDescription: string
  skillsDescriptionHint: string
  skillsInstructions: string
  skillsInstructionsHint: string
  skillsAutoMatch: string
  skillsAutoMatchHint: string
  skillsSaved: (params: { name: string }) => string
  skillsDeleted: (params: { name: string }) => string
  skillsDeleteConfirm: (params: { name: string }) => string
  skillsNameRequired: string
  skillsInstructionsRequired: string
  skillsNameTaken: string
  skillsUse: string
  skillsInUse: string
  skillsStopUsing: string
  skillsBuiltinNote: string

  // Settings
  settingsProviders: string
  settingsProvidersIntro: string
  settingsNoProvider: string
  settingsAddProvider: string
  settingsChoosePreset: string
  /** Placeholder for the preset-endpoint dropdown in the provider editor. */
  settingsChooseEndpoint: string
  settingsUseThis: string
  settingsActive: string
  settingsKeyConfigured: string
  settingsNoKey: string
  settingsName: string
  settingsBaseUrl: string
  /** Label for the preset-endpoint dropdown in the provider editor. */
  settingsEndpointPresets: string
  settingsBaseUrlHint: string
  settingsImageModel: string
  /** Button on a status card that opens its editing dialog. */
  settingsModify: string
  /** Status-card line showing the configured model selection. */
  settingsImageModelCurrentValue: (params: { value: string }) => string
  /** AI-takeover debug model card. */
  settingsTakeoverModel: string
  settingsTakeoverModelIntro: string
  settingsTakeoverOnRun: string
  settingsTakeoverOnRunIntro: string
  settingsTakeoverModelProvider: string
  settingsTakeoverModelSelectHint: string
  settingsTakeoverModelSaved: string
  settingsImageModelIntro: string
  settingsImageModelProvider: string
  settingsImageModelAuto: string
  settingsImageModelFetchNoProvider: string
  settingsImageModelProviderMissing: string
  settingsImageModelSaved: string
  settingsOcrLanguage: string
  settingsOcrLanguageIntro: string
  settingsSaving: string
  settingsApiKey: string
  settingsShowKey: string
  settingsModel: string
  settingsModelsAvailable: (params: { count: number }) => string
  settingsImageModelSelectHint: string
  settingsShowAdvanced: string
  settingsHideAdvanced: string
  settingsTemperature: string
  settingsMaxTokens: string
  settingsProviderDefault: string
  settingsExtraHeaders: string
  settingsTest: string
  settingsTesting: string
  settingsFetchModels: string
  settingsFetchingModels: string
  settingsKeyStorageNote: string
  settingsTestOk: (params: { name: string }) => string
  settingsNewProvider: string
  settingsEditProvider: string
  settingsLanguage: string
  settingsLanguageAuto: string
  settingsKeyPlaceholderLocal: string
  settingsMaxToolRounds: string
  settingsMaxToolRoundsHint: string
  settingsModelsEmpty: string
  settingsModelsFailed: (params: { message: string }) => string
  settingsSaved: (params: { name: string }) => string

  // Settings · model context (system prompt + tool toggles)
  settingsContextTitle: string
  settingsContextIntro: string
  settingsSystemPrompt: string
  settingsSystemPromptHint: string
  settingsPromptSave: string
  settingsPromptReset: string
  settingsPromptDefault: string
  settingsPromptCustom: string
  settingsStateDefault: string
  settingsStateCustom: string
  settingsTools: string
  settingsToolsHint: string
  settingsToolsEnableAll: string
  settingsToolsDisableAll: string
  settingsToolsEnabled: string
  /** Heading of the read-only workflow-operator reference in settings. */
  settingsOperatorTools: string
  /** Explains that these are workflow-mode-only and dispatched by category. */
  settingsOperatorToolsHint: string
  /** Badge on the always-advertised operators. */
  settingsOperatorToolsCore: string
  /** Badge on the operators that arrive only after the model asks. */
  settingsOperatorToolsOnDemand: string
  /** Tool count next to a category heading. */
  settingsOperatorToolsCount: (params: { count: number }) => string
  /** Note that this list is informational and cannot be disabled. */
  settingsOperatorToolsReadOnly: string
  toolReadPage: string
  toolReadPageWarn: string
  toolSnapshot: string
  toolSnapshotWarn: string
  toolListTabs: string
  toolListTabsWarn: string
  toolNetworkRequests: string
  toolNetworkRequestsWarn: string
  toolConsoleLog: string
  toolConsoleLogWarn: string
  toolClick: string
  toolClickWarn: string
  toolFill: string
  toolFillWarn: string
  toolSelect: string
  toolSelectWarn: string
  toolCheckbox: string
  toolCheckboxWarn: string
  toolPressKey: string
  toolPressKeyWarn: string
  toolScroll: string
  toolScrollWarn: string
  toolWait: string
  toolWaitWarn: string
  toolOpenUrl: string
  toolOpenUrlWarn: string
  toolTabNew: string
  toolTabNewWarn: string
  toolTabSwitch: string
  toolTabSwitchWarn: string
  toolTabClose: string
  toolTabCloseWarn: string
  toolPinTab: string
  toolPinTabWarn: string
  toolUnpinTab: string
  toolUnpinTabWarn: string
  toolRunJs: string
  toolRunJsWarn: string
  toolRunPlan: string
  toolRunPlanWarn: string
  toolSaveLocal: string
  toolSaveLocalWarn: string
  toolProfile: string
  toolProfileWarn: string
  toolListSecrets: string
  toolListSecretsWarn: string
  toolSecret: string
  toolSecretWarn: string
  toolSkill: string
  toolSkillWarn: string
  toolCreateSkill: string
  toolCreateSkillWarn: string
  toolRecognizeImage: string
  toolRecognizeImageWarn: string
  toolScreenshot: string
  toolScreenshotWarn: string
  toolListTasks: string
  toolListTasksWarn: string
  /** Label of the create_scheduled_task tool in the settings tool list. */
  toolCreateTask: string
  /** What breaks when create_scheduled_task is disabled. */
  toolCreateTaskWarn: string
  toolLoadTools: string
  toolLoadToolsWarn: string
  toolDelegate: string
  toolDelegateWarn: string
  /** Label of the ask_user tool in the settings tool list. */
  toolAskUser: string
  /** What breaks when ask_user is disabled. */
  toolAskUserWarn: string
  /** Label of the present_plan tool in the settings tool list. */
  toolPresentPlan: string
  /** What breaks when present_plan is disabled. */
  toolPresentPlanWarn: string
  /** Title of the ask_user card in the chat log. */
  chatAskTitle: string
  /** Placeholder of the free-text answer input on the ask_user card. */
  chatAskPlaceholder: string
  /** Chip marking the recommended (first) option on the ask_user card. */
  chatAskRecommended: string
  /** Floating pill shown when the user scrolled up during a streaming answer. */
  chatJumpToLatest: string
  toolOperator: string
  toolOperatorWarn: string

  // Settings · page access
  settingsPageAccess: string
  settingsPageAccessIntro: string
  settingsCheckTab: string
  settingsPageReadable: (params: { title: string }) => string
  settingsPageBlocked: (params: { reason: string }) => string

  // Settings · storage location
  settingsStorage: string
  settingsStorageIntro: string
  settingsStorageBrowser: string
  settingsStorageFile: string
  settingsStorageFolder: (params: { name: string }) => string
  settingsChooseFolder: string
  settingsChangeFolder: string
  settingsReconnectFolder: string
  settingsUseBrowserStorage: string
  settingsStorageUnsupported: string
  settingsStorageSynced: (params: { name: string }) => string
  settingsStorageNeedReconnect: (params: { name: string }) => string
  settingsStoragePendingWrites: (params: { count: number }) => string

  // Settings · download directory
  settingsDownloadDir: string
  settingsDownloadDirIntro: string
  settingsDownloadDirFolder: (params: { name: string }) => string
  settingsDownloadDirNone: string
  settingsDownloadDirDone: (params: { name: string }) => string
  settingsDownloadDirFailed: string
  settingsDownloadDirDisconnect: string
  settingsDownloadAutoSave: string

  // Settings · local-agent bridge
  settingsLocalAgent: string
  /** Short one-liner introducing the local-agent bridge. */
  settingsLocalAgentIntro: string
  settingsLocalAgentEnable: string
  /** Title of the collapsed "配置接入" configuration section. */
  settingsLocalAgentConfigure: string
  settingsLocalAgentUrl: string
  settingsLocalAgentUrlPlaceholder: string
  settingsLocalAgentToken: string
  settingsLocalAgentTokenPlaceholder: string
  /** Compact connection-state badge (connected / connecting / not connected). */
  settingsLocalAgentStatusConnected: string
  settingsLocalAgentStatusConnecting: string
  settingsLocalAgentStatusDisconnected: string
  settingsLocalAgentStatusError: (params: { error: string }) => string
  /** Shown instead of a raw `ERR_CONNECTION_REFUSED` when no adapter is listening. */
  settingsLocalAgentErrorRefused: string
  /** Title of the per-window connection-assignment surface. */
  settingsLocalAgentBindingsTitle: string
  /** Hint explaining window assignments and the unassigned-refusal rule. */
  settingsLocalAgentBindingsHint: string
  /** Placeholder option: the connection is not assigned to any window. */
  settingsLocalAgentBindingUnassigned: string
  /** Suffix marking the window the current panel lives in. */
  settingsLocalAgentBindingThisWindow: string
  /** Disabled pseudo-option for an assignment whose window was closed. */
  settingsLocalAgentBindingClosed: (params: { id: number }) => string
  /** Warning shown when several live connections share the same name. */
  settingsLocalAgentBindingDuplicate: string
  /** Heading for assignments whose connection is no longer connected. */
  settingsLocalAgentBindingStale: string
  /** Button removing one stale assignment. */
  settingsLocalAgentBindingRemove: string
  /** "N agent connection(s) connected" suffix next to the selector hint. */
  settingsLocalAgentAgentsConnected: (params: { count: number }) => string
  settingsLocalAgentMcpTitle: string
  settingsLocalAgentMcpHint: string
  /** Short tab labels for the MCP snippet switcher. */
  settingsLocalAgentMcpTabClaude: string
  settingsLocalAgentMcpTabCodex: string
  settingsLocalAgentMcpTabTrae: string
  /** One-click export of the bundled mcp-server.mjs adapter (release-zip users need no source). */
  settingsLocalAgentExportTitle: string
  settingsLocalAgentExportIntro: string
  settingsLocalAgentExport: string
  settingsLocalAgentReexport: string
  settingsLocalAgentExporting: string
  settingsLocalAgentExportedTo: (params: { path: string }) => string
  settingsLocalAgentExportFailed: string
  /** Hint shown before export: use the button, or replace the placeholder manually. */
  settingsLocalAgentMcpPlaceholderHint: string
  /** Hint shown after export: the snippets carry the real exported path. */
  settingsLocalAgentMcpExportedHint: string
  settingsLocalAgentCopy: string
  settingsLocalAgentCopied: string
  settingsLocalAgentWarning: string

  // Data / memory
  dataTitle: string
  dataIntro: string
  dataProfiles: string
  dataProfilesIntro: string
  dataProfilesEmpty: string
  dataAddProfile: string
  dataProfileLabel: string
  dataFullName: string
  dataFirstName: string
  dataLastName: string
  dataEmail: string
  dataPhone: string
  dataAddress: string
  dataCity: string
  dataState: string
  dataPostalCode: string
  dataCountry: string
  dataCompany: string
  dataJobTitle: string
  dataCustomFields: string
  dataCustomFieldsHint: string
  dataPasswords: string
  dataPasswordsIntro: string
  dataPasswordsEmpty: string
  dataAddPassword: string
  dataPasswordLabel: string
  dataPasswordUrl: string
  dataPasswordUsername: string
  dataPasswordValue: string
  dataPasswordNotes: string
  dataPasswordStorageNote: string
  dataSecrets: string
  dataSecretsIntro: string
  dataSecretsEmpty: string
  dataAddSecret: string
  dataSecretLabel: string
  dataSecretUrl: string
  dataSecretFields: string
  dataSecretAddField: string
  dataSecretFieldKey: string
  dataSecretFieldValue: string
  dataSecretMaskValue: string
  dataShowPassword: string
  dataHistory: string
  dataHistoryIntro: string
  dataHistoryEmpty: string
  dataClearHistory: string
  dataHistoryToWorkflow: string
  dataHistoryToWorkflowDone: string
  dataHistoryToWorkflowEmpty: string
  dataHistoryWhen: string
  dataConversation: string
  dataDeclined: string
  dataUsed: (params: { count: number }) => string

  // Conversations
  convTitle: string
  convNew: string
  convRename: string
  convDelete: string
  convUntitled: string
  convDeleteConfirm: string
  convHistory: string
  convHistoryEmpty: string
  convContinue: string
  convPreview: string
  convUpdated: string

  // Confirm action
  confirmActionHint: string

  // Errors
  errorPanelCrashed: string
  errorWhatHappened: string
  errorVersionSkew: string
  errorTemperatureNumber: string
  errorMaxTokensInteger: string
  errorHeadersJson: string
  errorHeadersObject: string

  // --- New: chat message actions (copy / download) ---
  /** Generic copy button on a user/assistant message bubble. */
  msgCopy: string
  /** Transient confirmation after a successful message copy. */
  msgCopied: string
  /** Shown when the browser refused clipboard access for a message. */
  msgCopyFailed: string
  /** Download button tooltip / label on an assistant message bubble. */
  msgDownload: string
  /** Title of the format picker opened by the download button. */
  msgDownloadAs: string
  /** Markdown (.md) option in the download menu. */
  msgDownloadMd: string
  /** Plain text (.txt) option in the download menu. */
  msgDownloadTxt: string
  /** Printable HTML / PDF option in the download menu. */
  msgDownloadHtmlPdf: string
  /** CSV option in the download menu, shown when the answer contains a table. */
  msgDownloadCsv: string
  /** Filename base used when the conversation has no title. */
  msgDownloadUntitled: string
  /** Hint shown after downloading HTML: users can print to PDF. */
  msgDownloadHtmlHint: string
  /** Accessible label for the per-turn token indicator button on the final answer. */
  msgTokenUsage: string

  // --- New: inline token bar (below composer-row) ---
  /** Label for the session aggregate block on the token bar. */
  tokenBarSession: string
  /** Label for the last-turn aggregate block on the token bar. */
  tokenBarLastTurn: string
  /** Short "Total" label used inside the token bar. */
  tokenBarT: string
  /** Short "Input" label used inside the token bar. */
  tokenBarI: string
  /** Short "Output" label used inside the token bar. */
  tokenBarO: string
  /** Short "Reasoning" label used inside the token bar. */
  tokenBarR: string
  /** Short "Cached input" label used inside the token bar. */
  tokenBarC: string
  /** Placeholder token string when a turn/session has no usage yet. */
  tokenBarDash: string

  // --- New: in-chat generated skill saving ---
  /** Headline banner shown above a skill detected from an assistant reply. */
  skillGeneratedPreview: string
  /** Button label: save the generated skill as-is. */
  skillSave: string
  /** Button label: open an editor before saving this skill. */
  skillSaveEdit: string
  /** Button label: dismiss this generated-skill card. */
  skillDiscard: string
  /** Banner after a generated skill was successfully saved. */
  skillSavedBanner: (params: { name: string }) => string
  /** Checkbox label on the generated-skill form. */
  skillAutoMatch: string
  /** Label for the inline name form. */
  skillName: string
  /** Label for the inline description form. */
  skillDescription: string
  /** Label for the inline instructions form. */
  skillInstructions: string

  // --- New: skills tab import / export ---
  /** Skills tab "Import" button label. */
  skillsImport: string
  /** Skills tab import tooltip / hint (drag-and-drop). */
  skillsImportHint: string
  /** Skills tab import file-dialog button. */
  skillsImportFile: string
  /** Skills tab banner: import succeeded. */
  skillsImportResultOk: (params: { count: number }) => string
  /** Skills tab banner: import failed for some/all entries. */
  skillsImportResultFail: (params: { ok: number; failed: number }) => string
  /** Skills tab "Export all" button label. */
  skillsExportAll: string
  /** Imported-skills banner detail: name already taken. */
  skillsImportNameTaken: (params: { name: string }) => string

  // --- Agents (supervisor/specialist delegation) ---
  agentsTitle: string
  agentsIntro: string
  agentsEmpty: string
  agentsAdd: string
  agentsImport: string
  agentsImportHint: string
  agentsExport: string
  agentsBuiltinNote: string
  agentsReset: string
  agentsBuiltinBadge: string
  agentsSpecialistPill: string
  agentsDelegatablePill: string
  agentsToolsCount: (params: { count: number }) => string
  agentsImportResultOk: (params: { count: number }) => string
  agentsImportResultFail: (params: { ok: number; failed: number }) => string
  agentsImportNameTaken: (params: { name: string }) => string
  agentRole: string
  agentRoleSupervisor: string
  agentRoleSpecialist: string
  agentDomain: string
  agentDomainSearch: string
  agentDomainWriting: string
  agentDomainOperations: string
  agentDomainWorkflow: string
  agentDomainAnalysis: string
  agentDomainCustom: string
  agentHint: string
  agentHintHint: string
  agentTools: string
  agentToolsHint: string
  agentToolsInherit: string
  agentSkills: string
  agentSkillsHint: string
  agentDelegatable: string
  agentDelegatableHint: string
  agentMaxRounds: string
  agentSaved: (params: { name: string }) => string
  agentDeleted: (params: { name: string }) => string
  agentsDeleteConfirm: (params: { name: string }) => string
  agentResetDone: (params: { name: string }) => string
  agentNameRequired: string
  agentInstructionsRequired: string
  agentNameTaken: string

  // --- Built-in agent i18n (display names, hints, instructions) ---
  builtinAgentSupervisorDisplayName: string
  builtinAgentSupervisorHint: string
  builtinAgentSupervisorInstructions: string
  builtinAgentSearchExpertDisplayName: string
  builtinAgentSearchExpertHint: string
  builtinAgentSearchExpertInstructions: string
  builtinAgentCopywriterDisplayName: string
  builtinAgentCopywriterHint: string
  builtinAgentCopywriterInstructions: string
  builtinAgentOpsExpertDisplayName: string
  builtinAgentOpsExpertHint: string
  builtinAgentOpsExpertInstructions: string
  builtinAgentWorkflowExpertDisplayName: string
  builtinAgentWorkflowExpertHint: string
  builtinAgentWorkflowExpertInstructions: string
  builtinAgentAnalystDisplayName: string
  builtinAgentAnalystHint: string
  builtinAgentAnalystInstructions: string

  // --- Workflow generation dialog (spec §32) ---
  workflowGenerationTitle: string
  workflowGenerationUnderstanding: string
  workflowGenerationWorking: string
  workflowGenerationRecovering: string
  workflowGenerationCompiling: string
  workflowGenerationValidating: string
  workflowGenerationReady: string
  /** Transitional loading title while the finished task is compiled/validated
   *  into the save card (after `done`, before the card popup can appear). */
  workflowGenerationPreparing: string
  /** Body hint under the preparing spinner. */
  workflowGenerationPreparingHint: string
  workflowGenerationSaved: string
  workflowGenerationCancel: string
  workflowGenerationBackground: string
  workflowGenerationClose: string
  workflowGenerationError: string
  workflowGenerationSave: string
  workflowGenerationEdit: string
  /** Dismiss the READY dialog without cancelling generation or saving. */
  workflowGenerationDismiss: string
  /** Reopen the READY save dialog from the inline chat card. */
  workflowGenerationReopen: string
  workflowGenerationSavedDetail: string
  workflowGenerationActionCount: ({ count }: { count: number }) => string
  workflowGenerationLogTitle: ({ count }: { count: number }) => string
  workflowGenerationRecoveredCount: ({ count }: { count: number }) => string

  // --- Workflow repair (spec §32) ---
  workflowRepairStarting: string
  workflowRepairDiagnosing: string
  workflowRepairApplying: string
  workflowRepairVerifying: string
  workflowRepairSuccess: string
  workflowRepairExhausted: string
  workflowRepairBlocked: string
  workflowRepairNeedHuman: string
  workflowRepairAutoTitle: string
  workflowRepairVerifiedDetail: string
  workflowRepairRevisionCommitted: ({ revision }: { revision: number }) => string
}

const en: Messages = {
  tabChat: 'Chat',
  tabSkills: 'Skills',
  tabAgents: 'Agents',
  tabTasks: 'Tasks',
  tabWorkflows: 'Workflows',
  tabData: 'Data',
  tabSettings: 'Settings',
  tabHistory: 'History',
  tabMore: 'More',
  panelMinimize: 'Minimize to a floating button',
  uploadFileWaiting: 'The workflow is waiting for you to choose a file.',
  uploadFileChoose: 'Choose file',
  uploadFileReading: 'Reading file…',
  windowPickTitle: 'Choose a window',
  windowPickHint: 'A background task needs to know which browser window to run in.',
  windowPickBadgeThisPanel: 'This panel',
  windowPickBadgeMinimized: 'Minimized',
  settingsWindowPolicyLabel: 'Unattended window',
  settingsWindowPolicyLatest: 'Latest plugin window (auto)',
  settingsWindowPolicyAsk: 'Ask me every time',
  settingsWindowPolicyFixed: 'Always this window',
  settingsWindowPolicyHelp:
    'Which window agent-bridge / scheduled / Feishu tasks act in when several windows run the plugin. They can only ever act in windows with the plugin open (panel expanded or minimized); with the plugin closed everywhere they fall back to the legacy global behaviour.',
  settingsWindowPolicyFixedWindow: 'Fixed window',

  // History tab
  histConversations: 'Conversations',
  histTasks: 'Task runs',
  histWorkflows: 'Workflows',
  histOperations: 'Operations',
  histEmpty: 'No records yet.',
  histBatchDelete: 'Delete selected',
  histDeleteSelected: 'Delete selected',
  histSelectAll: 'Select all',
  histDeleteConfirm: ({ count }) =>
    `Delete ${count} selected record${count > 1 ? 's' : ''}? This cannot be undone.`,
  histWorkflowRuns: 'Workflow runs',
  histTaskRuns: 'Task runs',
  histDetailTitle: 'Steps',
  histEmptyRuns: 'No runs yet.',
  histOutcomeOk: 'ok',
  histOutcomeFailed: 'failed',
  histOutcomeCancelled: 'cancelled',
  histOutcomeSkipped: 'skipped',
  histArgs: 'Arguments',
  histNoSteps: 'No recorded steps.',

  tasksTitle: 'Run tasks',
  tasksSubtitle:
    'Run a task on a schedule and optionally deliver the result to Feishu. Scheduled runs only fire while the browser is open.',
  taskNew: 'New task',
  taskName: 'Name',
  taskKind: 'What it does',
  taskKindGithub: 'Count PRs waiting for my review on GitHub',
  taskKindPrompt: 'Run an agent prompt',
  taskKindWorkflow: 'Run a saved workflow',
  taskPrompt: 'Prompt',
  taskPromptHint: 'The instruction the agent runs unattended.',
  taskWorkflow: 'Workflow',
  taskWorkflowPlaceholder: 'Select a workflow',
  taskWorkflowHint: 'This schedule runs the selected workflow unattended.',
  taskSchedule: 'When',
  taskSchedDaily: 'Daily at',
  taskSchedWeekdays: 'Weekdays (Mon–Fri) at',
  taskSchedWeekly: 'On weekdays',
  taskSchedInterval: 'Every',
  taskSchedManual: 'Manual',
  taskManualHint:
    'No automatic schedule — run it yourself with "Run now" or trigger it from Feishu.',
  taskManualChip: 'Manual',
  taskEvery: 'every',
  taskMinutes: 'minutes',
  taskMaxRounds: 'Max tool rounds',
  taskMaxRoundsHint:
    'How many model↔tool steps this task may run unattended. Independent of the global setting (default 50).',
  taskDaysAll: 'All',
  taskDaysWeekdays: 'Weekdays',
  taskDaysWeekend: 'Weekend',
  taskClearFinished: 'Clear',
  taskDeleteFinishedConfirm: 'Remove this finished run from the board?',
  taskClearFinishedConfirm: 'Clear all finished runs from the board?',
  taskNotifyFeishu: 'Notify via Feishu when done',
  taskEnabled: 'Enabled',
  taskRunNow: 'Run now',
  taskLastRun: 'Last run',
  taskNever: 'never',
  taskStatusOk: 'ok',
  taskStatusFailed: 'failed',
  taskStatusSkipped: 'skipped',
  taskSave: 'Save task',
  taskSaved: 'Task saved.',
  taskDeleteConfirm: 'Delete this task? Its run history is removed too.',
  taskRuns: 'Recent runs',
  taskRunsEmpty: 'No runs yet.',
  taskRunsClear: 'Clear',
  taskTriggerSchedule: 'schedule',
  taskTriggerManual: 'manual',
  taskTriggerFeishu: 'Feishu',
  taskTriggerChat: 'chat',
  tasksRunning: 'Running',
  tasksRunningEmpty: 'No tasks running. Start one from chat, a schedule, or Feishu.',
  tasksActivity: 'Activity',
  tasksMine: 'My tasks',
  tasksEmpty: 'No tasks yet. Create one to get started.',
  tasksFeishuSection: 'Feishu integration',
  tasksRunHistory: 'Run history',
  tasksRecentlyFinished: 'Recently finished',
  taskOutcomeOk: 'done',
  taskOutcomeFailed: 'failed',
  taskOutcomeCancelled: 'terminated',
  taskOutcomeSkipped: 'skipped',
  taskUntitled: 'Untitled',
  taskTerminate: 'Terminate',
  taskCancelling: 'Cancelling…',
  taskStartedAt: 'Started',
  taskSourceChat: 'chat',
  taskSourceSchedule: 'schedule',
  taskSourceManual: 'manual',
  taskSourceFeishu: 'Feishu',
  tasksFeishuTitle: 'Feishu',
  tasksFeishuWebhook: 'Custom-bot webhook URL',
  tasksFeishuWebhookSecret: 'Webhook signing secret (if enabled)',
  tasksFeishuSecretHint: 'Only needed if the bot has signature verification on.',
  tasksFeishuBot: 'Let a Feishu bot trigger tasks',
  tasksFeishuAppId: 'App ID',
  tasksFeishuAppSecret: 'App secret',
  tasksFeishuBotHint:
    'A self-built Feishu app with the long-connection mode. Chat to the bot to run a named task, or just say what you want (e.g. "check Weibo hot search") and the agent will open a tab and answer. It reconnects automatically and resumes after the browser wakes up.',
  tasksFeishuTest: 'Send test message',
  tasksFeishuTestOk: 'Test message sent.',
  tasksFeishuBotWarn:
    'While the browser is fully idle or the machine is asleep, the extension cannot be reached; it reconnects within about a minute of waking. For truly always-on remote control, add a small relay server.',
  taskTemplateGithubName: 'PRs to review',

  workflowsEmpty: 'No workflows yet. Create one to start automating.',
  workflowsNew: 'New',
  workflowsRunNow: 'Run',
  workflowsEdit: 'Edit',
  workflowsDeleteConfirm: 'Delete this workflow?',
  workflowsTriggerManual: 'Manual',
  workflowsTriggerScheduled: 'Scheduled',
  workflowsTriggerContextMenu: 'Context menu',
  workflowsTriggerVisitWeb: 'Visit web',
  workflowsTriggerGithub: 'GitHub',
  workflowsTriggerFeishu: 'Feishu',
  workflowsTriggerInterval: 'Interval',
  workflowsTriggerDate: 'On specific date',
  workflowsTriggerSpecificDay: 'Weekly',
  workflowsTriggerStartup: 'On startup',
  workflowsTriggerShortcut: 'Keyboard shortcut',
  workflowsTriggerElementChange: 'Element change',
  workflowsTriggerNone: 'No trigger',
  workflowsLastRun: 'Last run',
  workflowsRunHistory: 'Run history',
  workflowsRunStatusNever: 'Never',
  workflowsExport: 'Export',
  workflowsImport: 'Import',
  workflowsImportInvalid: 'Invalid workflow file(s): at least one export could not be read.',
  workflowsImported: ({ count }) => `Imported ${count} workflow(s).`,
  workflowsSelectAll: 'Select all',
  workflowsBatchDelete: 'Delete selected workflows',
  workflowsBatchDeleteConfirm: ({ count }) =>
    `Delete ${count} selected workflow(s)? This cannot be undone.`,
  workflowsBatchDeleteDone: ({ count }) => `Deleted ${count} workflow(s).`,
  workflowsRunFailedHint: 'Run failed — click to view details in history',
  /** M4: re-run a workflow from its last clean checkpoint instead of its trigger. */
  workflowsResume: 'Resume',
  workflowsResumeTitle:
    'Re-run from the step after the last one that completed — the finished steps are skipped, so a login or submit that already happened is not repeated.',
  workflowsResumeNone: 'Nothing to resume — this workflow will start from the beginning',
  workflowsResumedOk: ({ step }) => `Resumed after step ${step} and finished the run`,
  workflowsDebug: 'AI Debug',
  workflowsDebugging: 'AI Debugging…',
  workflowsDebugOkNoChanges: 'Run succeeded — nothing to debug',
  workflowsDebugRewriteVerified: ({ count }) =>
    `AI rebuilt the workflow and the new version verified (${count} change(s) awaiting confirmation)`,
  workflowsDebugRewriteConfirmTitle: 'Apply the AI-rebuilt workflow?',
  workflowsDebugRewriteConfirmMessage: ({ diagnosis }) =>
    `AI replayed the task like a chat run, audited the graph (wrong / missing / redundant / fallback nodes) and produced a corrected version that ran clean on its own. Applying REPLACES the current graph. Diagnosis: ${diagnosis}`,
  workflowsDebugRewriteApply: 'Apply rebuilt workflow',
  workflowsDebugRewriteApplied: 'The AI-rebuilt workflow has been applied',
  workflowsRewriteRiskTitle: 'High-risk rewrite — are you sure?',
  workflowsRewriteRiskMessage: ({ level }) =>
    `This whole-graph rewrite is classified ${level}. It removes or replaces core structure (e.g. the trigger or goal). Apply it only if you understand the consequences.`,
  workflowsRewriteRiskAccept: 'I understand — apply it',
  workflowsDebugVerified: ({ count }) =>
    `Verified: the fixed workflow ran clean without AI (${count} fix(es) awaiting confirmation)`,
  workflowsDebugNotVerified:
    'Run succeeded via AI, but the fixes did NOT pass verification — review them carefully',
  workflowsDebugStats: ({ rate, total }) => `Takeover success rate: ${rate}% of ${total}`,
  workflowsDebugSessionStats: ({ rate, total, p50 }) =>
    `Verified runs (no AI needed): ${rate}% of ${total} sessions · median ${p50}ms`,
  workflowsDebugReasonAuth: 'login wall',
  workflowsDebugReasonCaptcha: 'captcha',
  workflowsDebugReasonNotfound: 'element not found',
  workflowsDebugReasonTimeout: 'timeout',
  workflowsDebugReasonNetwork: 'network',
  workflowsDebugReasonOther: 'other',
  workflowsDebugReasonUnclassified: 'unclassified',
  workflowsDebugFailed: 'AI debug could not fix this workflow',
  workflowsDebugTakeoverDone: ({ count }) =>
    `Run succeeded — AI takeover completed ${count} failed node(s)`,
  workflowsDebugLogTitle: 'AI debug log',
  workflowsDebugLogLive: 'live',
  workflowsDebugLogDone: 'finished',
  workflowsDebugLogEmpty: 'Waiting for debug steps…',
  workflowsDebugLogClose: 'Close',
  workflowsDebugTakeoverConfirmTitle: 'Apply AI takeover node fixes?',
  workflowsDebugTakeoverConfirmMessage:
    'The AI takeover completed the failed steps on the live page and proposes the following node fixes so future runs work WITHOUT the AI. Apply them to the workflow?',
  workflowsDebugTakeoverApply: 'Apply fixes',
  workflowsDebugTakeoverDiscard: 'Discard',
  workflowsDebugTakeoverApplied: 'AI takeover fixes applied to the workflow',
  workflowsDebugTakeoverNothing: 'No applicable AI takeover fixes',
  workflowsDebugTakeoverDiscarded: 'AI takeover fixes discarded',
  workflowsDebugTakeoverPendingHint: ({ time, changes }) =>
    `AI takeover proposed ${changes} node fix(es) at ${time} — apply or discard`,

  workflowsRepairAnalyze: 'AI Analyze',
  workflowsRepairSuggest: 'AI Suggest Fix',
  workflowsRepairAuto: 'AI Auto Repair',
  workflowsRepairRunning: 'AI repair running…',
  workflowsRepairTitle: 'AI Workflow Repair',
  workflowsRepairFailedNode: 'Failed Node',
  workflowsRepairRootCause: 'Root Cause Node',
  workflowsRepairVariables: 'Variable Dependencies',
  workflowsRepairPatch: 'Patch',
  workflowsRepairReplay: 'Replay',
  workflowsRepairVerification: 'Verification',
  workflowsRepairStatusOk: 'available',
  workflowsRepairStatusMissing: 'missing',
  workflowsRepairStatusEmpty: 'empty',
  workflowsRepairStatusType: 'wrong type',
  workflowsRepairVerified: 'Verified — the workflow runs independently without AI takeover.',
  workflowsRepairNotVerified: 'Not verified — the repair did not pass an independent run.',
  workflowsRepairRetryHint:
    'The failure looks transient; a bounded retry is recommended before patching.',
  workflowsRepairNoProvider: 'No AI model is configured, so no patch can be proposed.',
  workflowsRepairCommit: 'Save repair',
  workflowsRepairDiscard: 'Discard',
  workflowsRepairCommitted: 'The verified repair was saved to the workflow.',
  workflowsRepairClose: 'Close',
  workflowsRepairConfidence: ({ percent }) => `Confidence ${percent}%`,
  workflowsRepairLowConfidenceTitle: 'Low confidence — please review before applying',
  workflowsRepairLowConfidenceHint:
    'The diagnosis or the proposed patch is uncertain. Nothing has been changed. Apply it only if this looks right.',
  workflowsRepairLowConfidenceAccept: 'I reviewed it — apply anyway',
  workflowsRepairBeforeAfter: 'before → after',

  tasksActivityCollapse: 'Collapse activity',
  tasksActivityExpand: 'Expand activity',

  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  loading: 'Loading…',
  tryAgain: 'Try again',
  reloadPanel: 'Reload panel',
  dialogConfirm: 'Confirm',
  dialogDeleteTitle: 'Delete?',
  dialogWarningTitle: 'Heads up',
  dialogOK: 'OK',

  chatEmpty: 'Ask about the page you are looking at, or anything else.',
  chatPlaceholder: 'Message… (Enter to send, Shift+Enter for a new line)',
  chatSend: 'Send',
  chatStop: 'Stop',
  chatNewChat: 'New chat',
  chatAttachSelection: 'Attach selection',
  chatAttach: 'Attach files',
  chatAttachmentRemove: 'Remove attachment',
  chatAttachmentTooLarge: ({ name }) => `${name} is too large (images ≤ 4 MB, text files ≤ 200 KB)`,
  chatAttachmentUnsupported: ({ name }) => `${name} is not a supported file type`,
  chatAttachmentTooMany: 'Too many attachments (max 4 per message)',
  chatAttachmentTotalTooLarge: 'Attachments exceed the total size limit (8 MB)',
  chatReattached: 'Still working — reattached to the run.',
  chatConnectionDropped:
    'The connection dropped mid-reply. Any answer was saved to this conversation — send another message to continue.',
  chatExtensionReloaded:
    'The extension was reloaded. Reload it in chrome://extensions, then reopen this panel.',
  phasePreparing: 'Preparing your request…',
  phaseReadingPage: 'Reading the page…',
  phaseSending: 'Sending to the model…',
  phaseThinking: 'Thinking…',
  phaseResponding: 'Responding…',
  chatThinking: 'Thinking',
  chatToolRunning: 'running…',
  chatApprove: 'Approve',
  chatDecline: 'Decline',
  chatConfirmTitle: ({ name }) => `Allow ${name}?`,
  chatAskTitle: 'The assistant needs your answer',
  chatAskPlaceholder: 'Type your answer…',
  chatAskRecommended: 'Recommended',
  chatJumpToLatest: 'Jump to latest',
  chatSkillActive: ({ name }) => `Skill: ${name}`,
  chatSkillGo: ({ name }) => `Apply the "${name}" skill now.`,
  chatSkillGoSelection: ({ name }) =>
    `Apply the "${name}" skill to the text I selected on the page.`,
  chatPlaceholderWithSkills: 'Message… (Enter to send, Shift+Enter for a new line, / for skills)',
  chatSlashNoMatch: 'No matching skill',
  chatSaveWorkflowPrompt: ({ steps }) =>
    `This session performed ${steps} step${steps > 1 ? 's' : ''} that can be reused. Save them as a workflow?`,
  chatSaveWorkflowDraftPrompt: ({ steps }) =>
    `Generated a workflow draft with ${steps} step${steps > 1 ? 's' : ''}. Save it to the workflow editor?`,
  chatSaveWorkflowSave: 'Save as workflow',
  chatSaveWorkflowSkip: 'Skip',
  chatWorkflowNothingSaved:
    'Nothing to save from this turn: no page operations were recorded. Do the task and try again, or ask the model to perform it on the page.',
  chatWorkflowNotRunnable: (detail) =>
    `The generated workflow did not pass the runnability check, so there is nothing to save yet: ${detail}. Ask the AI to fix it and try again.`,
  chatWorkflowRegenerate: 'Regenerate workflow',
  chatWorkflowRegenerateHint:
    'Send the missing steps back to the AI and run one more generation round.',
  chatWorkflowRegeneratePrompt: (detail) =>
    `The generated workflow is missing the steps that produce its data, so it cannot run: ${detail}. Please first add the reading steps (wf_op_get-text / wf_op_read-page / wf_op_attribute-value / wf_op_ai-agent) that produce every referenced value, wire them before the consuming nodes, and then end your turn again. Do not paste page content as literals.`,
  chatWorkflowNothingSavedFailed:
    'Nothing to save from this turn: every recorded action failed. Fix the failure and run it again.',

  chatWorkflowProbeChecking: 'Checking the selectors against the current page…',
  chatWorkflowIntegrityTitle: 'This graph will not run as saved',
  chatWorkflowRunIssuesTitle: 'Runnability check',
  chatWorkflowRunIssuesError: 'Must fix',
  chatWorkflowRunIssuesWarning: 'Worth checking',
  chatWorkflowRunIssuesBlocked:
    'Fix the problems marked "Must fix" first (in the workflow editor), then save. Saving is disabled because these steps cannot run.',
  chatWorkflowRunIssuesNonBlocking:
    'You can still save this workflow. After saving, run AI debug or fix these findings manually in the editor.',
  chatWorkflowSaveThenDebug: 'Save & AI debug',
  chatWorkflowSaveThenDebugHint:
    'Save the workflow first, then run an AI debug session to repair these findings.',
  chatWorkflowSaveThenDebugStarted:
    'Workflow saved. Starting an AI debug session to repair the findings…',
  chatWorkflowIntegrityDangling: ({ blockId }) =>
    `no step produces this value — "${blockId}" will run with an empty value. Declare it as a workflow input or add the step that produces it.`,
  chatWorkflowIntegrityUnreachable: ({ count }) =>
    `${count} step(s) cannot be reached from the trigger:`,
  chatSaveWorkflowSaved: ({ name }) => `Saved workflow: ${name}`,
  chatSaveWorkflowAiTitle:
    'AI-generated content (checked = regenerate with AI at replay; unchecked = reuse the captured text)',
  chatWorkflowInputsTitle: 'Workflow inputs',
  generationStagesTitle: 'Generation stages',
  generationStageNormalize: 'Normalize',
  generationStageGeneralizeInputs: 'Generalize inputs',
  generationStageHardenTargets: 'Harden targets',
  generationStageBuildReliability: 'Build reliability',
  generationStageStaticValidate: 'Static validate',
  generationStageIndependentVerify: 'Independent verify',
  failureCenterAiRepair: 'AI repair',
  failureCenterTitle: 'Workflow recovery',
  failureCenterConfirmRepair: 'Confirm repair',
  failureCenterCancel: 'Cancel',
  failureCenterConfirmOverwrite: 'Overwrite workflow',
  failureCenterKeepCurrent: 'Not now',
  failureCenterClose: 'Close',
  proposalChangesTitle: 'Proposed changes',
  proposalRiskLabel: ({ level }) => `Risk: ${level}`,
  proposalEvidenceTitle: 'Evidence',
  proposalVerificationTitle: 'Verification plan',
  proposalAffectedTitle: 'Affected nodes',
  healthStatusStable: 'Stable',
  healthStatusNeedsAttention: 'Needs attention',
  healthStatusNoData: 'No runs yet',
  healthRunsPassed: ({ passed, total }) => `${passed} / ${total} runs passed`,
  healthLastVerified: ({ time }) => `Last verified: ${time}`,
  healthLastFailure: ({ category }) => `Last failure: ${category}`,
  healthRecoveryCounts: ({ repaired, resumed }) => `${repaired} repaired · ${resumed} resumed`,
  chatWorkflowInputsHint:
    'These values were captured at generation time and become run-time inputs ({{name}}). The saved value is only a default — the workflow re-prompts or uses the trigger value on each run.',
  chatWorkflowCodeNodesTitle: 'Steps that need code',
  chatWorkflowCodeNodesHint:
    'These steps run JavaScript because no built-in operator could do them. Editing them means editing code — if you would rather not, ask the assistant to replace them with operators.',
  chatWorkflowCodeNodesNoReason: 'No reason recorded',
  chatWorkflowRepairTitle: 'Independent verification',
  chatWorkflowRepairVerified:
    'Verified: this workflow ran on its own without AI takeover and reached its goal.',
  chatWorkflowRepairNotVerified:
    'Not independently verified yet — saving is not blocked; run AI debug to keep repairing.',
  chatWorkflowRepairFailedNode: ({ nodeId }) => `Failed at node ${nodeId} (the symptom).`,
  chatWorkflowRepairRootCauses: ({ nodes }) => `Root cause node(s): ${nodes}`,
  chatWorkflowRepairHint:
    'Verification never blocks saving. Open AI debug if the workflow still needs repair.',
  chatWorkflowProbeTitle: 'Selector check against the current page',
  chatWorkflowProbeAllOk: ({ count }) =>
    `All ${count} selector${count > 1 ? 's' : ''} match exactly one element.`,
  chatWorkflowProbeUnverified:
    'The current page could not be checked, so these selectors are unverified.',
  chatWorkflowProbeMissing: 'matches nothing — this step will do nothing',
  chatWorkflowProbeAmbiguous: ({ count }) =>
    `matches ${count} elements — the workflow may act on the wrong one`,
  chatWorkflowVerifyRun: 'Verify run after save',
  chatWorkflowVerifyRunHint:
    'Runs the workflow once for real and lets the AI repair failed steps (up to one repair round). Real side effects can happen (orders, posts, sends), and it costs one model call.',
  chatWorkflowVerifyStarted: 'Verify run started — watch it live on the running board.',
  chatWorkflowVerifyPassed: ({ summary }) => `Verify run passed: ${summary}`,
  chatWorkflowVerifyFailed: ({ reason }) => `Verify run failed: ${reason}`,
  chatWorkflowVerifyPending: ({ count }) =>
    `Verify run passed with ${count} AI-repair change${count > 1 ? 's' : ''} awaiting your confirmation.`,
  chatSaveWorkflowAiReview: 'AI refine…',
  chatSaveWorkflowTriggerTitle: 'Trigger',
  chatSaveWorkflowTriggerHintManual: 'This workflow runs only when you start it.',
  chatSaveWorkflowTriggerHintAuto:
    'This trigger fires on its own — the workflow is armed as soon as you save it.',
  chatSaveWorkflowTriggerShortcut: 'Shortcut (e.g. Ctrl+Shift+E)',
  chatSaveWorkflowTriggerMenuName: 'Context-menu item name',
  chatSaveWorkflowTriggerUrl: 'Run on URLs matching',
  chatSaveWorkflowTriggerInterval: 'Every N minutes',
  chatSaveWorkflowTriggerDate: 'Date (YYYY-MM-DD)',
  chatSaveWorkflowTriggerTime: 'Time (HH:MM)',
  chatSaveWorkflowTriggerElementSelector: 'Element selector to watch',
  chatSaveWorkflowTriggerElementPattern: 'Only on URLs matching (optional)',
  chatSaveWorkflowTriggerElementSubtree: 'Include descendants',
  chatSaveWorkflowTriggerElementChildList: 'Content added or removed',
  chatSaveWorkflowTriggerElementAttributes: 'Attributes changed',
  chatSaveWorkflowTriggerElementCharacterData: 'Text changed',
  triggerKindManual: 'Manually',
  triggerKindOnStartup: 'On browser startup',
  triggerKindKeyboardShortcut: 'Keyboard shortcut',
  triggerKindContextMenu: 'Context menu',
  triggerKindVisitWeb: 'When visiting a website',
  triggerKindInterval: 'Interval',
  triggerKindSpecificDay: 'On specific weekdays',
  triggerKindDate: 'On a specific date',
  triggerKindElementChange: 'When an element changes',
  chatFoldTitle: 'Repeated steps',
  chatFoldHint:
    'Folding a repeated run into a loop keeps the workflow readable. A run over different elements needs a selector the page confirms, so it is skipped when the page cannot provide one.',
  chatFoldApply: 'Fold into a loop',
  chatFoldBusy: 'Folding…',
  chatFoldApplied: 'Folded into a loop. Review it in the editor before saving.',
  chatFoldRefused:
    'The page could not confirm a selector for these elements, so nothing was folded.',
  chatWorkflowReviewing: 'AI is reviewing which nodes are worth keeping…',
  chatWorkflowReviewUnavailable: 'AI review unavailable — keeping all steps.',
  chatWorkflowReviewDropped: ({ count }) =>
    `AI dropped ${count} ineffective step${count > 1 ? 's' : ''} (unchecked); check to keep one.`,
  chatWorkflowReviewAllKept: 'AI reviewed every step — none look ineffective.',
  chatWorkflowStepsTitle: 'Steps (uncheck to remove from the workflow)',
  workflowReviewDialogTitle: 'Review steps before saving',
  workflowReviewDialogConfirm: 'Save workflow',
  workflowReviewDialogCancel: 'Cancel',
  workflowReviewDialogRetry: 'Retry review',
  workflowReviewLogTitle: 'Review log',
  workflowReviewLogCollapse: 'Collapse',
  workflowReviewLogExpand: 'Expand',
  workflowReviewLogStart: ({ steps }) =>
    `Sent ${steps} step${steps > 1 ? 's' : ''} to the AI reviewer…`,
  workflowReviewLogFailed: 'Review failed — keeping every step. Click “Retry review” to try again.',

  modeLabel: 'Mode',
  modeChat: 'Chat',
  modeReadonly: 'Read only',
  modeSemi: 'Semi-auto',
  modeFull: 'Full auto',
  modeWorkflow: 'Workflow generate',
  modeChatHint:
    'Plain conversation. No operating rules or tools are sent, so it cannot read or act on the page, and uses the fewest tokens.',
  modeReadonlyHint: 'Can read pages and answer, but cannot click, type, or navigate.',
  modeSemiHint: 'Each action is shown to you for approval before it runs.',
  modeFullHint: 'The agent acts without asking each time. Watch the log.',
  modeFullWarning:
    'Full auto lets the agent click, type, and navigate without each approval. Use only on sites you trust, and review the action history afterwards.',
  modeWorkflowWarning:
    'Workflow generate is NOT a dry run: it drives the real page exactly like full auto — every operator clicks, types and navigates immediately, and JavaScript-code operators run arbitrary code in the page. Use only on sites you trust, and review the generated workflow before running it.',
  modeWorkflowHint:
    'Workflow generate drives the page exactly like full auto: every operator really runs on the page, and only a step that succeeded becomes a node in the draft — no per-step approval. A trigger node is added automatically; when the turn ends the panel pops the save-as-workflow card, where you can change the trigger type.',

  planCardTitle: 'Execution plan',
  planCardGoal: 'Goal',
  planCardSteps: 'Steps',
  planCardRisks: 'Risks',
  planCardSplit: 'Workflow split',
  planApprove: 'Approve & run',
  planRevise: 'Revise plan',
  planFeedbackPlaceholder: 'What should change in this plan?',
  planFeedbackSend: 'Send feedback',
  planApprovedChip: 'Plan approved',
  planRejectedChip: 'Plan rejected',
  planCardAria: 'Plan approval card',
  contextCompacted:
    'Context is large — older turns were summarized to stay within the model window.',
  contextCompactedMarker: '[Context compacted] Summary of the earlier conversation:',

  tokenUsage: 'Token usage',
  tokenTotal: 'Total',
  tokenInput: 'Input',
  tokenOutput: 'Output',
  tokenCached: 'Cached input',
  tokenReasoning: 'Reasoning',
  tokenCacheRate: 'Cache hit rate',
  tokenSession: 'This session',
  tokenLastTurn: 'Last turn',
  tokenNone: 'no usage yet',

  mdCopy: 'Copy',
  mdCopied: 'Copied',
  mdCopyFailed: 'Copy failed',
  mdCodePlain: 'text',

  skillsTitle: 'Skills',
  skillsIntro:
    'A skill is a reusable instruction pack. Pick one in Chat to apply it to the conversation, or let the agent choose by description.',
  skillsEmpty: 'No skills yet. Create one to reuse instructions you type often.',
  skillsAdd: 'New skill',
  skillsName: 'Name',
  skillsNamePlaceholder: 'e.g. Summarise article',
  skillsDescription: 'When to use it',
  skillsDescriptionHint:
    'One line telling the agent when this applies. Used for automatic matching, so be specific.',
  skillsInstructions: 'Instructions',
  skillsInstructionsHint:
    'Added to the system prompt while the skill is active. Write it as directions to the assistant.',
  skillsAutoMatch: 'Let the agent apply this automatically',
  skillsAutoMatchHint:
    'When on, the agent may use this skill on its own if your message matches the description above.',
  skillsSaved: ({ name }) => `Saved “${name}”.`,
  skillsDeleted: ({ name }) => `Deleted “${name}”.`,
  skillsDeleteConfirm: ({ name }) =>
    `Delete skill “${name}”? Its instructions cannot be recovered.`,
  skillsNameRequired: 'Give the skill a name.',
  skillsInstructionsRequired: 'Instructions cannot be empty.',
  skillsNameTaken: 'A skill with that name already exists.',
  skillsUse: 'Use in chat',
  skillsInUse: 'In use',
  skillsStopUsing: 'Stop using',
  skillsBuiltinNote:
    'Skills are stored locally in this browser and are never sent anywhere except as part of your prompt.',

  settingsProviders: 'Model providers',
  settingsProvidersIntro:
    'Any OpenAI-compatible endpoint works — DeepSeek, Volcengine Ark, OpenAI, OpenRouter, or a local Ollama. Pick a preset to prefill the base URL.',
  settingsNoProvider: 'No provider yet. Add one to enable the agent.',
  settingsAddProvider: 'Add a provider',
  settingsChoosePreset: 'Choose a preset…',
  settingsChooseEndpoint: 'Choose preset endpoint…',
  settingsUseThis: 'Use this',
  settingsActive: 'active',
  settingsKeyConfigured: 'key configured',
  settingsNoKey: 'no key — the agent will fail',
  settingsName: 'Name',
  settingsBaseUrl: 'Base URL',
  settingsEndpointPresets: 'Preset endpoint',
  settingsBaseUrlHint:
    'Everything up to but not including /chat/completions. A pasted full URL is trimmed automatically.',
  settingsImageModel: 'Image recognition model',
  settingsModify: 'Edit…',
  settingsImageModelCurrentValue: ({ value }) => `Current: ${value}`,
  settingsImageModelIntro:
    'Select any already-configured provider to reuse its base URL and API key for the recognize_image tool (CAPTCHA, image text). Re-enter a model only if that provider’s default is not vision-capable.',
  settingsImageModelProvider: 'Provider',
  settingsImageModelAuto: 'Auto (use the active chat provider)',
  settingsImageModelFetchNoProvider:
    'Select a provider first — its saved credentials are reused and nothing needs to be re-entered.',
  settingsImageModelProviderMissing:
    'The selected provider is no longer in the list. Pick another provider or “Auto”.',
  settingsImageModelSaved: 'Image recognition model saved.',
  settingsTakeoverModel: 'AI-takeover model (AI 调试)',
  settingsTakeoverModelIntro:
    'Dedicated model for AI debug takeovers — the agent that completes failed workflow steps on the live page. This is a hard multi-round task, so a stronger model here raises the debug success rate. Leave on Auto to use the active chat model.',
  settingsTakeoverOnRun: 'Also allow AI takeover when a plain run fails (uses model calls)',
  settingsTakeoverOnRunIntro:
    'Off by default: plain runs fail fast. When on, a failed node gets one AI takeover episode and any proposed fix lands as pending for your confirmation.',
  settingsTakeoverModelProvider: 'Provider',
  settingsTakeoverModelSelectHint:
    'Pick a model from the dropdown, or keep the provider default. Fetch the list first if it is empty.',
  settingsTakeoverModelSaved: 'AI-takeover model saved.',
  settingsOcrLanguage: 'Local OCR language',
  settingsOcrLanguageIntro:
    'Languages Tesseract.js tries when reading text offline. This runs first, before the image model; if it returns nothing, the image model below is used.',
  settingsSaving: 'Saving…',
  settingsApiKey: 'API key',
  settingsShowKey: 'Show key',
  settingsModel: 'Model',
  settingsModelsAvailable: ({ count }) =>
    `${count} model(s) available — pick one from the dropdown.`,
  settingsImageModelSelectHint:
    'Pick a model from the dropdown, or keep the provider default. Fetch the list first if it is empty.',
  settingsShowAdvanced: 'Show advanced',
  settingsHideAdvanced: 'Hide advanced',
  settingsTemperature: 'Temperature',
  settingsMaxTokens: 'Max tokens',
  settingsProviderDefault: 'provider default',
  settingsExtraHeaders: 'Extra headers JSON',
  settingsTest: 'Test connection',
  settingsTesting: 'Testing…',
  settingsFetchModels: 'Fetch models',
  settingsFetchingModels: 'Loading…',
  settingsKeyStorageNote:
    "Keys are stored in this extension's local storage on this machine only (never synced). Anyone with access to your browser profile can read them.",
  settingsTestOk: ({ name }) => `${name} responded. Key and model both work.`,
  settingsNewProvider: 'New provider',
  settingsEditProvider: 'Edit provider',
  settingsLanguage: 'Language',
  settingsLanguageAuto: 'Automatic (follow browser)',
  settingsKeyPlaceholderLocal: 'any value works locally',
  settingsMaxToolRounds: 'Max action steps per reply',
  settingsMaxToolRoundsHint:
    'The maximum number of actions (clicks, reads, scrolls, …) the agent may take in one turn before it stops to avoid looping. Higher values let long tasks finish on their own; lower values make it check in sooner. Range 1–100.',
  settingsModelsEmpty: 'The endpoint returned an empty model list.',
  settingsModelsFailed: ({ message }) =>
    `${message} — not all gateways expose /models; you can still type the model name.`,
  settingsSaved: ({ name }) => `Saved “${name}”.`,

  settingsContextTitle: 'Model context & tools',
  settingsContextIntro:
    'The system prompt and enabled tool definitions are sent with every request and make up the fixed token cost. Edit or turn off what you do not use to reduce token usage; changes take effect on the next message. Tools are all on by default; the prompt starts at the built-in default.',
  settingsSystemPrompt: 'Operating rules (system prompt)',
  settingsSystemPromptHint:
    'These rules tell the assistant how to behave: when to snapshot, how to fill forms/secrets, to answer in your language, and so on. You can edit it freely. Leave it empty to use the built-in default. The current autonomy mode and available skills are appended automatically.',
  settingsPromptSave: 'Save',
  settingsPromptReset: 'Restore default',
  settingsPromptDefault: 'Using the built-in default prompt.',
  settingsPromptCustom: 'Using your custom prompt. Click “Restore default” to revert.',
  settingsStateDefault: 'default',
  settingsStateCustom: 'custom',
  settingsTools: 'Tools',
  settingsToolsHint:
    'Each enabled tool adds its parameter definition to every request. Disable tools you never use; the assistant simply will not see them.',
  settingsToolsEnableAll: 'Enable all',
  settingsToolsDisableAll: 'Disable all',
  settingsToolsEnabled: 'enabled',
  settingsOperatorTools: 'Workflow operator tools',
  settingsOperatorToolsHint:
    'Workflow-generation mode only. The assistant picks a category and only those tools are sent, which is what keeps each request small. A tool you call from a category that was not sent activates that category automatically.',
  settingsOperatorToolsCore: 'always sent',
  settingsOperatorToolsOnDemand: 'on request',
  settingsOperatorToolsCount: ({ count }) => `${count} tools`,
  settingsOperatorToolsReadOnly:
    'Informational: these are part of workflow generation and cannot be switched off here.',
  toolReadPage: 'Read page text',
  toolReadPageWarn: 'When off: the assistant cannot read the text of the current page.',
  toolSnapshot: 'Snapshot page elements',
  toolSnapshotWarn:
    'When off: the assistant cannot see buttons, links, or fields, so it cannot reliably click or fill anything.',
  toolListTabs: 'List open tabs',
  toolListTabsWarn: 'When off: the assistant cannot see or refer to your other open tabs.',
  toolNetworkRequests: 'Inspect recent network requests',
  toolNetworkRequestsWarn:
    'When off: the assistant cannot diagnose failed or slow requests after page actions.',
  toolConsoleLog: 'Read browser console logs',
  toolConsoleLogWarn:
    'When off: the assistant cannot inspect console errors or logs when debugging page issues.',
  toolClick: 'Click elements',
  toolClickWarn: 'When off: the assistant cannot click buttons or links.',
  toolFill: 'Type into fields',
  toolFillWarn: 'When off: the assistant cannot type text into inputs or textareas.',
  toolSelect: 'Select dropdown options',
  toolSelectWarn: 'When off: the assistant cannot choose options from <select> dropdowns.',
  toolCheckbox: 'Check / uncheck boxes',
  toolCheckboxWarn: 'When off: the assistant cannot tick or untick checkboxes or radio buttons.',
  toolPressKey: 'Press keys',
  toolPressKeyWarn:
    'When off: the assistant cannot press Enter, Tab, Escape, or other keyboard shortcuts.',
  toolScroll: 'Scroll the page',
  toolScrollWarn:
    'When off: the assistant cannot reveal off-screen content (lazy-loaded lists, “View more”, long articles).',
  toolWait: 'Wait for an element',
  toolWaitWarn:
    'When off: the assistant cannot wait for content to appear after a load or navigation.',
  toolOpenUrl: 'Open a URL',
  toolOpenUrlWarn: 'When off: the assistant cannot open a URL directly in the current tab.',
  toolTabNew: 'Open a new tab',
  toolTabNewWarn: 'When off: the assistant cannot open new tabs.',
  toolTabSwitch: 'Switch tabs',
  toolTabSwitchWarn: 'When off: the assistant cannot switch between open tabs.',
  toolTabClose: 'Close a tab',
  toolPinTab: 'Pin a tab for subsequent actions',
  toolPinTabWarn:
    'When off: the assistant must switch tabs before acting on a non-active tab, costing extra steps.',
  toolUnpinTab: 'Remove the tab pin',
  toolUnpinTabWarn:
    'When off: a pinned tab stays pinned until it expires, which may surprise later actions.',
  toolTabCloseWarn: 'When off: the assistant cannot close tabs.',
  toolRunJs: 'Run JavaScript on the page',
  toolRunJsWarn: 'When off: the assistant cannot run custom JavaScript on the page.',
  toolRunPlan: 'Run a planned sequence of steps',
  toolRunPlanWarn:
    'When off: the assistant must confirm or perform each step individually, making multi-step actions slower.',
  toolSaveLocal: 'Save content to a file',
  toolSaveLocalWarn:
    'When off: the assistant cannot save or download content to a file, and may fall back to building a script instead.',
  toolProfile: 'Use saved profile',
  toolProfileWarn:
    'When off: the assistant cannot see your saved name/email/address to auto-fill personal forms.',
  toolListSecrets: 'List saved secrets',
  toolListSecretsWarn:
    'When off: the assistant cannot see your saved key/value secrets by label, so it cannot decide which to fill.',
  toolSecret: 'Fill a saved secret',
  toolSecretWarn:
    'When off: the assistant cannot fill saved passwords or secret fields (you would have to type them).',
  toolSkill: 'Use a skill',
  toolSkillWarn: 'When off: the assistant cannot load or apply saved skills.',
  toolListTasks: 'List scheduled tasks',
  toolListTasksWarn:
    'When off: the assistant cannot tell you which scheduled/recurring tasks are enabled.',
  toolCreateTask: 'Create or update a scheduled task',
  toolCreateTaskWarn:
    'When off: the assistant cannot create or change scheduled/recurring tasks from chat — requests like "run this every morning at 9" fail.',
  toolLoadTools: 'On-demand tool groups',
  toolLoadToolsWarn:
    'When off: the assistant cannot load hidden tool groups (tab management, saving files, saved profile/passwords, skills, network/console diagnostics), so those tasks will fail.',
  toolDelegate: 'Delegate a sub-task to a specialist agent',
  toolDelegateWarn:
    'When off: the supervisor cannot hand sub-tasks to specialist agents; every task is handled directly in the main conversation.',
  toolAskUser: 'Ask the user a clarifying question',
  toolAskUserWarn:
    'When off: the assistant cannot ask you to clarify unclear requests and must guess instead.',
  toolPresentPlan: 'Submit an execution plan for approval',
  toolPresentPlanWarn:
    'When off: the plan-first flow cannot show its plan card, so tasks run without your plan approval.',
  toolOperator: 'Workflow operator (draft writer)',
  toolOperatorWarn:
    'When off: this operator tool is hidden from the chat in workflow mode and cannot be added to the generated workflow.',

  toolRecognizeImage: 'Recognize text in an image (CAPTCHA, etc.)',
  toolRecognizeImageWarn:
    'When off: the assistant cannot read text out of a CAPTCHA or other image on the page using the image model.',
  toolScreenshot: 'Capture an element or the page and inspect the image',
  toolScreenshotWarn:
    'When off: the assistant cannot screenshot a page element or captcha and send the image to a vision model for visual inspection.',
  toolCreateSkill: 'Create or update a skill',
  toolCreateSkillWarn:
    'When off: the assistant cannot author and save a reusable skill directly (the built-in skill-generator would fail).',

  settingsPageAccess: 'Page access',
  settingsPageAccessIntro:
    'The assistant reads a page by injecting a one-off read-only script, so it only works on ordinary http(s) tabs — not on chrome:// pages, the Web Store, or local files.',
  settingsCheckTab: 'Check active tab',
  settingsPageReadable: ({ title }) => `The active tab can be read: ${title}`,
  settingsPageBlocked: ({ reason }) => `The active tab cannot be read. ${reason}`,

  settingsStorage: 'Storage location',
  settingsStorageIntro:
    'Chats, workflows, history, skills, agents and other data are saved as plain JSON files in a folder you choose. Extension settings (model providers, the folder choice itself) stay in browser storage. While the folder is briefly unreachable, changes queue up and flush into it automatically once access is restored.',
  settingsStorageBrowser: 'Browser storage (default)',
  settingsStorageFile: 'Files on your computer',
  settingsStorageFolder: ({ name }) => `Folder: ${name}`,
  settingsChooseFolder: 'Choose folder',
  settingsChangeFolder: 'Change folder',
  settingsReconnectFolder: 'Reconnect folder',
  settingsUseBrowserStorage: 'Use browser storage',
  settingsStorageUnsupported: 'This browser does not support saving to a folder.',
  settingsStorageSynced: ({ name }) => `Data saved to ${name}.`,
  settingsStorageNeedReconnect: ({ name }) =>
    `The folder "${name}" was chosen but access expired. Reconnect it to keep saving files.`,
  settingsStoragePendingWrites: ({ count }) =>
    `${count} change${count === 1 ? '' : 's'} waiting to be written to the folder — they flush automatically once it is reconnected.`,

  settingsDownloadDir: 'Download folder',
  settingsDownloadDirIntro:
    'Exported files (such as full conversation transcripts) are saved to a folder you choose. Pick one to enable automatic downloads.',
  settingsDownloadDirFolder: ({ name }) => `Download folder: ${name}`,
  settingsDownloadDirNone: 'No download folder configured.',
  settingsDownloadDirDone: ({ name }) => `Download folder set: ${name}.`,
  settingsDownloadDirFailed: 'Could not set the download folder.',
  settingsDownloadDirDisconnect: 'Disconnect',
  settingsDownloadAutoSave: 'Automatically save exports to this folder',

  settingsLocalAgent: 'Local agent access',
  settingsLocalAgentIntro: 'Connect to the local MCP adapter that coding agents auto-spawn.',
  settingsLocalAgentEnable: 'Allow localhost pages to control the browser',
  settingsLocalAgentConfigure: 'Configure connection',
  settingsLocalAgentUrl: 'Adapter address',
  settingsLocalAgentUrlPlaceholder: 'ws://127.0.0.1:8765',
  settingsLocalAgentToken: 'Shared token (optional)',
  settingsLocalAgentTokenPlaceholder: 'Leave empty to trust localhost only',
  settingsLocalAgentStatusConnected: 'Connected',
  settingsLocalAgentStatusConnecting: 'Connecting…',
  settingsLocalAgentStatusDisconnected: 'Not connected',
  settingsLocalAgentStatusError: ({ error }) => `Error: ${error}`,
  settingsLocalAgentErrorRefused:
    'Adapter not running: the MCP adapter lives only while your coding-agent session runs. The plugin reconnects automatically (within ~30 s); run `node mcp-server.mjs --standalone` to keep it connected all the time.',
  settingsLocalAgentBindingsTitle: 'Assign connections to windows',
  settingsLocalAgentBindingsHint:
    'Each connection acts only inside its assigned window. Once any assignment exists, unassigned connections are refused — assign them here, from the window they should use. With zero assignments every connection uses the latest plugin window. Running several agents in the same project folder? give each a unique BROWSER_COPILOT_AGENT_NAME.',
  settingsLocalAgentBindingUnassigned: 'Unassigned',
  settingsLocalAgentBindingThisWindow: 'this window',
  settingsLocalAgentBindingClosed: ({ id }) => `#${id} · closed`,
  settingsLocalAgentBindingDuplicate:
    'Several connections share this name — the assignment applies to all of them. Set a unique BROWSER_COPILOT_AGENT_NAME for each agent to tell them apart.',
  settingsLocalAgentBindingStale: 'Disconnected assignments',
  settingsLocalAgentBindingRemove: 'Remove',
  settingsLocalAgentAgentsConnected: ({ count }) =>
    `${count} connection${count === 1 ? '' : 's'} connected`,
  settingsLocalAgentMcpTitle: 'MCP config',
  settingsLocalAgentMcpHint:
    'Add ONE stdio MCP server; it auto-spawns the adapter and the plugin connects automatically. The adapter only lives while the agent session runs — use `node mcp-server.mjs --standalone` for an always-on connection.',
  settingsLocalAgentMcpTabClaude: 'Claude Code',
  settingsLocalAgentMcpTabCodex: 'Codex',
  settingsLocalAgentMcpTabTrae: 'Trae',
  settingsLocalAgentExportTitle: 'Adapter script (mcp-server.mjs)',
  settingsLocalAgentExportIntro:
    'On a release package? Export the adapter once — no source download needed — and the snippets below are filled with its real path automatically.',
  settingsLocalAgentExport: 'Export adapter',
  settingsLocalAgentReexport: 'Re-export',
  settingsLocalAgentExporting: 'Exporting…',
  settingsLocalAgentExportedTo: ({ path }) => `Exported to: ${path}`,
  settingsLocalAgentExportFailed: 'Could not export the adapter:',
  settingsLocalAgentMcpPlaceholderHint:
    'Export the adapter with the button above to auto-fill the path, or replace __插件目录__ with its absolute path yourself.',
  settingsLocalAgentMcpExportedHint:
    'The snippets point at the exported adapter. Re-export it once after upgrading the plugin to keep them in sync.',
  settingsLocalAgentCopy: 'Copy',
  settingsLocalAgentCopied: 'Copied ✓',
  settingsLocalAgentWarning:
    'While enabled, any page on this machine can drive the browser. Only enable it while your local agent is running.',

  dataTitle: 'Personal data',
  dataIntro:
    'Saved profiles and credentials are stored locally and only sent to the model as part of a request you approve. The agent uses them to fill forms so you do not have to retype them.',
  dataProfiles: 'Profiles',
  dataProfilesIntro:
    'Name, email, phone, address and other values the agent can use to fill forms automatically.',
  dataProfilesEmpty: 'No profile yet. Add one to speed up form filling.',
  dataAddProfile: 'New profile',
  dataProfileLabel: 'Label (e.g. Personal, Work)',
  dataFullName: 'Full name',
  dataFirstName: 'First name',
  dataLastName: 'Last name',
  dataEmail: 'Email',
  dataPhone: 'Phone',
  dataAddress: 'Address',
  dataCity: 'City',
  dataState: 'State / Province',
  dataPostalCode: 'Postal code',
  dataCountry: 'Country',
  dataCompany: 'Company',
  dataJobTitle: 'Job title',
  dataCustomFields: 'Custom fields',
  dataCustomFieldsHint: 'One "key = value" per line, e.g. birthday = 1990-01-01',
  dataPasswords: 'Passwords & identities',
  dataPasswordsIntro:
    'Saved credentials the agent can fill into login forms. The password value is never shown to the model — it is filled directly after you approve.',
  dataPasswordsEmpty: 'No credentials yet. Add one to enable one-tap login filling.',
  dataAddPassword: 'New credential',
  dataPasswordLabel: 'Label (e.g. GitHub, Work)',
  dataPasswordUrl: 'Site URL (optional)',
  dataPasswordUsername: 'Username / email',
  dataPasswordValue: 'Password',
  dataPasswordNotes: 'Notes (optional)',
  dataPasswordStorageNote:
    "Credentials are stored in this extension's local storage on this machine (never synced). Anyone with access to your browser profile can read them — do not save high-value passwords on a shared device.",
  dataSecrets: 'Secrets & fields',
  dataSecretsIntro:
    'Store any key/value credentials the agent can fill into forms (username, password, CVV, security answers, etc.). Add as many fields as a site needs.',
  dataSecretsEmpty: 'No secrets yet. Add one to let the agent fill login fields.',
  dataAddSecret: 'Add secret',
  dataSecretLabel: 'Label (e.g. GitHub, Work)',
  dataSecretUrl: 'Site URL (optional)',
  dataSecretFields: 'Fields',
  dataSecretAddField: 'Add field',
  dataSecretFieldKey: 'Field name',
  dataSecretFieldValue: 'Value',
  dataSecretMaskValue: 'Mask as password',
  dataShowPassword: 'Show / hide',
  dataHistory: 'Action history',
  dataHistoryIntro:
    'A log of every page action the agent performed, so you can review or delete what happened.',
  dataHistoryEmpty: 'No actions recorded yet.',
  dataClearHistory: 'Clear all',
  dataHistoryToWorkflow: 'Save as workflow',
  dataHistoryToWorkflowDone: 'Saved the action steps as a workflow.',
  dataHistoryToWorkflowEmpty: 'No rebuildable workflow steps in this group.',
  dataHistoryWhen: 'When',
  dataConversation: 'Conversation',
  dataDeclined: 'declined',
  dataUsed: ({ count }) => `used ${count}×`,

  convTitle: 'Conversations',
  convNew: 'New chat',
  convRename: 'Rename',
  convDelete: 'Delete',
  convUntitled: 'New conversation',
  convDeleteConfirm: 'Delete this conversation and its messages?',
  convHistory: 'History',
  convHistoryEmpty: 'No past conversations yet.',
  convContinue: 'Open',
  convPreview: 'Preview',
  convUpdated: 'Updated',

  confirmActionHint: 'The assistant wants to perform the action below. Approve to let it run once.',

  errorPanelCrashed: 'The panel hit an unexpected error and stopped rendering.',
  errorWhatHappened: 'What happened',
  errorVersionSkew:
    'If this began right after an update, the extension and this panel may be running different versions. Reload the extension in chrome://extensions, then reopen the panel.',
  errorTemperatureNumber: 'Temperature must be a number.',
  errorMaxTokensInteger: 'Max tokens must be a positive whole number.',
  errorHeadersJson: 'Extra headers must be valid JSON.',
  errorHeadersObject: 'Extra headers must be a JSON object.',

  // --- New: chat message actions (en) ---
  msgCopy: 'Copy',
  msgCopied: 'Copied',
  msgCopyFailed: 'Copy failed',
  msgDownload: 'Download',
  msgDownloadAs: 'Download as',
  msgDownloadMd: 'Markdown (.md)',
  msgDownloadTxt: 'Plain text (.txt)',
  msgDownloadHtmlPdf: 'HTML / PDF (print)',
  msgDownloadCsv: 'CSV (.csv)',
  msgDownloadUntitled: 'conversation',
  msgDownloadHtmlHint: 'Open the downloaded HTML and use the browser Print dialog to save as PDF.',
  msgTokenUsage: 'Token usage',

  // --- New: inline token bar (en) ---
  tokenBarSession: 'Session',
  tokenBarLastTurn: 'Last turn',
  tokenBarT: 'Total',
  tokenBarI: 'Input',
  tokenBarO: 'Output',
  tokenBarR: 'Reasoning',
  tokenBarC: 'Cached',
  tokenBarDash: '-',

  // --- New: in-chat generated skill saving (en) ---
  skillGeneratedPreview: 'Detected a new skill in this reply. Save it to reuse?',
  skillSave: 'Save skill',
  skillSaveEdit: 'Edit & save',
  skillDiscard: 'Dismiss',
  skillSavedBanner: ({ name }) => `Skill “${name}” saved. You can now pick it in Chat.`,
  skillAutoMatch: 'Allow the agent to select this skill automatically',
  skillName: 'Name',
  skillDescription: 'When to use it',
  skillInstructions: 'Instructions',

  // --- New: skills tab import / export (en) ---
  skillsImport: 'Import',
  skillsImportHint: 'Drag & drop a .json / .yaml / .md skill file here, or click Import.',
  skillsImportFile: 'Choose file',
  skillsImportResultOk: ({ count }) => `Imported ${count} skill${count === 1 ? '' : 's'}.`,
  skillsImportResultFail: ({ ok, failed }) =>
    `Import finished: ${ok} succeeded, ${failed} failed. Review problems above.`,
  skillsExportAll: 'Export all',
  skillsImportNameTaken: ({ name }) => `Skipped “${name}”: a skill with this name already exists.`,

  agentsTitle: 'Agents',
  agentsIntro:
    'Agents are delegated workers. The supervisor splits a large task and hands scoped sub-tasks to specialist agents; small tasks are always done directly. Built-in agents can be edited directly and restored to defaults anytime.',
  agentsEmpty: 'No agents yet. Create one, or the built-in agents appear after a reload.',
  agentsAdd: 'New agent',
  agentsImport: 'Import',
  agentsImportHint: 'Import agent files (.json, .yaml, .md) — or drop them anywhere on this tab.',
  agentsExport: 'Export all',
  agentsBuiltinNote:
    'Built-in agents ship with the extension. You can edit them in place; “Restore default” brings the shipped version back.',
  agentsReset: 'Restore default',
  agentsBuiltinBadge: 'Built-in',
  agentsSpecialistPill: 'Specialist',
  agentsDelegatablePill: 'Can delegate',
  agentsToolsCount: ({ count }) => (count === 0 ? 'All tools' : `${count} tools`),
  agentsImportResultOk: ({ count }) => `Imported ${count} agent${count === 1 ? '' : 's'}.`,
  agentsImportResultFail: ({ ok, failed }) =>
    `Import finished: ${ok} succeeded, ${failed} failed. Review problems above.`,
  agentsImportNameTaken: ({ name }) => `Skipped “${name}”: an agent with this name already exists.`,
  agentRole: 'Role',
  agentRoleSupervisor: 'Supervisor (splits and delegates big tasks)',
  agentRoleSpecialist: 'Specialist (executes delegated tasks)',
  agentDomain: 'Specialty',
  agentDomainSearch: 'Search / research',
  agentDomainWriting: 'Writing',
  agentDomainOperations: 'Operations',
  agentDomainWorkflow: 'Workflow generation',
  agentDomainAnalysis: 'Analysis',
  agentDomainCustom: 'Custom',
  agentHint: 'When to delegate it',
  agentHintHint:
    'One or two sentences the supervisor matches on. Only this text (never the instructions) is shown when deciding what to delegate.',
  agentTools: 'Allowed tools',
  agentToolsHint:
    'Whitelist of tools this agent may call. Empty = inherit every tool available in the session.',
  agentToolsInherit: 'Empty list: inherits all tools',
  agentSkills: 'Linked skills',
  agentSkillsHint: 'Selected skills are injected into this agent’s system prompt.',
  agentDelegatable: 'Allow this agent to split and delegate to specialist agents',
  agentDelegatableHint: 'Only supervisors delegate; specialist agents can never delegate further.',
  agentMaxRounds: 'Max tool rounds per delegation',
  agentSaved: ({ name }) => `Agent “${name}” saved.`,
  agentDeleted: ({ name }) => `Agent “${name}” deleted.`,
  agentsDeleteConfirm: ({ name }) =>
    `Delete agent “${name}”? Its configuration cannot be recovered.`,
  agentResetDone: ({ name }) => `Restored the built-in agent “${name}” to its defaults.`,
  agentNameRequired: 'Name is required.',
  agentInstructionsRequired: 'Instructions are required.',
  agentNameTaken: 'This name is already used by another agent.',

  // Built-in agent i18n (English values mirror builtin-agents.ts defaults)
  builtinAgentSupervisorDisplayName: 'Supervisor',
  builtinAgentSupervisorHint:
    'Owns the full request; delegates big multi-domain tasks to specialists.',
  builtinAgentSupervisorInstructions: `You are the supervisor agent for this Browser Copilot session.

- You own the user's whole request and are accountable for the final answer.
- Small, single-domain requests: just execute them with your own tools.
- Big, multi-part requests: hand scoped sub-tasks to the specialist agents,
  strictly following the delegation rules below.
- Specialists only see what you hand them. Pick the upstream outputs they need;
  never forward a raw transcript. They return compressed reports, not traces.
- Judge every report against the original goal before using it: a report is
  material you verify, not an answer you forward verbatim.
- Integrate the accepted reports into ONE coherent answer yourself. The user
  should not have to read the sub-results or know how the work was split.
- Page actions still require the user's approval through the panel; delegating
  a task never bypasses that.`,
  builtinAgentSearchExpertDisplayName: 'Search Expert',
  builtinAgentSearchExpertHint:
    'Web/page research: browses pages and returns the most relevant findings with URLs. For information gathering, fact-finding, comparing options — never long-form writing.',
  builtinAgentSearchExpertInstructions: `You are the search specialist.

Scope: finding and verifying information on open pages and the web. You do
NOT write long articles, do not operate forms beyond simple search boxes,
and do not change site state.

Process:
1. Open the relevant page or search entry point yourself (the supervisor does
   not hand you page content).
2. Browse and read what is needed; follow links only while they stay on topic.
3. Stop as soon as you have enough; do not explore for completeness.

Report format — return at most 10 results, each one line:
- [{n}] {title} — {url}
  snippet: ≤200 characters of the actually relevant content
  why: one short clause on why it answers the task

No prose beyond this list. No long quotes. If you could not complete the
search, say what you tried and what is missing.`,
  builtinAgentCopywriterDisplayName: 'Copywriter',
  builtinAgentCopywriterHint:
    'Drafts written deliverables (posts, emails, docs, copy) from the brief and material handed to it. Pure generation, no browsing — give it the sources, get an outline and a draft.',
  builtinAgentCopywriterInstructions: `You are the writing specialist. You have no browser tools: everything you
need must come from the task brief and the upstream context the supervisor
provides. If that material is insufficient, say exactly what is missing
instead of inventing facts.

Process:
1. Restate the goal in one line: audience, format, tone, length limit.
2. Produce a short outline first (headings / beats).
3. Then write the full piece, matching the requested voice and constraints.
4. Self-check against the brief before returning.

Deliverable handling:
- The full draft is the deliverable. When it is long (a full article, a
  multi-section document), save it with save_local and return the filename.
- Your returned message then holds: 3 bullet takeaways + the filename.
- For short deliverables the whole text fits in the returned message.

Never pad: no disclaimers, no "certainly", no meta-commentary about the
writing process.`,
  builtinAgentOpsExpertDisplayName: 'Operations Expert',
  builtinAgentOpsExpertHint:
    'Hands-on site operations: form fills, posting/publishing flows, routine back-office clicks, using saved profile and credentials. For performing an action sequence, not research or writing.',
  builtinAgentOpsExpertInstructions: `You are the operations specialist: you perform concrete action sequences on
behalf of the user on pages they are logged into.

Safety rules:
- BEFORE acting, list the plan: one line per step naming the page and the
  exact action ("Open the publishing form", "Fill title field"). The user
  approves each page-changing action through the panel.
- Never invent values: use the task brief, the saved profile
  (get_my_profile), or a saved credential referenced BY LABEL.
- With list_secrets/get_secret you only ever see labels and fill results.
  Never print, log, repeat, or write a secret value into any field other
  than the one the credential is meant for.
- Destructive or irreversible actions (delete, publish, pay, submit a
  contract) require the action to be explicit in the task; if it is not,
  stop and report what confirmation you would need.

Report: what was done, in order, with the resulting page state / URL. List
anything skipped and why. Do not paste secret values anywhere.`,
  builtinAgentWorkflowExpertDisplayName: 'Workflow Expert',
  builtinAgentWorkflowExpertHint:
    'Turns a procedure into a saved Browser Copilot workflow (operator/block nodes, keep/drop calls). Use for "make this a workflow / automate this procedure / which block does X".',
  builtinAgentWorkflowExpertInstructions: `You are the workflow generation specialist.

Your domain expertise is the "workflow-generator" skill, which is already
loaded below — follow it exactly: it defines the operator catalog, the
conversation-action to operator mapping, and the node keep/drop criteria.

Read scheduled tasks and live network/console observations only when they
help decide trigger configuration or debug a node. Your output is the node
and edge data plus the per-step rationale described by the skill.`,
  builtinAgentAnalystDisplayName: 'Analyst',
  builtinAgentAnalystHint:
    'Conclusions-first analysis of a page and its network/console evidence, every claim sourced. For diagnosing a page issue or extracting a verdict from page evidence.',
  builtinAgentAnalystInstructions: `You are the analysis specialist: your product is a verdict backed by
evidence, not a walkthrough.

Rules:
- Conclusion first: at most 5 numbered findings, most important first.
- Every finding carries its source: a URL, a network request (method +
  endpoint + status), or a console message. No unsourced claims.
- No process narration, no speculation presented as fact. State confidence
  briefly when evidence is thin.
- Read the page and the network/console logs yourself; the supervisor does
  not hand you page dumps.
- If the evidence is insufficient, return status partial: give the findings
  you DO have and list exactly what additional evidence is needed.

Keep the whole report dense and within the message size cap.`,

  // Workflow generation dialog
  workflowGenerationTitle: 'Workflow generation',
  workflowGenerationUnderstanding: 'Understanding the task and confirming the target outcome…',
  workflowGenerationWorking: 'Performing the task…',
  workflowGenerationRecovering: 'Recovering from a failed action…',
  workflowGenerationCompiling: 'Compiling the workflow…',
  workflowGenerationValidating: 'Validating and hardening the workflow…',
  workflowGenerationReady: 'Workflow ready',
  workflowGenerationPreparing: 'Preparing workflow…',
  workflowGenerationPreparingHint:
    'Compiling and validating the recorded steps. This can take a few seconds.',
  workflowGenerationSaved: 'Workflow saved',
  workflowGenerationCancel: 'Cancel generation',
  workflowGenerationBackground: 'Run in background',
  workflowGenerationClose: 'Close',
  workflowGenerationError: 'Generation failed',
  workflowGenerationSave: 'Save workflow',
  workflowGenerationEdit: 'Edit',
  workflowGenerationDismiss: 'Cancel',
  workflowGenerationReopen: 'Open save dialog',
  workflowGenerationSavedDetail: 'The workflow was saved and is ready to run.',
  workflowGenerationActionCount: ({ count }) => `${count} action(s) performed`,
  workflowGenerationLogTitle: ({ count }) => `Generation log (${count})`,
  workflowGenerationRecoveredCount: ({ count }) => `${count} issue(s) recovered`,

  // Workflow repair
  workflowRepairStarting: 'Starting automatic repair…',
  workflowRepairDiagnosing: 'Analyzing the failed step…',
  workflowRepairApplying: 'Applying the repair…',
  workflowRepairVerifying: 'Verifying the repair…',
  workflowRepairSuccess: 'Workflow auto-repaired',
  workflowRepairExhausted: 'Automatic repair exhausted',
  workflowRepairBlocked: 'Human action required',
  workflowRepairNeedHuman: 'Take over manually',
  workflowRepairAutoTitle: 'AI is auto-repairing…',
  workflowRepairVerifiedDetail: 'Verification passed: the workflow runs independently.',
  workflowRepairRevisionCommitted: ({ revision }) => `Committed as revision ${revision}.`,
}

const zhCN: Messages = {
  chatWorkflowNotRunnable: (detail) =>
    `生成的工作流未通过可运行性检查，暂时没有可保存的内容：${detail}。请让 AI 修复后重试。`,
  chatWorkflowRegenerate: '重新生成工作流',
  chatWorkflowRegenerateHint: '把缺失步骤反馈给 AI，再跑一轮生成。',
  chatWorkflowRegeneratePrompt: (detail) =>
    `生成的工作流缺少产出数据的步骤，无法运行：${detail}。请先补加读取步骤（wf_op_get-text / wf_op_read-page / wf_op_attribute-value / wf_op_ai-agent），让每个被引用的值都有对应的生产者节点，并把它们接在消费节点之前，然后再结束回合。不要把页面内容直接当字面量粘贴。`,
  tabChat: '对话',
  tabSkills: '技能',
  tabAgents: '智能体',
  tabTasks: '任务',
  tabWorkflows: '工作流',
  tabData: '数据',
  tabSettings: '设置',
  tabHistory: '历史',
  tabMore: '更多',
  panelMinimize: '最小化为悬浮按钮',
  uploadFileWaiting: '工作流正在等待你选择文件。',
  uploadFileChoose: '选择文件',
  uploadFileReading: '正在读取文件…',
  windowPickTitle: '选择要操作的窗口',
  windowPickHint: '一个后台任务需要确定在哪个浏览器窗口中执行。',
  windowPickBadgeThisPanel: '本面板',
  windowPickBadgeMinimized: '已最小化',
  settingsWindowPolicyLabel: '无人值守目标窗口',
  settingsWindowPolicyLatest: '最近使用的插件窗口（自动）',
  settingsWindowPolicyAsk: '每次询问',
  settingsWindowPolicyFixed: '固定窗口',
  settingsWindowPolicyHelp:
    '当多个窗口开着插件时，指定 agent 接入 / 定时任务 / 飞书任务在哪个窗口执行。它们只会在“插件开着”（面板展开或最小化）的窗口中操作；所有窗口都关闭插件时，回退到原有全局行为。',
  settingsWindowPolicyFixedWindow: '固定窗口',

  // History tab
  histConversations: '对话记录',
  histTasks: '任务记录',
  histWorkflows: '工作流记录',
  histOperations: '操作记录',
  histEmpty: '暂无记录',
  histBatchDelete: '批量删除',
  histDeleteSelected: '删除选中',
  histSelectAll: '全选',
  histDeleteConfirm: ({ count }) => `确认删除选中的 ${count} 条记录？此操作不可撤销。`,
  histWorkflowRuns: '工作流运行历史',
  histTaskRuns: '任务运行历史',
  histDetailTitle: '执行步骤',
  histEmptyRuns: '暂无运行记录',
  histOutcomeOk: '成功',
  histOutcomeFailed: '失败',
  histOutcomeCancelled: '已取消',
  histOutcomeSkipped: '已跳过',
  histArgs: '参数',
  histNoSteps: '暂无步骤记录',

  tasksTitle: '运行任务',
  tasksSubtitle: '按计划运行任务，并可通过飞书通知结果。定时任务仅在浏览器打开时触发。',
  taskNew: '新建任务',
  taskName: '名称',
  taskKind: '做什么',
  taskKindGithub: '统计 GitHub 上待我 review 的 PR',
  taskKindPrompt: '运行一条智能体提示词',
  taskKindWorkflow: '运行已保存的工作流',
  taskPrompt: '提示词',
  taskPromptHint: '无人值守时智能体执行的指令。',
  taskWorkflow: '工作流',
  taskWorkflowPlaceholder: '选择工作流',
  taskWorkflowHint: '此计划将无人值守运行所选工作流。',
  taskSchedule: '时间',
  taskSchedDaily: '每天',
  taskSchedWeekdays: '工作日（周一至周五）',
  taskSchedWeekly: '每周指定日',
  taskSchedInterval: '每隔',
  taskSchedManual: '手动',
  taskManualHint: '不自动运行，通过「立即运行」按钮或飞书指令手动触发。',
  taskManualChip: '手动任务',
  taskEvery: '每隔',
  taskMinutes: '分钟',
  taskMaxRounds: '最大调用轮数',
  taskMaxRoundsHint: '该任务无人值守时最多进行多少轮"模型↔工具"往返。独立于全局设置，默认 50。',
  taskDaysAll: '每天',
  taskDaysWeekdays: '工作日',
  taskDaysWeekend: '周末',
  taskClearFinished: '清空',
  taskDeleteFinishedConfirm: '从看板移除这条已完成记录？',
  taskClearFinishedConfirm: '清空看板上所有已完成记录？',
  taskNotifyFeishu: '完成后通过飞书通知',
  taskEnabled: '启用',
  taskRunNow: '立即运行',
  taskLastRun: '上次运行',
  taskNever: '从未',
  taskStatusOk: '成功',
  taskStatusFailed: '失败',
  taskStatusSkipped: '已跳过',
  taskSave: '保存任务',
  taskSaved: '任务已保存。',
  taskDeleteConfirm: '删除这个任务？相关的运行记录也会一并删除。',
  taskRuns: '最近运行',
  taskRunsEmpty: '还没有运行记录。',
  taskRunsClear: '清空',
  taskTriggerSchedule: '定时',
  taskTriggerManual: '手动',
  taskTriggerFeishu: '飞书',
  taskTriggerChat: '对话',
  tasksRunning: '运行中',
  tasksRunningEmpty: '当前没有运行中的任务。可从对话、定时或飞书发起。',
  tasksActivity: '动态',
  tasksMine: '我的任务',
  tasksEmpty: '还没有任务，新建一个开始吧。',
  tasksFeishuSection: '飞书集成',
  tasksRunHistory: '运行历史',
  tasksRecentlyFinished: '最近完成',
  taskOutcomeOk: '成功',
  taskOutcomeFailed: '失败',
  taskOutcomeCancelled: '已终止',
  taskOutcomeSkipped: '已跳过',
  taskUntitled: '未命名',
  taskTerminate: '终止',
  taskCancelling: '正在终止…',
  taskStartedAt: '开始于',
  taskSourceChat: '对话',
  taskSourceSchedule: '定时',
  taskSourceManual: '手动',
  taskSourceFeishu: '飞书',
  tasksFeishuTitle: '飞书',
  tasksFeishuWebhook: '自定义机器人 Webhook 地址',
  tasksFeishuWebhookSecret: 'Webhook 签名校验密钥（如启用）',
  tasksFeishuSecretHint: '仅当机器人开启了签名校验时需要。',
  tasksFeishuBot: '允许飞书机器人触发任务',
  tasksFeishuAppId: 'App ID',
  tasksFeishuAppSecret: 'App Secret',
  tasksFeishuBotHint:
    '需要一个开启了长连接模式的企业自建应用。给机器人发消息可以运行同名任务，也可以直接说需求（例如"查一下微博热搜"），智能体会打开页面并回答。断线会自动重连，浏览器唤醒后约一分钟内恢复连接。',
  tasksFeishuTest: '发送测试消息',
  tasksFeishuTestOk: '测试消息已发送。',
  tasksFeishuBotWarn:
    '浏览器完全空闲或电脑睡眠时扩展无法被触达，唤醒后约一分钟内会自动重连。若需要真正始终在线的远程控制，建议增加一个小型中继服务。',
  taskTemplateGithubName: '待我 review 的 PR',

  workflowsEmpty: '还没有工作流，创建一个开始自动化。',
  workflowsNew: '新建',
  workflowsRunNow: '运行',
  workflowsEdit: '编辑',
  workflowsDeleteConfirm: '删除该工作流？',
  workflowsTriggerManual: '手动',
  workflowsTriggerScheduled: '定时',
  workflowsTriggerContextMenu: '右键菜单',
  workflowsTriggerVisitWeb: '访问网页',
  workflowsTriggerGithub: 'GitHub',
  workflowsTriggerFeishu: '飞书',
  workflowsTriggerInterval: '定时间隔',
  workflowsTriggerDate: '指定日期',
  workflowsTriggerSpecificDay: '每周定时',
  workflowsTriggerStartup: '浏览器启动',
  workflowsTriggerShortcut: '快捷键',
  workflowsTriggerElementChange: '元素变化',
  workflowsTriggerNone: '无触发器',
  workflowsLastRun: '上次运行',
  workflowsRunHistory: '运行历史',
  workflowsRunStatusNever: '未运行',
  workflowsExport: '导出',
  workflowsImport: '导入',
  workflowsImportInvalid: '无效的工作流文件：至少一个导出无法读取。',
  workflowsImported: ({ count }) => `已导入 ${count} 个工作流。`,
  workflowsSelectAll: '全选',
  workflowsBatchDelete: '删除选中的工作流',
  workflowsBatchDeleteConfirm: ({ count }) => `确定删除选中的 ${count} 个工作流？此操作不可恢复。`,
  workflowsBatchDeleteDone: ({ count }) => `已删除 ${count} 个工作流。`,
  workflowsRunFailedHint: '运行失败 — 点击查看历史详情',
  // M4：从最后一个干净完成的步骤之后重跑，跳过已完成的步骤（登录/提交不会重复执行）。
  workflowsResume: '继续运行',
  workflowsResumeTitle:
    '从最后一个已完成的步骤之后继续——已完成的步骤会被跳过，因此已经执行过的登录或提交不会重复。',
  workflowsResumeNone: '没有可恢复的进度，本次将从头开始运行',
  workflowsResumedOk: ({ step }) => `已从第 ${step} 步之后继续并跑完剩余流程`,
  workflowsDebug: 'AI 调试',
  workflowsDebugging: 'AI 调试中…',
  workflowsDebugOkNoChanges: '运行成功，无需调试',
  workflowsDebugRewriteVerified: ({ count }) =>
    `AI 已重建工作流并通过验证（${count} 项变更待确认）`,
  workflowsDebugRewriteConfirmTitle: '应用 AI 重建的工作流？',
  workflowsDebugRewriteConfirmMessage: ({ diagnosis }) =>
    `AI 已像聊天一样复演了整个任务，并审计了工作流图（哪些节点不对/缺失/多余/需兜底），生成了可独立运行的新版本。应用后将替换当前流程图。诊断：${diagnosis}`,
  workflowsDebugRewriteApply: '应用重建的工作流',
  workflowsDebugRewriteApplied: '已应用 AI 重建的工作流',
  workflowsRewriteRiskTitle: '高风险整图重写——确认继续？',
  workflowsRewriteRiskMessage: ({ level }) =>
    `此次整图重写的风险等级为 ${level}，会删除或替换核心结构（例如触发器或目标）。请确认了解后果后再应用。`,
  workflowsRewriteRiskAccept: '我了解风险——仍然应用',
  workflowsDebugVerified: ({ count }) =>
    `已验证：修复后的流程无需 AI 也能跑通（${count} 处修改待确认）`,
  workflowsDebugNotVerified: '本次运行靠 AI 救回，但修复未通过验证——请仔细确认后再应用',
  workflowsDebugStats: ({ rate, total }) => `接管成功率：${total} 次中 ${rate}%`,
  workflowsDebugSessionStats: ({ rate, total, p50 }) =>
    `修复后无需 AI 即可跑通：${total} 次会话中 ${rate}% · 中位耗时 ${p50}ms`,
  workflowsDebugReasonAuth: '需要登录',
  workflowsDebugReasonCaptcha: '验证码',
  workflowsDebugReasonNotfound: '元素未找到',
  workflowsDebugReasonTimeout: '超时',
  workflowsDebugReasonNetwork: '网络',
  workflowsDebugReasonOther: '其他',
  workflowsDebugReasonUnclassified: '未分类',
  workflowsDebugFailed: 'AI 调试未能修复该工作流',
  workflowsDebugTakeoverDone: ({ count }) => `运行成功：AI 接管完成了 ${count} 个失败节点`,
  workflowsDebugLogTitle: 'AI 调试日志',
  workflowsDebugLogLive: '进行中',
  workflowsDebugLogDone: '已结束',
  workflowsDebugLogEmpty: '等待调试步骤…',
  workflowsDebugLogClose: '关闭',
  workflowsDebugTakeoverConfirmTitle: '应用 AI 接管的节点修改？',
  workflowsDebugTakeoverConfirmMessage:
    'AI 接管已在页面上完成失败步骤，并为相关节点生成了修改建议（让以后运行无需 AI 也能通过）。是否将这些修改应用到工作流？',
  workflowsDebugTakeoverApply: '应用修改',
  workflowsDebugTakeoverDiscard: '放弃',
  workflowsDebugTakeoverApplied: '已应用 AI 接管的节点修改',
  workflowsDebugTakeoverNothing: '没有可应用的 AI 接管修改',
  workflowsDebugTakeoverDiscarded: '已放弃 AI 接管的修改',
  workflowsDebugTakeoverPendingHint: ({ time, changes }) =>
    `AI 接管提出了 ${changes} 处节点修改（${time}），可应用或放弃`,

  workflowsRepairAnalyze: 'AI 分析',
  workflowsRepairSuggest: 'AI 建议修复',
  workflowsRepairAuto: 'AI 自动修复',
  workflowsRepairRunning: 'AI 修复运行中…',
  workflowsRepairTitle: 'AI 工作流修复',
  workflowsRepairFailedNode: '失败节点',
  workflowsRepairRootCause: '根因节点',
  workflowsRepairVariables: '变量依赖',
  workflowsRepairPatch: '补丁',
  workflowsRepairReplay: '回放',
  workflowsRepairVerification: '验证',
  workflowsRepairStatusOk: '可用',
  workflowsRepairStatusMissing: '缺失',
  workflowsRepairStatusEmpty: '为空',
  workflowsRepairStatusType: '类型错误',
  workflowsRepairVerified: '已验证——工作流无需 AI 接管即可独立运行。',
  workflowsRepairNotVerified: '未通过验证——修复没有通过独立运行。',
  workflowsRepairRetryHint: '该失败看起来是暂时的，建议先做有限次重试再打补丁。',
  workflowsRepairNoProvider: '尚未配置 AI 模型，无法提出补丁。',
  workflowsRepairCommit: '保存修复',
  workflowsRepairDiscard: '放弃',
  workflowsRepairCommitted: '已将验证通过的修复保存到工作流。',
  workflowsRepairClose: '关闭',
  workflowsRepairConfidence: ({ percent }) => `置信度 ${percent}%`,
  workflowsRepairLowConfidenceTitle: '置信度不足——应用前请先确认',
  workflowsRepairLowConfidenceHint:
    '诊断或补丁建议存在不确定性。当前未做任何修改。只有确认无误后再应用。',
  workflowsRepairLowConfidenceAccept: '我已确认——仍然应用',
  workflowsRepairBeforeAfter: '修改前 → 修改后',

  tasksActivityCollapse: '收起动态',
  tasksActivityExpand: '展开动态',

  save: '保存',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',
  loading: '加载中…',
  tryAgain: '重试',
  reloadPanel: '重新加载面板',
  dialogConfirm: '确认',
  dialogDeleteTitle: '确认删除？',
  dialogWarningTitle: '请注意',
  dialogOK: '知道了',

  chatEmpty: '可以询问当前正在浏览的页面，或任何其他问题。',
  chatPlaceholder: '输入消息…（Enter 发送，Shift+Enter 换行）',
  chatSend: '发送',
  chatStop: '停止',
  chatNewChat: '新对话',
  chatAttachSelection: '附带选中内容',
  chatAttach: '添加附件',
  chatAttachmentRemove: '移除附件',
  chatAttachmentTooLarge: ({ name }) => `${name} 过大（图片 ≤ 4 MB，文本 ≤ 200 KB）`,
  chatAttachmentUnsupported: ({ name }) => `${name} 不是受支持的文件类型`,
  chatAttachmentTooMany: '附件数量超限（每条消息最多 4 个）',
  chatAttachmentTotalTooLarge: '附件总大小超出限制（8 MB）',
  chatReattached: '任务仍在进行，已重新接入。',
  chatConnectionDropped: '回复过程中连接中断。已生成的内容已保存到本次对话——再发一条消息即可继续。',
  chatExtensionReloaded: '扩展已重新加载。请在 chrome://extensions 中重载，然后重新打开此面板。',
  phasePreparing: '正在准备请求…',
  phaseReadingPage: '正在读取页面…',
  phaseSending: '正在发送给模型…',
  phaseThinking: '模型思考中…',
  phaseResponding: '正在回复…',
  chatThinking: '思考过程',
  chatToolRunning: '执行中…',
  chatApprove: '允许',
  chatDecline: '拒绝',
  chatConfirmTitle: ({ name }) => `是否允许执行 ${name}？`,
  chatAskTitle: '助手需要你的回答',
  chatAskPlaceholder: '输入你的回答…',
  chatAskRecommended: '推荐',
  chatJumpToLatest: '回到最新',
  chatSkillActive: ({ name }) => `技能：${name}`,
  chatSkillGo: ({ name }) => `请使用"${name}"技能处理。`,
  chatSkillGoSelection: ({ name }) => `请用"${name}"技能处理我在页面上选中的内容。`,
  chatPlaceholderWithSkills: '输入消息…（Enter 发送，Shift+Enter 换行，/ 选择技能）',
  chatSlashNoMatch: '没有匹配的技能',
  chatSaveWorkflowPrompt: ({ steps }) =>
    `本次会话共执行了 ${steps} 步可复用操作，是否保存为工作流？`,
  chatSaveWorkflowDraftPrompt: ({ steps }) =>
    `已生成包含 ${steps} 步的工作流草稿，是否保存到工作流编辑器？`,
  chatSaveWorkflowSave: '保存为工作流',
  chatSaveWorkflowSkip: '跳过',
  chatWorkflowNothingSaved:
    '本轮没有可保存的内容：没有记录到任何页面操作。请先让模型在页面上完成任务，再试一次。',
  chatWorkflowNothingSavedFailed:
    '本轮没有可保存的内容：记录到的操作全部失败。请先解决失败原因，再重跑一次。',
  chatWorkflowProbeChecking: '正在当前页面上检查选择器…',
  chatWorkflowIntegrityTitle: '这个图按现状保存后跑不起来',
  chatWorkflowRunIssuesTitle: '可运行性检查',
  chatWorkflowRunIssuesError: '必须修复',
  chatWorkflowRunIssuesWarning: '建议检查',
  chatWorkflowRunIssuesBlocked:
    '请先在工作流编辑器里修复「必须修复」的问题再保存。这些步骤无法执行，所以保存按钮暂时禁用。',
  chatWorkflowRunIssuesNonBlocking:
    '你仍然可以保存这个工作流。保存后可以运行 AI 调试，或在编辑器里手动修复这些问题。',
  chatWorkflowSaveThenDebug: '保存并 AI 调试',
  chatWorkflowSaveThenDebugHint: '先保存工作流，再运行 AI 调试会话来修复这些问题。',
  chatWorkflowSaveThenDebugStarted: '工作流已保存，正在启动 AI 调试会话修复问题…',
  chatWorkflowIntegrityDangling: ({ blockId }) =>
    `没有任何步骤能产出这个值——「${blockId}」会以空值执行。请把它声明成工作流输入，或补上产出它的步骤。`,
  chatWorkflowIntegrityUnreachable: ({ count }) => `${count} 个步骤从触发器出发走不到：`,
  chatSaveWorkflowSaved: ({ name }) => `已保存工作流：${name}`,
  chatSaveWorkflowAiTitle: 'AI 生成内容（勾选 = 回放时用 AI 重新生成；取消 = 沿用本次填写的文本）',
  chatWorkflowInputsTitle: '工作流输入',
  generationStagesTitle: '生成阶段',
  generationStageNormalize: '规范化',
  generationStageGeneralizeInputs: '泛化输入',
  generationStageHardenTargets: '加固目标',
  generationStageBuildReliability: '构建可靠性契约',
  generationStageStaticValidate: '静态校验',
  generationStageIndependentVerify: '独立验证',
  failureCenterAiRepair: 'AI 修复',
  failureCenterTitle: '工作流恢复',
  failureCenterConfirmRepair: '确认修复',
  failureCenterCancel: '取消',
  failureCenterConfirmOverwrite: '覆盖工作流',
  failureCenterKeepCurrent: '暂不覆盖',
  failureCenterClose: '关闭',
  proposalChangesTitle: '建议修改',
  proposalRiskLabel: ({ level }) => `风险：${level}`,
  proposalEvidenceTitle: '证据',
  proposalVerificationTitle: '验证计划',
  proposalAffectedTitle: '受影响节点',
  healthStatusStable: '稳定',
  healthStatusNeedsAttention: '需要关注',
  healthStatusNoData: '暂无运行',
  healthRunsPassed: ({ passed, total }) => `${passed} / ${total} 次运行通过`,
  healthLastVerified: ({ time }) => `上次验证：${time}`,
  healthLastFailure: ({ category }) => `上次失败：${category}`,
  healthRecoveryCounts: ({ repaired, resumed }) => `${repaired} 次修复 · ${resumed} 次续跑`,
  chatWorkflowInputsHint:
    '这些值是在生成时采集的，会成为运行期输入（用 {{名称}} 引用）。保存的值只是默认值——每次运行都会重新提示或使用触发器传入的值。',
  chatWorkflowCodeNodesTitle: '需要代码的步骤',
  chatWorkflowCodeNodesHint:
    '这些步骤用 JavaScript 实现，因为内置算子做不了。改它们就等于改代码——如果你不想碰代码，可以让助手把它们换成算子。',
  chatWorkflowCodeNodesNoReason: '未记录原因',
  chatWorkflowRepairTitle: '独立验证',
  chatWorkflowRepairVerified: '已验证：该工作流在无 AI 接管的情况下独立运行并达成目标。',
  chatWorkflowRepairNotVerified: '尚未独立验证——不阻止保存；可运行 AI 调试继续修复。',
  chatWorkflowRepairFailedNode: ({ nodeId }) => `失败于节点 ${nodeId}（症状）。`,
  chatWorkflowRepairRootCauses: ({ nodes }) => `根因节点：${nodes}`,
  chatWorkflowRepairHint: '验证从不阻止保存。若工作流仍需修复，请打开 AI 调试。',
  chatWorkflowProbeTitle: '在当前页面上的选择器检查',
  chatWorkflowProbeAllOk: ({ count }) => `${count} 个选择器都精确匹配到一个元素。`,
  chatWorkflowProbeUnverified: '当前页面无法检查，这些选择器未经验证。',
  chatWorkflowProbeMissing: '没有匹配到任何元素——这一步重放时什么都不会发生',
  chatWorkflowProbeAmbiguous: ({ count }) => `匹配到 ${count} 个元素——工作流可能操作到错误的元素`,
  chatWorkflowVerifyRun: '保存后验证运行',
  chatWorkflowVerifyRunHint:
    '保存后立即真实执行一次，失败步骤由 AI 自动修复（最多一轮）。会产生真实副作用（下单、发帖、发送等），并消耗一次模型调用。',
  chatWorkflowVerifyStarted: '验证运行已开始——可在运行面板实时查看进度。',
  chatWorkflowVerifyPassed: ({ summary }) => `验证运行通过：${summary}`,
  chatWorkflowVerifyFailed: ({ reason }) => `验证运行失败：${reason}`,
  chatWorkflowVerifyPending: ({ count }) =>
    `验证运行通过，但 AI 修复产生了 ${count} 处待你确认的修改。`,
  chatSaveWorkflowAiReview: 'AI 提炼…',
  chatSaveWorkflowTriggerTitle: '触发器',
  chatSaveWorkflowTriggerHintManual: '该工作流只会在你手动启动时运行。',
  chatSaveWorkflowTriggerHintAuto: '该触发器会自动触发——保存后工作流立即进入待触发状态。',
  chatSaveWorkflowTriggerShortcut: '快捷键（例如 Ctrl+Shift+E）',
  chatSaveWorkflowTriggerMenuName: '右键菜单项名称',
  chatSaveWorkflowTriggerUrl: '匹配以下网址时运行',
  chatSaveWorkflowTriggerInterval: '每隔 N 分钟',
  chatSaveWorkflowTriggerDate: '日期（YYYY-MM-DD）',
  chatSaveWorkflowTriggerTime: '时间（HH:MM）',
  chatSaveWorkflowTriggerElementSelector: '要监视的元素选择器',
  chatSaveWorkflowTriggerElementPattern: '仅在匹配以下网址时（可选）',
  chatSaveWorkflowTriggerElementSubtree: '包含后代元素',
  chatSaveWorkflowTriggerElementChildList: '内容增删',
  chatSaveWorkflowTriggerElementAttributes: '属性变化',
  chatSaveWorkflowTriggerElementCharacterData: '文本变化',
  triggerKindManual: '手动运行',
  triggerKindOnStartup: '浏览器启动时',
  triggerKindKeyboardShortcut: '快捷键',
  triggerKindContextMenu: '右键菜单',
  triggerKindVisitWeb: '访问网站时',
  triggerKindInterval: '定时循环',
  triggerKindSpecificDay: '指定星期几',
  triggerKindDate: '指定日期',
  triggerKindElementChange: '元素变化时',
  chatFoldTitle: '重复步骤',
  chatFoldHint:
    '把重复出现的步骤折叠成循环，工作流才读得懂。作用于不同元素的重复段需要一个「页面能确认」的选择器，页面无法确认时不会折叠。',
  chatFoldApply: '折叠为循环',
  chatFoldBusy: '折叠中…',
  chatFoldApplied: '已折叠为循环。保存前请在编辑器里复核。',
  chatFoldRefused: '当前页面无法确认能精确匹配这些元素的选择器，未做折叠。',
  chatWorkflowReviewing: 'AI 正在审查哪些节点值得保留…',
  chatWorkflowReviewUnavailable: 'AI 审查不可用，已保留全部步骤。',
  chatWorkflowReviewDropped: ({ count }) => `AI 已剔除 ${count} 个无效步骤，取消勾选可保留。`,
  chatWorkflowReviewAllKept: 'AI 已逐项审查：没有发现无效步骤。',
  chatWorkflowStepsTitle: '步骤清单（取消勾选即从工作流中移除）',
  workflowReviewDialogTitle: '保存前先审查步骤',
  workflowReviewDialogConfirm: '保存工作流',
  workflowReviewDialogCancel: '取消',
  workflowReviewDialogRetry: '重试审查',
  workflowReviewLogTitle: '审查日志',
  workflowReviewLogCollapse: '收起',
  workflowReviewLogExpand: '展开',
  workflowReviewLogStart: ({ steps }) => `已发送 ${steps} 个步骤给 AI 审查…`,
  workflowReviewLogFailed: '审查失败，已保留全部步骤。可点击「重试审查」再试一次。',

  modeLabel: '模式',
  modeChat: '聊天',
  modeReadonly: '只读',
  modeSemi: '半自动',
  modeFull: '全自动',
  modeWorkflow: '工作流生成',
  modeChatHint: '纯对话。不发送操作规则和工具，因此不能读取或操作页面，token 消耗最低。',
  modeReadonlyHint: '只能读取页面和回答问题，不能点击、输入或跳转。',
  modeSemiHint: '每个改变页面的操作都会先请你确认。',
  modeFullHint: '智能体直接操作，不再每次询问。请留意操作记录。',
  modeFullWarning:
    '全自动模式下智能体可自行点击、输入和跳转，无需逐项确认。建议仅在你信任的网站使用，并事后查看操作记录。',
  modeWorkflowWarning:
    '工作流生成模式并非"仅录制"：它会像全自动模式一样真实操作页面——每个算子都会立即点击、输入、跳转，JavaScript 代码算子还会在页面中执行任意脚本。建议仅在你信任的网站使用，并在运行生成的工作流前先检查一遍。',
  modeWorkflowHint:
    '工作流生成模式与全自动模式一样真实操作页面：每个算子都会立即在页面上执行，成功后才记录为草稿中的节点，无需逐项确认。工作流会自动带上触发器节点；回合结束后面板弹出「保存为工作流」卡片，可在其中修改触发器类型。',

  planCardTitle: '执行计划',
  planCardGoal: '目标',
  planCardSteps: '步骤',
  planCardRisks: '风险',
  planCardSplit: '工作流拆分',
  planApprove: '批准并执行',
  planRevise: '修改计划',
  planFeedbackPlaceholder: '这份计划需要怎么调整？',
  planFeedbackSend: '提交反馈',
  planApprovedChip: '计划已批准',
  planRejectedChip: '计划已拒绝',
  planCardAria: '计划确认卡片',
  contextCompacted: '上下文较长——较早的回合已被摘要压缩，以留在模型窗口内。',
  contextCompactedMarker: '[上下文已压缩] 此前对话摘要：',

  tokenUsage: 'Token 消耗',
  tokenTotal: '合计',
  tokenInput: '输入',
  tokenOutput: '输出',
  tokenCached: '缓存命中',
  tokenReasoning: '推理',
  tokenCacheRate: '缓存命中率',
  tokenSession: '本次会话',
  tokenLastTurn: '最近一轮',
  tokenNone: '暂无消耗',

  mdCopy: '复制',
  mdCopied: '已复制',
  mdCopyFailed: '复制失败',
  mdCodePlain: '文本',

  skillsTitle: '技能',
  skillsIntro:
    '技能是可复用的指令包。在“对话”中选用即可应用于当前会话，也可以让 agent 根据说明自动匹配。',
  skillsEmpty: '还没有技能。把你经常输入的指令保存为技能即可复用。',
  skillsAdd: '新建技能',
  skillsName: '名称',
  skillsNamePlaceholder: '例如：总结文章',
  skillsDescription: '适用场景',
  skillsDescriptionHint: '用一句话说明何时该用它。这句会用于自动匹配，请尽量具体。',
  skillsInstructions: '指令内容',
  skillsInstructionsHint: '技能启用时会追加到系统提示中。请以“对助手下达指示”的方式书写。',
  skillsAutoMatch: '允许 agent 自动应用',
  skillsAutoMatchHint: '开启后，当你的消息与上面的“适用场景”相符时，agent 可自行使用该技能。',
  skillsSaved: ({ name }) => `已保存“${name}”。`,
  skillsDeleted: ({ name }) => `已删除“${name}”。`,
  skillsDeleteConfirm: ({ name }) => `删除技能“${name}”？其指令内容无法恢复。`,
  skillsNameRequired: '请填写技能名称。',
  skillsInstructionsRequired: '指令内容不能为空。',
  skillsNameTaken: '已存在同名技能。',
  skillsUse: '在对话中使用',
  skillsInUse: '使用中',
  skillsStopUsing: '停止使用',
  skillsBuiltinNote: '技能仅保存在本浏览器本地，除作为提示词的一部分外不会发送到任何地方。',

  settingsProviders: '模型服务',
  settingsProvidersIntro:
    '支持任意 OpenAI 兼容接口——DeepSeek、火山方舟、OpenAI、OpenRouter，或本地 Ollama。选择预设可自动填入接口地址。',
  settingsNoProvider: '尚未配置服务。添加一个后才能使用 agent。',
  settingsAddProvider: '添加模型服务',
  settingsChoosePreset: '选择预设…',
  settingsChooseEndpoint: '选择预设端点…',
  settingsUseThis: '使用这个',
  settingsActive: '使用中',
  settingsKeyConfigured: '已配置密钥',
  settingsNoKey: '未配置密钥——agent 将无法工作',
  settingsName: '名称',
  settingsBaseUrl: '接口地址',
  settingsEndpointPresets: '预设端点',
  settingsBaseUrlHint: '填到 /chat/completions 之前的部分即可。粘贴完整地址会自动裁剪。',
  settingsImageModel: '图片识别模型',
  settingsModify: '修改…',
  settingsImageModelCurrentValue: ({ value }) => `当前：${value}`,
  settingsImageModelIntro:
    '从已添加的提供商中选择即可复用其接口地址和 API 密钥，用于 recognize_image 工具（验证码、图片文字）。仅当该提供商默认模型不支持视觉时才需要手动填模型名。',
  settingsImageModelProvider: '模型提供商',
  settingsImageModelAuto: '自动（使用当前对话模型）',
  settingsImageModelFetchNoProvider:
    '请先选择提供商——将复用其已保存的接口地址和 API 密钥，无需重新填写。',
  settingsImageModelProviderMissing: '所选提供商已不在列表中，请重新选择或使用“自动”。',
  settingsImageModelSaved: '图片识别模型已保存。',
  settingsTakeoverModel: 'AI 接管模型（AI 调试）',
  settingsTakeoverModelIntro:
    '为 AI 调试接管单独指定模型——负责在页面上完成失败步骤的智能体是“看页面 + 多轮工具调用”的硬任务，用更强的模型能显著提升调试成功率。留空（自动）则使用当前会话模型。',
  settingsTakeoverOnRun: '普通运行失败时也允许 AI 接管（会消耗模型调用）',
  settingsTakeoverOnRunIntro:
    '默认关闭：普通运行失败即失败。开启后失败节点会获得一次 AI 接管机会，产生的修改建议进入待确认列表。',
  settingsTakeoverModelProvider: '模型服务',
  settingsTakeoverModelSelectHint: '从下拉中选择模型，或保持服务默认。列表为空时请先获取模型列表。',
  settingsTakeoverModelSaved: 'AI 接管模型已保存。',
  settingsOcrLanguage: '本地 OCR 语言',
  settingsOcrLanguageIntro:
    'Tesseract.js 离线识别图片文字时的语言。会先于图像模型执行；若 OCR 无结果，再回退到下方配置的图像模型。',
  settingsSaving: '保存中…',
  settingsApiKey: 'API 密钥',
  settingsShowKey: '显示密钥',
  settingsModel: '模型',
  settingsModelsAvailable: ({ count }) => `共 ${count} 个可用模型，请从下拉列表中选择。`,
  settingsImageModelSelectHint:
    '从下拉列表中选择模型；若列表为空请先点击“获取模型列表”。留空使用该 provider 的默认模型。',
  settingsShowAdvanced: '显示高级选项',
  settingsHideAdvanced: '收起高级选项',
  settingsTemperature: '温度',
  settingsMaxTokens: '最大 token 数',
  settingsProviderDefault: '使用服务默认值',
  settingsExtraHeaders: '额外请求头（JSON）',
  settingsTest: '测试连接',
  settingsTesting: '测试中…',
  settingsFetchModels: '获取模型列表',
  settingsFetchingModels: '加载中…',
  settingsKeyStorageNote:
    '密钥仅保存在本机此扩展的本地存储中（不会同步）。任何能访问你浏览器配置的人都可以读取。',
  settingsTestOk: ({ name }) => `${name} 已响应，密钥与模型均可用。`,
  settingsNewProvider: '新增模型服务',
  settingsEditProvider: '编辑模型服务',
  settingsLanguage: '语言',
  settingsLanguageAuto: '自动（跟随浏览器）',
  settingsKeyPlaceholderLocal: '本地服务填任意值即可',
  settingsMaxToolRounds: '每条回复最多操作步数',
  settingsMaxToolRoundsHint:
    '代理在一轮对话中最多可执行的操作次数（点击、读取、滚动等），超过后会自动停止以防死循环。数值越大，长任务越能一次性完成；数值越小，越会早点停下来等你确认。范围 1–100。',
  settingsModelsEmpty: '该接口返回的模型列表为空。',
  settingsModelsFailed: ({ message }) =>
    `${message}——并非所有网关都提供 /models，你仍可手动输入模型名称。`,
  settingsSaved: ({ name }) => `已保存“${name}”。`,

  settingsContextTitle: '模型上下文与工具',
  settingsContextIntro:
    '系统提示词和已启用的工具定义会随每次请求发送，构成固定的 token 开销。编辑或关闭用不到的项可减少消耗；更改在下一条消息生效。工具默认全部开启，提示词默认为内置版本。',
  settingsSystemPrompt: '操作规则（系统提示词）',
  settingsSystemPromptHint:
    '这些规则告诉助手如何行事：何时快照、如何填写表单/密钥、用你的语言回答等。你可以自由编辑；留空则使用内置默认规则。当前的自主模式和可用技能会自动追加在后面。',
  settingsPromptSave: '保存',
  settingsPromptReset: '恢复默认',
  settingsPromptDefault: '当前使用内置默认提示词。',
  settingsPromptCustom: '当前使用你自定义的提示词。点击“恢复默认”可还原。',
  settingsStateDefault: '默认',
  settingsStateCustom: '已自定义',
  settingsTools: '工具',
  settingsToolsHint:
    '每个启用的工具都会把其参数定义加入每次请求。关闭你用不到的工具，助手就看不到它。',
  settingsToolsEnableAll: '全部启用',
  settingsToolsDisableAll: '全部关闭',
  settingsToolsEnabled: '个已启用',
  settingsOperatorTools: '工作流算子工具',
  settingsOperatorToolsHint:
    '仅在工作流生成模式下可用。助手先声明需要哪一类，只发送该类的工具，这是每次请求体积可控的关键。若调用了未发送分类下的工具，该分类会被自动激活。',
  settingsOperatorToolsCore: '常驻',
  settingsOperatorToolsOnDemand: '按需',
  settingsOperatorToolsCount: ({ count }) => `${count} 个工具`,
  settingsOperatorToolsReadOnly: '仅作说明：这些工具属于工作流生成能力，无法在此关闭。',
  toolReadPage: '读取页面文本',
  toolReadPageWarn: '关闭后：助手无法读取当前页面的文本。',
  toolSnapshot: '快照页面元素',
  toolSnapshotWarn: '关闭后：助手无法看到按钮、链接、输入框，因此无法可靠地点击或填写。',
  toolListTabs: '列出标签页',
  toolListTabsWarn: '关闭后：助手无法查看或引用你打开的其他标签页。',
  toolNetworkRequests: '查看最近网络请求',
  toolNetworkRequestsWarn: '关闭后：助手无法在页面操作后诊断失败或缓慢的请求。',
  toolConsoleLog: '查看控制台日志',
  toolConsoleLogWarn: '关闭后：助手无法查看页面控制台的报错与日志，排查页面脚本问题会变难。',
  toolClick: '点击元素',
  toolClickWarn: '关闭后：助手无法点击按钮或链接。',
  toolFill: '在输入框中输入',
  toolFillWarn: '关闭后：助手无法在输入框或文本域中输入文字。',
  toolSelect: '选择下拉选项',
  toolSelectWarn: '关闭后：助手无法在下拉框（<select>）中选择选项。',
  toolCheckbox: '勾选/取消复选框',
  toolCheckboxWarn: '关闭后：助手无法勾选或取消复选框、单选按钮。',
  toolPressKey: '按键',
  toolPressKeyWarn: '关闭后：助手无法按回车、Tab、Esc 等键盘快捷键。',
  toolScroll: '滚动页面',
  toolScrollWarn: '关闭后：助手无法显示屏幕外的内容（懒加载列表、“查看更多”、长文章）。',
  toolWait: '等待元素出现',
  toolWaitWarn: '关闭后：助手无法在加载或导航后等待内容出现。',
  toolOpenUrl: '打开网址',
  toolOpenUrlWarn: '关闭后：助手无法直接在当前标签页打开网址。',
  toolTabNew: '新建标签页',
  toolTabNewWarn: '关闭后：助手无法新建标签页。',
  toolTabSwitch: '切换标签页',
  toolTabSwitchWarn: '关闭后：助手无法在已打开的标签页之间切换。',
  toolTabClose: '关闭标签页',
  toolTabCloseWarn: '关闭后：助手无法关闭标签页。',
  toolPinTab: '钉住标签页供后续操作',
  toolPinTabWarn: '关闭后：助手操作非活动标签页前必须先切换，多耗步骤。',
  toolUnpinTab: '取消钉住标签页',
  toolUnpinTabWarn: '关闭后：被钉住的标签页在过期前一直生效，可能影响后续操作。',
  toolRunJs: '在页面上执行 JavaScript',
  toolRunJsWarn: '关闭后：助手无法在页面上运行自定义 JavaScript。',
  toolRunPlan: '按计划连续执行多步操作',
  toolRunPlanWarn: '关闭后：助手只能逐步确认或执行每个动作，多步任务会明显变慢。',
  toolSaveLocal: '保存内容到文件',
  toolSaveLocalWarn: '关闭后：助手无法将内容保存或下载到文件，可能会退回到构建脚本的方式。',
  toolProfile: '使用已保存资料',
  toolProfileWarn: '关闭后：助手无法读取你保存的姓名/邮箱/地址来自动填写个人表单。',
  toolListSecrets: '列出已保存密钥',
  toolListSecretsWarn: '关闭后：助手无法按名称查看你保存的键值密钥，无法决定该填哪一项。',
  toolSecret: '填写已保存密钥',
  toolSecretWarn: '关闭后：助手无法填写已保存的密码或密钥字段（需要你手动输入）。',
  toolSkill: '使用技能',
  toolSkillWarn: '关闭后：助手无法加载或应用已保存的技能。',
  toolListTasks: '列出定时任务',
  toolListTasksWarn: '关闭后：助手无法告诉你当前启用了哪些定时/周期任务。',
  toolCreateTask: '创建或更新定时任务',
  toolCreateTaskWarn:
    '关闭后：助手无法在聊天中创建或修改定时/周期任务——"每天早上9点运行"这类请求会失败。',
  toolLoadTools: '按需加载工具组',
  toolLoadToolsWarn:
    '关闭后：助手无法按需加载隐藏的工具组（标签页管理、保存文件、已存资料/密码、技能、网络/控制台诊断），相关任务会失败。',
  toolDelegate: '把 子任务委派给专长子智能体',
  toolDelegateWarn: '关闭后：主管无法把子任务分派给专长子智能体，所有任务都在主会话中直接完成。',
  toolAskUser: '向用户提问确认',
  toolAskUserWarn: '关闭后：助手无法就模糊需求向你确认，只能自行猜测。',
  toolPresentPlan: '提交执行计划等待用户批准',
  toolPresentPlanWarn: '关闭后：计划先行流程无法弹出计划卡片，任务将不再经过你的计划批准直接执行。',
  toolOperator: '工作流算子（草稿写入）',
  toolOperatorWarn: '关闭后：该算子在工作流生成模式下不可用，也不会出现在生成的工作流中。',

  toolRecognizeImage: '识别图片中的文字（验证码等）',
  toolRecognizeImageWarn: '关闭后：助手无法使用图片模型识别页面上的验证码或其他图片文字。',
  toolScreenshot: '截取元素或页面并进行视觉检查',
  toolScreenshotWarn: '关闭后：助手无法截取页面元素或验证码并发送给视觉模型进行查看。',
  toolCreateSkill: '创建或更新技能',
  toolCreateSkillWarn:
    '关闭后：助手无法直接编写并保存可复用技能（内置的 skill 生成器将无法工作）。',

  settingsPageAccess: '页面读取权限',
  settingsPageAccessIntro:
    '助手读取页面时会临时注入一段只读脚本，因此仅在普通 http(s) 标签页有效——chrome:// 页面、应用商店和本地文件都无法读取。',
  settingsCheckTab: '检测当前标签页',
  settingsPageReadable: ({ title }) => `当前标签页可以读取：${title}`,
  settingsPageBlocked: ({ reason }) => `当前标签页无法读取。${reason}`,

  settingsStorage: '存储位置',
  settingsStorageIntro:
    '聊天记录、工作流、历史记录、技能、智能体等数据都会以 JSON 文件形式保存在你选择的文件夹中；扩展配置（模型服务、存储路径本身）仍保存在浏览器存储中。文件夹短暂不可用时，变更会先排队，恢复连接后自动写入。',
  settingsStorageBrowser: '浏览器存储（默认）',
  settingsStorageFile: '保存在你的电脑',
  settingsStorageFolder: ({ name }) => `文件夹：${name}`,
  settingsChooseFolder: '选择文件夹',
  settingsChangeFolder: '更换文件夹',
  settingsReconnectFolder: '重新连接文件夹',
  settingsUseBrowserStorage: '改用浏览器存储',
  settingsStorageUnsupported: '当前浏览器不支持保存到文件夹。',
  settingsStorageSynced: ({ name }) => `数据已保存到 ${name}。`,
  settingsStorageNeedReconnect: ({ name }) =>
    `已选择文件夹「${name}」，但访问权限已失效。重新连接后即可继续保存文件。`,
  settingsStoragePendingWrites: ({ count }) =>
    `${count} 条变更待写入文件夹——重新连接后会自动写入。`,

  settingsDownloadDir: '下载目录',
  settingsDownloadDirIntro:
    '导出的文件（如完整对话记录）会保存到你选择的文件夹中。选择一个文件夹即可启用自动下载。',
  settingsDownloadDirFolder: ({ name }) => `下载目录：${name}`,
  settingsDownloadDirNone: '暂未配置下载目录。',
  settingsDownloadDirDone: ({ name }) => `下载目录已设置：${name}。`,
  settingsDownloadDirFailed: '无法设置下载目录。',
  settingsDownloadDirDisconnect: '断开',
  settingsDownloadAutoSave: '自动将导出内容保存到该文件夹',

  settingsLocalAgent: '本地 Agent 接入',
  settingsLocalAgentIntro: '连接编程助手自动拉起的本地 MCP 适配器。',
  settingsLocalAgentEnable: '允许 localhost 页面控制浏览器',
  settingsLocalAgentConfigure: '配置接入',
  settingsLocalAgentUrl: '适配器地址',
  settingsLocalAgentUrlPlaceholder: 'ws://127.0.0.1:8765',
  settingsLocalAgentToken: '共享令牌（可选）',
  settingsLocalAgentTokenPlaceholder: '留空则仅信任 localhost 来源',
  settingsLocalAgentStatusConnected: '已连接',
  settingsLocalAgentStatusConnecting: '连接中',
  settingsLocalAgentStatusDisconnected: '未连接',
  settingsLocalAgentStatusError: ({ error }) => `错误：${error}`,
  settingsLocalAgentErrorRefused:
    '本地适配器未运行：适配器只在编码 Agent 会话期间存活，会话结束即退出（插件因此显示“未连接”）。适配器启动后约 30 秒内会自动重连；想让插件保持常连，可单独运行 node mcp-server.mjs --standalone。',
  settingsLocalAgentBindingsTitle: '将连接分配到窗口',
  settingsLocalAgentBindingsHint:
    '每个连接只能在被分配的窗口内操作。一旦存在分配，未分配的连接会被拒绝——请在它要使用的窗口里打开插件并在此分配。零分配时所有连接默认操作最近活动的插件窗口。多个 agent 在同一个项目目录开会话时，请为各自设置不同的 BROWSER_COPILOT_AGENT_NAME。',
  settingsLocalAgentBindingUnassigned: '未分配',
  settingsLocalAgentBindingThisWindow: '本窗口',
  settingsLocalAgentBindingClosed: ({ id }) => `#${id} · 窗口已关闭`,
  settingsLocalAgentBindingDuplicate:
    '有多个连接使用相同名称——该分配会同时作用于它们。请为各 agent 设置不同的 BROWSER_COPILOT_AGENT_NAME 以区分。',
  settingsLocalAgentBindingStale: '已断开连接的分配',
  settingsLocalAgentBindingRemove: '移除',
  settingsLocalAgentAgentsConnected: ({ count }) => `已接入 ${count} 个连接`,
  settingsLocalAgentMcpTitle: 'MCP 配置',
  settingsLocalAgentMcpHint:
    '添加一个 stdio MCP 服务，助手会自动拉起适配器并自动连上。注意：适配器只在编码 Agent 会话期间存活；想让插件保持常连，可单独运行 node mcp-server.mjs --standalone。',
  settingsLocalAgentMcpTabClaude: 'Claude Code',
  settingsLocalAgentMcpTabCodex: 'Codex',
  settingsLocalAgentMcpTabTrae: 'Trae',
  settingsLocalAgentExportTitle: '适配器脚本（mcp-server.mjs）',
  settingsLocalAgentExportIntro:
    '使用安装包？点一次「导出适配器」即可，无需下载源码；下方配置会自动填入它的真实绝对路径。',
  settingsLocalAgentExport: '导出适配器',
  settingsLocalAgentReexport: '重新导出',
  settingsLocalAgentExporting: '导出中…',
  settingsLocalAgentExportedTo: ({ path }) => `已导出到：${path}`,
  settingsLocalAgentExportFailed: '导出适配器失败：',
  settingsLocalAgentMcpPlaceholderHint:
    '请先点上方「导出适配器」自动填入路径；也可手动把 __插件目录__ 替换为适配器的绝对路径。',
  settingsLocalAgentMcpExportedHint:
    '配置片段已指向导出的适配器；插件升级后请重新导出一次以保持同步。',
  settingsLocalAgentCopy: '复制',
  settingsLocalAgentCopied: '已复制 ✓',
  settingsLocalAgentWarning: '开启后本机任意页面都能驱动浏览器，请仅在本地 agent 运行时开启。',

  dataTitle: '个人数据',
  dataIntro:
    '保存的个人资料与凭据仅存在本机，只有在你批准后才会作为请求的一部分发送给模型。助手会用它们自动填写表单，避免重复输入。',
  dataProfiles: '个人资料',
  dataProfilesIntro: '姓名、邮箱、电话、地址等，用于自动填表单。',
  dataProfilesEmpty: '还没有资料。添加一个以加快填表。',
  dataAddProfile: '新建资料',
  dataProfileLabel: '名称（如：个人、工作）',
  dataFullName: '姓名',
  dataFirstName: '名',
  dataLastName: '姓',
  dataEmail: '邮箱',
  dataPhone: '电话',
  dataAddress: '地址',
  dataCity: '城市',
  dataState: '省/州',
  dataPostalCode: '邮编',
  dataCountry: '国家/地区',
  dataCompany: '公司',
  dataJobTitle: '职位',
  dataCustomFields: '自定义字段',
  dataCustomFieldsHint: '每行一个“键 = 值”，例如 birthday = 1990-01-01',
  dataPasswords: '密码与账号',
  dataPasswordsIntro:
    '保存的凭据可用于填写登录表单。密码值不会发送给模型——在你批准后会直接填入输入框。',
  dataPasswordsEmpty: '还没有账号。添加后即可一键填写登录信息。',
  dataAddPassword: '新建账号',
  dataPasswordLabel: '名称（如：GitHub、工作邮箱）',
  dataPasswordUrl: '站点 URL（可选）',
  dataPasswordUsername: '用户名 / 邮箱',
  dataPasswordValue: '密码',
  dataPasswordNotes: '备注（可选）',
  dataPasswordStorageNote:
    '凭据仅保存在本机此扩展的本地存储中（不会同步）。任何能访问你浏览器配置的人都可以读取——请勿在共用设备上保存高价值密码。',
  dataSecrets: '密钥与字段',
  dataSecretsIntro:
    '保存任意键值对凭据，智能体可填入表单（用户名、密码、CVV、安全问题答案等）。一个站点需要多少字段就加多少。',
  dataSecretsEmpty: '还没有密钥。添加后即可让智能体填写登录字段。',
  dataAddSecret: '添加密钥',
  dataSecretLabel: '名称（如：GitHub、工作）',
  dataSecretUrl: '站点 URL（可选）',
  dataSecretFields: '字段',
  dataSecretAddField: '添加字段',
  dataSecretFieldKey: '字段名',
  dataSecretFieldValue: '值',
  dataSecretMaskValue: '作为密码隐藏',
  dataShowPassword: '显示 / 隐藏',
  dataHistory: '操作记录',
  dataHistoryIntro: '助手在网页上执行过的每一步操作记录，可随时查看或删除。',
  dataHistoryEmpty: '暂无操作记录。',
  dataClearHistory: '全部清空',
  dataHistoryToWorkflow: '保存为工作流',
  dataHistoryToWorkflowDone: '已将操作步骤保存为工作流。',
  dataHistoryToWorkflowEmpty: '该组中没有可重建为工作流的操作。',
  dataHistoryWhen: '时间',
  dataConversation: '会话',
  dataDeclined: '已拒绝',
  dataUsed: ({ count }) => `已使用 ${count} 次`,

  convTitle: '会话',
  convNew: '新对话',
  convRename: '重命名',
  convDelete: '删除',
  convUntitled: '新对话',
  convDeleteConfirm: '确定删除该会话及其全部消息吗？',
  convHistory: '对话历史',
  convHistoryEmpty: '还没有历史会话。',
  convContinue: '继续对话',
  convPreview: '预览',
  convUpdated: '更新于',

  confirmActionHint: '助手希望执行以下操作，批准后只会执行这一次。',

  errorPanelCrashed: '面板遇到意外错误，已停止渲染。',
  errorWhatHappened: '错误信息',
  errorVersionSkew:
    '如果这是在更新后立即出现的，可能是扩展与面板运行了不同版本。请在 chrome://extensions 中重新加载扩展，然后重新打开面板。',
  errorTemperatureNumber: '温度必须是数字。',
  errorMaxTokensInteger: '最大 token 数必须是正整数。',
  errorHeadersJson: '额外请求头必须是合法的 JSON。',
  errorHeadersObject: '额外请求头必须是 JSON 对象。',

  // --- New: chat message actions (zh-CN) ---
  msgCopy: '复制',
  msgCopied: '已复制',
  msgCopyFailed: '复制失败',
  msgDownload: '下载',
  msgDownloadAs: '导出格式',
  msgDownloadMd: 'Markdown (.md)',
  msgDownloadTxt: '纯文本 (.txt)',
  msgDownloadHtmlPdf: 'HTML / 打印为 PDF',
  msgDownloadCsv: 'CSV (.csv)',
  msgDownloadUntitled: '对话',
  msgDownloadHtmlHint: '打开下载的 HTML，使用浏览器的“打印”对话框另存为 PDF 即可。',
  msgTokenUsage: 'Token 消耗',

  // --- New: inline token bar (zh-CN) ---
  tokenBarSession: '本次会话',
  tokenBarLastTurn: '上一条消息',
  tokenBarT: '总计',
  tokenBarI: '输入',
  tokenBarO: '输出',
  tokenBarR: '推理',
  tokenBarC: '缓存',
  tokenBarDash: '-',

  // --- New: in-chat generated skill saving (zh-CN) ---
  skillGeneratedPreview: '在这条回复中检测到一个新技能，要保存下来复用吗？',
  skillSave: '保存技能',
  skillSaveEdit: '编辑后保存',
  skillDiscard: '忽略',
  skillSavedBanner: ({ name }) => `已保存技能 “${name}”，现在可以在对话中选择使用。`,
  skillAutoMatch: '允许助手自动匹配并启用此技能',
  skillName: '名称',
  skillDescription: '适用场景',
  skillInstructions: '技能指令',

  // --- New: skills tab import / export (zh-CN) ---
  skillsImport: '导入',
  skillsImportHint: '可将 .json / .yaml / .md 技能文件拖到此处，或点击“导入”。',
  skillsImportFile: '选择文件',
  skillsImportResultOk: ({ count }) => `已成功导入 ${count} 个技能。`,
  skillsImportResultFail: ({ ok, failed }) =>
    `导入完成：成功 ${ok} 个，失败 ${failed} 个，详情见上方提示。`,
  skillsExportAll: '全部导出',
  skillsImportNameTaken: ({ name }) => `已跳过 “${name}”：同名技能已存在。`,

  agentsTitle: '智能体',
  agentsIntro:
    '智能体是可被委派的执行单元：主管会把大任务拆成子任务分派给专长智能体，小任务则始终直接完成。内置智能体可以直接编辑，也能随时一键恢复默认。',
  agentsEmpty: '还没有智能体。可以新建；内置智能体会在重载后自动出现。',
  agentsAdd: '新建智能体',
  agentsImport: '导入',
  agentsImportHint: '导入智能体文件（.json、.yaml、.md），也可直接拖入本页。',
  agentsExport: '全部导出',
  agentsBuiltinNote: '内置智能体随扩展提供，可以就地编辑；「恢复默认」可随时还原为出厂版本。',
  agentsReset: '恢复默认',
  agentsBuiltinBadge: '内置',
  agentsSpecialistPill: '专长',
  agentsDelegatablePill: '可委派',
  agentsToolsCount: ({ count }) => (count === 0 ? '全部工具' : `${count} 个工具`),
  agentsImportResultOk: ({ count }) => `已成功导入 ${count} 个智能体。`,
  agentsImportResultFail: ({ ok, failed }) =>
    `导入完成：成功 ${ok} 个，失败 ${failed} 个，详情见上方提示。`,
  agentsImportNameTaken: ({ name }) => `已跳过 “${name}”：同名智能体已存在。`,
  agentRole: '角色',
  agentRoleSupervisor: '主管（拆分并委派大任务）',
  agentRoleSpecialist: '专长子智能体（执行被委派的任务）',
  agentDomain: '专长领域',
  agentDomainSearch: '浏览器检索',
  agentDomainWriting: '文案写作',
  agentDomainOperations: '平台运营',
  agentDomainWorkflow: '工作流生成',
  agentDomainAnalysis: '内容分析',
  agentDomainCustom: '自定义',
  agentHint: '何时委派给它',
  agentHintHint: '主管据此判断是否委派的一两句话。决定委派时只会展示这段文字（不会展示完整指令）。',
  agentTools: '可用工具',
  agentToolsHint: '该智能体可调用的工具白名单；留空表示继承会话中的全部工具。',
  agentToolsInherit: '留空：继承全部工具',
  agentSkills: '关联技能',
  agentSkillsHint: '选中的技能会注入该智能体的系统提示词。',
  agentDelegatable: '允许该智能体拆分任务并委派给专长子智能体',
  agentDelegatableHint: '只有主管可以委派；子智能体不能再向下委派。',
  agentMaxRounds: '单次委派最大工具轮次',
  agentSaved: ({ name }) => `智能体 “${name}” 已保存。`,
  agentDeleted: ({ name }) => `智能体 “${name}” 已删除。`,
  agentsDeleteConfirm: ({ name }) => `删除智能体“${name}”？其配置无法恢复。`,
  agentResetDone: ({ name }) => `内置智能体 “${name}” 已恢复为默认版本。`,
  agentNameRequired: '请填写名称。',
  agentInstructionsRequired: '请填写指令。',
  agentNameTaken: '该名称已被另一个智能体占用。',

  // 内置智能体多语言
  builtinAgentSupervisorDisplayName: '主管',
  builtinAgentSupervisorHint: '负责用户的整个请求；大型多领域任务会委派给专长智能体。',
  builtinAgentSupervisorInstructions: `你是本次 Browser Copilot 会话的主管智能体。

- 你对用户的整个请求负责，并对最终回答承担责任。
- 小型、单一领域的请求：直接使用你自己的工具完成。
- 大型、多部分请求：严格遵循下方的委派规则，将范围明确的子任务交给专长智能体。
- 专长智能体只能看到你交给它们的内容。挑选它们需要的上游输出；永远不要转发原始对话记录。它们返回的是压缩报告，而非完整过程。
- 在使用每份报告前，都要对照原始目标进行判断：报告是你需要核实的材料，而不是可以直接转发给用户的答案。
- 你自己将接受的报告整合成一个连贯的回答。用户不应该看到子结果，也不需要知道工作是如何拆分的。
- 页面操作仍然需要用户通过面板批准；委派任务不能绕过这一机制。`,
  builtinAgentSearchExpertDisplayName: '搜索专家',
  builtinAgentSearchExpertHint:
    '网页/页面调研：浏览页面并返回最相关 findings 及 URL。用于信息收集、事实核查、选项比较——不负责长篇写作。',
  builtinAgentSearchExpertInstructions: `你是搜索专长智能体。

职责：在已打开的页面和网络上查找、核实信息。你不会撰写长文，不会操作简单搜索框以外的表单，也不会改变网站状态。

流程：
1. 自己打开相关页面或搜索入口（主管不会把页面内容交给你）。
2. 按需浏览和阅读；仅在链接与主题相关时才跟踪。
3. 获得足够信息后就停止；不要为了"完整"而继续探索。

报告格式——最多返回 10 条结果，每行一条：
- [{n}] {title} — {url}
  snippet: 实际相关内容的 ≤200 字符摘要
  why: 简短说明为何能回答任务

列表之外不要写任何文字。不要长段引用。如果无法完成搜索，说明尝试了什么、还缺什么。`,
  builtinAgentCopywriterDisplayName: '写作专家',
  builtinAgentCopywriterHint:
    '根据任务简报和提供的材料撰写交付物（帖子、邮件、文档、文案）。纯内容生成，不浏览页面——给它资料，拿回大纲和草稿。',
  builtinAgentCopywriterInstructions: `你是写作专长智能体。你没有浏览器工具：所需的一切都必须来自任务简报和主管提供的上游上下文。如果材料不足，明确指出缺少什么，而不是编造事实。

流程：
1. 用一句话重述目标：受众、格式、语气、篇幅上限。
2. 先列一个简短大纲（标题/要点）。
3. 然后撰写完整内容，匹配要求的风格和约束。
4. 交回前对照简报自检。

交付物处理：
- 完整草稿就是交付物。当内容较长（完整文章、多节文档）时，用 save_local 保存并返回文件名。
- 你的返回消息包含：3 条要点总结 + 文件名。
- 短交付物则整段文字直接放在返回消息中。

不要注水：不加免责声明、不说"好的"、不评论写作过程。`,
  builtinAgentOpsExpertDisplayName: '运营专家',
  builtinAgentOpsExpertHint:
    '实际网站操作：填写表单、发帖/发布流程、日常后台点击，使用已保存的资料和凭证。用于执行一系列动作，不是调研或写作。',
  builtinAgentOpsExpertInstructions: `你是运营专长智能体：代表用户在已登录的页面上执行具体的动作序列。

安全规则：
- 操作前先列出计划：每一步一行，写明页面和具体动作（"打开发布表单"、"填写标题字段"）。用户会通过面板逐一批准每个页面变更动作。
- 不要编造值：使用任务简报、已保存的资料（get_my_profile），或通过标签引用的已保存凭证。
- 使用 list_secrets/get_secret 时，你只能看到标签和填充结果。永远不要把凭证值打印、记录、重复或写入非对应的字段。
- 破坏性或不可逆操作（删除、发布、付款、提交合同）要求任务中已明确说明该动作；否则停止并报告需要什么确认。

报告：按顺序列出已完成的操作，以及最终的页面状态/URL。列出跳过的步骤及原因。不要在任何地方粘贴凭证值。`,
  builtinAgentWorkflowExpertDisplayName: '工作流专家',
  builtinAgentWorkflowExpertHint:
    '把操作流程转换为可保存的 Browser Copilot 工作流（算子/节点、保留/丢弃判断）。用于"做成工作流/自动化这个流程/哪个节点做 X"。',
  builtinAgentWorkflowExpertInstructions: `你是工作流生成专长智能体。

你的领域专长是「workflow-generator」技能，它已在下方加载——严格遵循它：它定义了算子目录、对话动作到算子的映射、以及节点保留/丢弃标准。

仅在需要决定触发配置或调试节点时才读取定时任务、实时网络/控制台信息。你的输出是节点和边数据，以及技能描述的每步理由。`,
  builtinAgentAnalystDisplayName: '分析专家',
  builtinAgentAnalystHint:
    '结论优先的页面及网络/控制台证据分析，每个结论都需有来源。用于诊断页面问题或从页面证据中提取判断。',
  builtinAgentAnalystInstructions: `你是分析专长智能体：你的产出是基于证据的结论，而非操作过程。

规则：
- 结论优先：最多 5 个编号发现，按重要性排序。
- 每个发现都要附带来源：URL、网络请求（method + endpoint + status）或控制台消息。不允许无来源的断言。
- 不要叙述过程，不要把猜测当作事实。证据薄弱时简短说明置信度。
- 自己读取页面和网络/控制台日志；主管不会把页面转储交给你。
- 如果证据不足，返回 partial 状态：给出你有的发现，并列出还需要哪些额外证据。

保持整个报告密集且在消息大小限制内。`,

  // Workflow generation dialog
  workflowGenerationTitle: '工作流生成',
  workflowGenerationUnderstanding: '正在理解任务并确认目标终态…',
  workflowGenerationWorking: '正在执行任务…',
  workflowGenerationRecovering: '正在从失败动作中恢复…',
  workflowGenerationCompiling: '正在编译工作流…',
  workflowGenerationValidating: '正在校验并加固工作流…',
  workflowGenerationReady: '工作流已就绪',
  workflowGenerationPreparing: '正在整理工作流…',
  workflowGenerationPreparingHint: '正在编译并校验录制的步骤，可能需要几秒钟。',
  workflowGenerationSaved: '工作流已保存',
  workflowGenerationCancel: '取消生成',
  workflowGenerationBackground: '后台运行',
  workflowGenerationClose: '关闭',
  workflowGenerationError: '生成失败',
  workflowGenerationSave: '保存工作流',
  workflowGenerationEdit: '编辑',
  workflowGenerationDismiss: '取消',
  workflowGenerationReopen: '打开保存弹窗',
  workflowGenerationSavedDetail: '工作流已保存，可以开始运行。',
  workflowGenerationActionCount: ({ count }) => `已执行 ${count} 个动作`,
  workflowGenerationLogTitle: ({ count }) => `生成日志（${count} 条）`,
  workflowGenerationRecoveredCount: ({ count }) => `已恢复 ${count} 个问题`,

  // Workflow repair
  workflowRepairStarting: '正在启动自动修复…',
  workflowRepairDiagnosing: '正在分析失败步骤…',
  workflowRepairApplying: '正在应用修复…',
  workflowRepairVerifying: '正在验证修复…',
  workflowRepairSuccess: '工作流已自动修复',
  workflowRepairExhausted: '自动修复策略已耗尽',
  workflowRepairBlocked: '需要人工操作',
  workflowRepairNeedHuman: '人工接管',
  workflowRepairAutoTitle: 'AI 正在自动修复…',
  workflowRepairVerifiedDetail: '验证通过：工作流可独立运行。',
  workflowRepairRevisionCommitted: ({ revision }) => `已提交为第 ${revision} 个修订版本。`,
}

const DICTIONARIES: Record<Locale, Messages> = { en, 'zh-CN': zhCN }

/**
 * Maps a BCP-47 tag to a supported locale.
 *
 * Matching is by primary subtag, so `zh-TW`, `zh-Hans`, and bare `zh` all resolve
 * to the Chinese dictionary rather than silently falling back to English. That is
 * a deliberate trade-off: an imperfect Chinese match serves a Chinese reader far
 * better than English does.
 */
export function resolveLocale(tag: string | undefined): Locale {
  if (!tag) return 'en'
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  return 'en'
}

/** Resolves the stored setting against the browser's language. */
export function effectiveLocale(setting: LocaleSetting, browserTag?: string): Locale {
  if (setting === 'auto') return resolveLocale(browserTag)
  return LOCALES.includes(setting) ? setting : 'en'
}

/** Returns the dictionary for a locale. */
export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale] ?? en
}

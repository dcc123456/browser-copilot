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
  tabTasks: string
  tabWorkflows: string
  tabData: string
  tabSettings: string
  tabHistory: string
  tabMore: string

  // Panel minimize (floating page button)
  panelMinimize: string

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
  workflowsTriggerNone: string
  workflowsLastRun: string
  workflowsRunHistory: string
  workflowsRunStatusNever: string
  workflowsExport: string
  workflowsImport: string
  workflowsImportInvalid: string
  workflowsImported: (params: { count: number }) => string
  /** Shown on a failed-run banner in the Workflows tab; the banner is clickable and jumps to the run's history entry. */
  workflowsRunFailedHint: string
  /** Debug button on each workflow card: run once, then AI auto-repairs failures and re-runs. */
  workflowsDebug: string
  /** Debug button label while the AI debug loop is running for that workflow. */
  workflowsDebugging: string
  /** Banner when the debug run passed on the first attempt (no AI repair needed). */
  workflowsDebugOkNoChanges: string
  /** Banner when AI repairs made the workflow pass; {rounds} = applied fix rounds. */
  workflowsDebugFixed: (params: { rounds: number }) => string
  /** Banner when the AI debug loop ended without a passing run. */
  workflowsDebugFailed: string
  /** Debug report dialog title. */
  workflowsDebugReportTitle: string
  /** Debug report: per-round heading. */
  workflowsDebugRound: (params: { n: number }) => string
  /** Debug report: diagnosis label. */
  workflowsDebugDiagnosis: string
  /** Debug report: changes label. */
  workflowsDebugChanges: string
  /** Debug report: run outcome label. */
  workflowsDebugOutcome: string
  /** Debug report: strategy labels by repair kind. */
  workflowsDebugStrategyRetry: string
  workflowsDebugStrategyFix: string
  workflowsDebugStrategyBranch: string
  workflowsDebugStrategyAgent: string
  workflowsDebugStrategyRemove: string
  workflowsDebugStrategyUnfixable: string
  /** Live AI debug log modal. */
  workflowsDebugLogTitle: string
  /** Badge while the debug session is still running. */
  workflowsDebugLogLive: string
  /** Badge once the debug session has settled. */
  workflowsDebugLogDone: string
  /** Empty state before the first debug step lands. */
  workflowsDebugLogEmpty: string
  workflowsDebugLogClose: string
  /** Review chip on cards the AI debugger modified: hint with time + change count. */
  workflowsDebugBackupHint: (params: { time: string; changes: number }) => string
  workflowsDebugBackupKeep: string
  workflowsDebugBackupRevert: string
  /** Confirm dialog before reverting. */
  workflowsDebugRevertConfirm: string
  /** Banner after a successful revert. */
  workflowsDebugReverted: string
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
  chatSaveWorkflowSave: string
  chatSaveWorkflowSkip: string
  chatSaveWorkflowSaved: (params: { name: string }) => string
  /** Title of the AI-prefill checkbox list on the workflow save card. */
  chatSaveWorkflowAiTitle: string
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
  saveWorkflowLabel: string
  saveWorkflowHint: string
  modeChat: string
  modeReadonly: string
  modeSemi: string
  modeFull: string
  modeChatHint: string
  modeReadonlyHint: string
  modeSemiHint: string
  modeFullHint: string
  modeFullWarning: string

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
  /** Label of the "serve which connection" selector. */
  settingsLocalAgentActiveAgent: string
  /** Option value when the plugin serves every connected agent. */
  settingsLocalAgentActiveAgentAll: string
  /** Hint explaining the connection selector. */
  settingsLocalAgentActiveAgentHint: string
  /** "N agent connection(s) connected" suffix next to the selector hint. */
  settingsLocalAgentAgentsConnected: (params: { count: number }) => string
  settingsLocalAgentMcpTitle: string
  settingsLocalAgentMcpHint: string
  /** Short tab labels for the MCP snippet switcher. */
  settingsLocalAgentMcpTabClaude: string
  settingsLocalAgentMcpTabCodex: string
  settingsLocalAgentMcpTabTrae: string
  /** Hint that `__插件目录__` must be replaced with the absolute extension path. */
  settingsLocalAgentMcpPlaceholderHint: string
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
}

const en: Messages = {
  tabChat: 'Chat',
  tabSkills: 'Skills',
  tabTasks: 'Tasks',
  tabWorkflows: 'Workflows',
  tabData: 'Data',
  tabSettings: 'Settings',
  tabHistory: 'History',
  tabMore: 'More',
  panelMinimize: 'Minimize to a floating button',
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
  taskManualHint: 'No automatic schedule — run it yourself with "Run now" or trigger it from Feishu.',
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
  workflowsTriggerNone: 'No trigger',
  workflowsLastRun: 'Last run',
  workflowsRunHistory: 'Run history',
  workflowsRunStatusNever: 'Never',
  workflowsExport: 'Export',
  workflowsImport: 'Import',
  workflowsImportInvalid: 'Invalid workflow file(s): at least one export could not be read.',
  workflowsImported: ({ count }) => `Imported ${count} workflow(s).`,
  workflowsRunFailedHint: 'Run failed — click to view details in history',
  workflowsDebug: 'Debug',
  workflowsDebugging: 'Debugging…',
  workflowsDebugOkNoChanges: 'Run succeeded — nothing to debug',
  workflowsDebugFixed: ({ rounds }) => `AI debug succeeded after ${rounds} fix round(s)`,
  workflowsDebugFailed: 'AI debug could not fix this workflow',
  workflowsDebugReportTitle: 'AI debug report',
  workflowsDebugRound: ({ n }) => `Round ${n}`,
  workflowsDebugDiagnosis: 'Diagnosis',
  workflowsDebugChanges: 'Changes',
  workflowsDebugOutcome: 'Result',
  workflowsDebugStrategyRetry: 'Add retry',
  workflowsDebugStrategyFix: 'Fix parameters',
  workflowsDebugStrategyBranch: 'Add conditional branch',
  workflowsDebugStrategyAgent: 'Add AI agent step',
  workflowsDebugStrategyRemove: 'Remove redundant steps',
  workflowsDebugStrategyUnfixable: 'Not fixable automatically',
  workflowsDebugLogTitle: 'AI debug log',
  workflowsDebugLogLive: 'live',
  workflowsDebugLogDone: 'finished',
  workflowsDebugLogEmpty: 'Waiting for debug steps…',
  workflowsDebugLogClose: 'Close',
  workflowsDebugBackupHint: ({ time, changes }) =>
    `AI modified this workflow at ${time} (${changes} change(s)) — keep or revert`,
  workflowsDebugBackupKeep: 'Keep AI changes',
  workflowsDebugBackupRevert: 'Revert',
  workflowsDebugRevertConfirm: 'Revert this workflow to the version before AI debug?',
  workflowsDebugReverted: 'Reverted to the pre-debug version',
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
  chatAttachmentTooLarge: ({ name }) =>
    `${name} is too large (images ≤ 4 MB, text files ≤ 200 KB)`,
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
  chatApprove: 'Approve',
  chatDecline: 'Decline',
  chatConfirmTitle: ({ name }) => `Allow ${name}?`,
  chatSkillActive: ({ name }) => `Skill: ${name}`,
  chatSkillGo: ({ name }) => `Apply the "${name}" skill now.`,
  chatSkillGoSelection: ({ name }) =>
    `Apply the "${name}" skill to the text I selected on the page.`,
  chatPlaceholderWithSkills:
    'Message… (Enter to send, Shift+Enter for a new line, / for skills)',
  chatSlashNoMatch: 'No matching skill',
  chatSaveWorkflowPrompt: ({ steps }) =>
    `This session performed ${steps} step${steps > 1 ? 's' : ''} that can be reused. Save them as a workflow?`,
  chatSaveWorkflowSave: 'Save as workflow',
  chatSaveWorkflowSkip: 'Skip',
  chatSaveWorkflowSaved: ({ name }) => `Saved workflow: ${name}`,
  chatSaveWorkflowAiTitle: 'AI-generated content (checked = regenerate with AI at replay; unchecked = reuse the captured text)',
  chatWorkflowReviewing: 'AI is reviewing which nodes are worth keeping…',
  chatWorkflowReviewUnavailable: 'AI review unavailable — keeping all steps.',
  chatWorkflowReviewDropped: ({ count }) => `AI dropped ${count} ineffective step${count > 1 ? 's' : ''} (unchecked); check to keep one.`,
  chatWorkflowReviewAllKept: 'AI reviewed every step — none look ineffective.',
  chatWorkflowStepsTitle: 'Steps (uncheck to remove from the workflow)',
  workflowReviewDialogTitle: 'Review steps before saving',
  workflowReviewDialogConfirm: 'Save workflow',
  workflowReviewDialogCancel: 'Cancel',
  workflowReviewDialogRetry: 'Retry review',
  workflowReviewLogTitle: 'Review log',
  workflowReviewLogCollapse: 'Collapse',
  workflowReviewLogExpand: 'Expand',
  workflowReviewLogStart: ({ steps }) => `Sent ${steps} step${steps > 1 ? 's' : ''} to the AI reviewer…`,
  workflowReviewLogFailed: 'Review failed — keeping every step. Click “Retry review” to try again.',

  modeLabel: 'Mode',
  saveWorkflowLabel: 'Save workflow',
  saveWorkflowHint:
    'Execute step by step (slower) so every action is recorded and can be saved as a workflow.',
  modeChat: 'Chat',
  modeReadonly: 'Read only',
  modeSemi: 'Semi-auto',
  modeFull: 'Full auto',
  modeChatHint: 'Plain conversation. No operating rules or tools are sent, so it cannot read or act on the page, and uses the fewest tokens.',
  modeReadonlyHint: 'Can read pages and answer, but cannot click, type, or navigate.',
  modeSemiHint: 'Each action is shown to you for approval before it runs.',
  modeFullHint: 'The agent acts without asking each time. Watch the log.',
  modeFullWarning:
    'Full auto lets the agent click, type, and navigate without each approval. Use only on sites you trust, and review the action history afterwards.',

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
  settingsImageModelIntro:
    'Select any already-configured provider to reuse its base URL and API key for the recognize_image tool (CAPTCHA, image text). Re-enter a model only if that provider’s default is not vision-capable.',
  settingsImageModelProvider: 'Provider',
  settingsImageModelAuto: 'Auto (use the active chat provider)',
  settingsImageModelFetchNoProvider:
    'Select a provider first — its saved credentials are reused and nothing needs to be re-entered.',
  settingsImageModelProviderMissing:
    'The selected provider is no longer in the list. Pick another provider or “Auto”.',
  settingsImageModelSaved: 'Image recognition model saved.',
  settingsOcrLanguage: 'Local OCR language',
  settingsOcrLanguageIntro:
    'Languages Tesseract.js tries when reading text offline. This runs first, before the image model; if it returns nothing, the image model below is used.',
  settingsSaving: 'Saving…',
  settingsApiKey: 'API key',
  settingsShowKey: 'Show key',
  settingsModel: 'Model',
  settingsModelsAvailable: ({ count }) => `${count} model(s) available — pick one from the dropdown.`,
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
    'All data (settings, conversations, tasks, workflows) is saved as plain JSON files in a folder you choose, instead of the browser\u2019s internal storage. The browser cache keeps a mirror so the extension keeps working offline.',
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
    'Adapter not running: start Claude Code / Codex / Trae and it reconnects automatically.',
  settingsLocalAgentActiveAgent: 'Serve connection',
  settingsLocalAgentActiveAgentAll: 'All connections (default)',
  settingsLocalAgentActiveAgentHint:
    'Only requests from the selected connection are executed; others are refused until you switch back to "all".',
  settingsLocalAgentAgentsConnected: ({ count }) =>
    `${count} connection${count === 1 ? '' : 's'} connected`,
  settingsLocalAgentMcpTitle: 'MCP config',
  settingsLocalAgentMcpHint:
    'Add ONE stdio MCP server; it auto-spawns the adapter and the plugin connects automatically.',
  settingsLocalAgentMcpTabClaude: 'Claude Code',
  settingsLocalAgentMcpTabCodex: 'Codex',
  settingsLocalAgentMcpTabTrae: 'Trae',
  settingsLocalAgentMcpPlaceholderHint:
    'Replace __插件目录__ with the absolute path of this extension.',
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
    'Credentials are stored in this extension\'s local storage on this machine (never synced). Anyone with access to your browser profile can read them — do not save high-value passwords on a shared device.',
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

  confirmActionHint:
    'The assistant wants to perform the action below. Approve to let it run once.',

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
}

const zhCN: Messages = {
  tabChat: '对话',
  tabSkills: '技能',
  tabTasks: '任务',
  tabWorkflows: '工作流',
  tabData: '数据',
  tabSettings: '设置',
  tabHistory: '历史',
  tabMore: '更多',
  panelMinimize: '最小化为悬浮按钮',
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
  tasksSubtitle:
    '按计划运行任务，并可通过飞书通知结果。定时任务仅在浏览器打开时触发。',
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
  taskMaxRoundsHint:
    '该任务无人值守时最多进行多少轮"模型↔工具"往返。独立于全局设置，默认 50。',
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
  workflowsTriggerNone: '无触发器',
  workflowsLastRun: '上次运行',
  workflowsRunHistory: '运行历史',
  workflowsRunStatusNever: '未运行',
  workflowsExport: '导出',
  workflowsImport: '导入',
  workflowsImportInvalid: '无效的工作流文件：至少一个导出无法读取。',
  workflowsImported: ({ count }) => `已导入 ${count} 个工作流。`,
  workflowsRunFailedHint: '运行失败 — 点击查看历史详情',
  workflowsDebug: '调试',
  workflowsDebugging: '调试中…',
  workflowsDebugOkNoChanges: '运行成功，无需调试',
  workflowsDebugFixed: ({ rounds }) => `AI 调试成功：经 ${rounds} 轮修复后运行通过`,
  workflowsDebugFailed: 'AI 调试未能修复该工作流',
  workflowsDebugReportTitle: 'AI 调试报告',
  workflowsDebugRound: ({ n }) => `第 ${n} 轮`,
  workflowsDebugDiagnosis: '诊断',
  workflowsDebugChanges: '变更内容',
  workflowsDebugOutcome: '运行结果',
  workflowsDebugStrategyRetry: '增加重试',
  workflowsDebugStrategyFix: '修正参数',
  workflowsDebugStrategyBranch: '增加条件分支',
  workflowsDebugStrategyAgent: '增加 AI 智能节点',
  workflowsDebugStrategyRemove: '删除冗余节点',
  workflowsDebugStrategyUnfixable: '无法自动修复',
  workflowsDebugLogTitle: 'AI 调试日志',
  workflowsDebugLogLive: '进行中',
  workflowsDebugLogDone: '已结束',
  workflowsDebugLogEmpty: '等待调试步骤…',
  workflowsDebugLogClose: '关闭',
  workflowsDebugBackupHint: ({ time, changes }) =>
    `AI 已修改此工作流（${time}，${changes} 处变更），可保留或回退`,
  workflowsDebugBackupKeep: '保留 AI 修改',
  workflowsDebugBackupRevert: '回退',
  workflowsDebugRevertConfirm: '回退到 AI 调试前的版本？',
  workflowsDebugReverted: '已回退到 AI 调试前的版本',
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
  chatApprove: '允许',
  chatDecline: '拒绝',
  chatConfirmTitle: ({ name }) => `是否允许执行 ${name}？`,
  chatSkillActive: ({ name }) => `技能：${name}`,
  chatSkillGo: ({ name }) => `请使用"${name}"技能处理。`,
  chatSkillGoSelection: ({ name }) => `请用"${name}"技能处理我在页面上选中的内容。`,
  chatPlaceholderWithSkills: '输入消息…（Enter 发送，Shift+Enter 换行，/ 选择技能）',
  chatSlashNoMatch: '没有匹配的技能',
  chatSaveWorkflowPrompt: ({ steps }) =>
    `本次会话共执行了 ${steps} 步可复用操作，是否保存为工作流？`,
  chatSaveWorkflowSave: '保存为工作流',
  chatSaveWorkflowSkip: '跳过',
  chatSaveWorkflowSaved: ({ name }) => `已保存工作流：${name}`,
  chatSaveWorkflowAiTitle: 'AI 生成内容（勾选 = 回放时用 AI 重新生成；取消 = 沿用本次填写的文本）',
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
  saveWorkflowLabel: '保存工作流',
  saveWorkflowHint: '逐条执行（较慢），每个动作都会记录，可完整保存为工作流。',
  modeChat: '聊天',
  modeReadonly: '只读',
  modeSemi: '半自动',
  modeFull: '全自动',
  modeChatHint: '纯对话。不发送操作规则和工具，因此不能读取或操作页面，token 消耗最低。',
  modeReadonlyHint: '只能读取页面和回答问题，不能点击、输入或跳转。',
  modeSemiHint: '每个改变页面的操作都会先请你确认。',
  modeFullHint: '智能体直接操作，不再每次询问。请留意操作记录。',
  modeFullWarning:
    '全自动模式下智能体可自行点击、输入和跳转，无需逐项确认。建议仅在你信任的网站使用，并事后查看操作记录。',

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
  settingsImageModelIntro:
    '从已添加的提供商中选择即可复用其接口地址和 API 密钥，用于 recognize_image 工具（验证码、图片文字）。仅当该提供商默认模型不支持视觉时才需要手动填模型名。',
  settingsImageModelProvider: '模型提供商',
  settingsImageModelAuto: '自动（使用当前对话模型）',
  settingsImageModelFetchNoProvider:
    '请先选择提供商——将复用其已保存的接口地址和 API 密钥，无需重新填写。',
  settingsImageModelProviderMissing: '所选提供商已不在列表中，请重新选择或使用“自动”。',
  settingsImageModelSaved: '图片识别模型已保存。',
  settingsOcrLanguage: '本地 OCR 语言',
  settingsOcrLanguageIntro:
    'Tesseract.js 离线识别图片文字时的语言。会先于图像模型执行；若 OCR 无结果，再回退到下方配置的图像模型。',
  settingsSaving: '保存中…',
  settingsApiKey: 'API 密钥',
  settingsShowKey: '显示密钥',
  settingsModel: '模型',
  settingsModelsAvailable: ({ count }) => `共 ${count} 个可用模型，请从下拉列表中选择。`,
  settingsImageModelSelectHint: '从下拉列表中选择模型；若列表为空请先点击“获取模型列表”。留空使用该 provider 的默认模型。',
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
    '所有数据（设置、对话、任务、工作流）都会以 JSON 文件形式保存在你选择的文件夹中，而不是浏览器内置存储里。浏览器缓存会保留一份镜像，保证插件离线也能正常工作。',
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
    '本地适配器未运行：启动 Claude Code / Codex / Trae 后会自动重连。',
  settingsLocalAgentActiveAgent: '服务连接',
  settingsLocalAgentActiveAgentAll: '全部连接（默认）',
  settingsLocalAgentActiveAgentHint:
    '只执行所选连接发来的请求，其余连接会被拒绝，直到切回“全部连接”。',
  settingsLocalAgentAgentsConnected: ({ count }) => `已接入 ${count} 个连接`,
  settingsLocalAgentMcpTitle: 'MCP 配置',
  settingsLocalAgentMcpHint: '添加一个 stdio MCP 服务，助手会自动拉起适配器并自动连上。',
  settingsLocalAgentMcpTabClaude: 'Claude Code',
  settingsLocalAgentMcpTabCodex: 'Codex',
  settingsLocalAgentMcpTabTrae: 'Trae',
  settingsLocalAgentMcpPlaceholderHint: '将 __插件目录__ 替换为插件的绝对路径。',
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
  skillsImportResultFail: ({ ok, failed }) => `导入完成：成功 ${ok} 个，失败 ${failed} 个，详情见上方提示。`,
  skillsExportAll: '全部导出',
  skillsImportNameTaken: ({ name }) => `已跳过 “${name}”：同名技能已存在。`,
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

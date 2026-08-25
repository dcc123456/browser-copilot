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
  tabData: string
  tabSettings: string

  // Tasks
  tasksTitle: string
  tasksSubtitle: string
  taskNew: string
  taskName: string
  taskKind: string
  taskKindGithub: string
  taskKindPrompt: string
  taskPrompt: string
  taskPromptHint: string
  taskSchedule: string
  taskSchedDaily: string
  taskSchedWeekdays: string
  taskSchedInterval: string
  taskEvery: string
  taskMinutes: string
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

  // Common
  save: string
  cancel: string
  edit: string
  delete: string
  loading: string
  tryAgain: string
  reloadPanel: string

  // Chat
  chatEmpty: string
  chatPlaceholder: string
  chatSend: string
  chatStop: string
  chatNewChat: string
  chatAttachPage: string
  chatReadingPage: string
  chatReattached: string
  chatConnectionDropped: string
  chatExtensionReloaded: string
  chatApprove: string
  chatDecline: string
  chatConfirmTitle: (params: { name: string }) => string
  chatSkillActive: (params: { name: string }) => string
  /** Composer hint shown once at least one skill exists. */
  chatPlaceholderWithSkills: string
  /** Shown in the slash menu when no skill matches what was typed. */
  chatSlashNoMatch: string

  // Agent mode
  modeLabel: string
  modeReadonly: string
  modeSemi: string
  modeFull: string
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
  settingsUseThis: string
  settingsActive: string
  settingsKeyConfigured: string
  settingsNoKey: string
  settingsName: string
  settingsBaseUrl: string
  settingsBaseUrlHint: string
  settingsApiKey: string
  settingsShowKey: string
  settingsModel: string
  settingsModelsAvailable: (params: { count: number }) => string
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
  settingsTools: string
  settingsToolsHint: string
  settingsToolsEnableAll: string
  settingsToolsDisableAll: string
  toolReadPage: string
  toolReadPageWarn: string
  toolSnapshot: string
  toolSnapshotWarn: string
  toolListTabs: string
  toolListTabsWarn: string
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
  toolProfile: string
  toolProfileWarn: string
  toolListSecrets: string
  toolListSecretsWarn: string
  toolSecret: string
  toolSecretWarn: string
  toolSkill: string
  toolSkillWarn: string

  // Settings · page access
  settingsPageAccess: string
  settingsPageAccessIntro: string
  settingsCheckTab: string
  settingsPageReadable: (params: { title: string }) => string
  settingsPageBlocked: (params: { reason: string }) => string

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
}

const en: Messages = {
  tabChat: 'Chat',
  tabSkills: 'Skills',
  tabTasks: 'Tasks',
  tabData: 'Data',
  tabSettings: 'Settings',

  tasksTitle: 'Run tasks',
  tasksSubtitle:
    'Run a task on a schedule and optionally deliver the result to Feishu. Scheduled runs only fire while the browser is open.',
  taskNew: 'New task',
  taskName: 'Name',
  taskKind: 'What it does',
  taskKindGithub: 'Count PRs waiting for my review on GitHub',
  taskKindPrompt: 'Run an agent prompt',
  taskPrompt: 'Prompt',
  taskPromptHint: 'The instruction the agent runs unattended.',
  taskSchedule: 'When',
  taskSchedDaily: 'Daily at',
  taskSchedWeekdays: 'Weekdays (Mon–Fri) at',
  taskSchedInterval: 'Every',
  taskEvery: 'every',
  taskMinutes: 'minutes',
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

  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  loading: 'Loading…',
  tryAgain: 'Try again',
  reloadPanel: 'Reload panel',

  chatEmpty: 'Ask about the page you are looking at, or anything else.',
  chatPlaceholder: 'Message… (Enter to send, Shift+Enter for a new line)',
  chatSend: 'Send',
  chatStop: 'Stop',
  chatNewChat: 'New chat',
  chatAttachPage: 'Attach current page',
  chatReadingPage: 'Reading the current page…',
  chatReattached: 'Still working — reattached to the run.',
  chatConnectionDropped:
    'The connection dropped mid-reply. Any answer was saved to this conversation — send another message to continue.',
  chatExtensionReloaded:
    'The extension was reloaded. Reload it in chrome://extensions, then reopen this panel.',
  chatApprove: 'Approve',
  chatDecline: 'Decline',
  chatConfirmTitle: ({ name }) => `Allow ${name}?`,
  chatSkillActive: ({ name }) => `Skill: ${name}`,
  chatPlaceholderWithSkills:
    'Message… (Enter to send, Shift+Enter for a new line, / for skills)',
  chatSlashNoMatch: 'No matching skill',

  modeLabel: 'Mode',
  modeReadonly: 'Read only',
  modeSemi: 'Semi-auto',
  modeFull: 'Full auto',
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
  settingsUseThis: 'Use this',
  settingsActive: 'active',
  settingsKeyConfigured: 'key configured',
  settingsNoKey: 'no key — the agent will fail',
  settingsName: 'Name',
  settingsBaseUrl: 'Base URL',
  settingsBaseUrlHint:
    'Everything up to but not including /chat/completions. A pasted full URL is trimmed automatically.',
  settingsApiKey: 'API key',
  settingsShowKey: 'Show key',
  settingsModel: 'Model',
  settingsModelsAvailable: ({ count }) =>
    `${count} model(s) available — click the field for suggestions.`,
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
  settingsTools: 'Tools',
  settingsToolsHint:
    'Each enabled tool adds its parameter definition to every request. Disable tools you never use; the assistant simply will not see them.',
  settingsToolsEnableAll: 'Enable all',
  settingsToolsDisableAll: 'Disable all',
  toolReadPage: 'Read page text',
  toolReadPageWarn: 'Disabled: the assistant cannot read the text of the current page.',
  toolSnapshot: 'Snapshot page elements',
  toolSnapshotWarn:
    'Disabled: the assistant cannot see buttons, links, or fields, so it cannot reliably click or fill anything.',
  toolListTabs: 'List open tabs',
  toolListTabsWarn: 'Disabled: the assistant cannot see or refer to your other open tabs.',
  toolClick: 'Click elements',
  toolClickWarn: 'Disabled: the assistant cannot click buttons or links.',
  toolFill: 'Type into fields',
  toolFillWarn: 'Disabled: the assistant cannot type text into inputs or textareas.',
  toolSelect: 'Select dropdown options',
  toolSelectWarn: 'Disabled: the assistant cannot choose options from <select> dropdowns.',
  toolCheckbox: 'Check / uncheck boxes',
  toolCheckboxWarn: 'Disabled: the assistant cannot tick or untick checkboxes or radio buttons.',
  toolPressKey: 'Press keys',
  toolPressKeyWarn:
    'Disabled: the assistant cannot press Enter, Tab, Escape, or other keyboard shortcuts.',
  toolScroll: 'Scroll the page',
  toolScrollWarn:
    'Disabled: the assistant cannot reveal off-screen content (lazy-loaded lists, “View more”, long articles).',
  toolWait: 'Wait for an element',
  toolWaitWarn:
    'Disabled: the assistant cannot wait for content to appear after a load or navigation.',
  toolOpenUrl: 'Open a URL',
  toolOpenUrlWarn: 'Disabled: the assistant cannot open a URL directly in the current tab.',
  toolTabNew: 'Open a new tab',
  toolTabNewWarn: 'Disabled: the assistant cannot open new tabs.',
  toolTabSwitch: 'Switch tabs',
  toolTabSwitchWarn: 'Disabled: the assistant cannot switch between open tabs.',
  toolTabClose: 'Close a tab',
  toolTabCloseWarn: 'Disabled: the assistant cannot close tabs.',
  toolProfile: 'Use saved profile',
  toolProfileWarn:
    'Disabled: the assistant cannot see your saved name/email/address to auto-fill personal forms.',
  toolListSecrets: 'List saved secrets',
  toolListSecretsWarn:
    'Disabled: the assistant cannot see your saved key/value secrets by label, so it cannot decide which to fill.',
  toolSecret: 'Fill a saved secret',
  toolSecretWarn:
    'Disabled: the assistant cannot fill saved passwords or secret fields (you would have to type them).',
  toolSkill: 'Use a skill',
  toolSkillWarn: 'Disabled: the assistant cannot load or apply saved skills.',

  settingsPageAccess: 'Page access',
  settingsPageAccessIntro:
    'The assistant reads a page by injecting a one-off read-only script, so it only works on ordinary http(s) tabs — not on chrome:// pages, the Web Store, or local files.',
  settingsCheckTab: 'Check active tab',
  settingsPageReadable: ({ title }) => `The active tab can be read: ${title}`,
  settingsPageBlocked: ({ reason }) => `The active tab cannot be read. ${reason}`,

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
}

const zhCN: Messages = {
  tabChat: '对话',
  tabSkills: '技能',
  tabTasks: '任务',
  tabData: '数据',
  tabSettings: '设置',

  tasksTitle: '运行任务',
  tasksSubtitle:
    '按计划运行任务，并可通过飞书通知结果。定时任务仅在浏览器打开时触发。',
  taskNew: '新建任务',
  taskName: '名称',
  taskKind: '做什么',
  taskKindGithub: '统计 GitHub 上待我 review 的 PR',
  taskKindPrompt: '运行一条智能体提示词',
  taskPrompt: '提示词',
  taskPromptHint: '无人值守时智能体执行的指令。',
  taskSchedule: '时间',
  taskSchedDaily: '每天',
  taskSchedWeekdays: '工作日（周一至周五）',
  taskSchedInterval: '每隔',
  taskEvery: '每隔',
  taskMinutes: '分钟',
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

  save: '保存',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',
  loading: '加载中…',
  tryAgain: '重试',
  reloadPanel: '重新加载面板',

  chatEmpty: '可以询问当前正在浏览的页面，或任何其他问题。',
  chatPlaceholder: '输入消息…（Enter 发送，Shift+Enter 换行）',
  chatSend: '发送',
  chatStop: '停止',
  chatNewChat: '新对话',
  chatAttachPage: '附带当前页面',
  chatReadingPage: '正在读取当前页面…',
  chatReattached: '任务仍在进行，已重新接入。',
  chatConnectionDropped: '回复过程中连接中断。已生成的内容已保存到本次对话——再发一条消息即可继续。',
  chatExtensionReloaded: '扩展已重新加载。请在 chrome://extensions 中重载，然后重新打开此面板。',
  chatApprove: '允许',
  chatDecline: '拒绝',
  chatConfirmTitle: ({ name }) => `是否允许执行 ${name}？`,
  chatSkillActive: ({ name }) => `技能：${name}`,
  chatPlaceholderWithSkills: '输入消息…（Enter 发送，Shift+Enter 换行，/ 选择技能）',
  chatSlashNoMatch: '没有匹配的技能',

  modeLabel: '模式',
  modeReadonly: '只读',
  modeSemi: '半自动',
  modeFull: '全自动',
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
  settingsUseThis: '使用这个',
  settingsActive: '使用中',
  settingsKeyConfigured: '已配置密钥',
  settingsNoKey: '未配置密钥——agent 将无法工作',
  settingsName: '名称',
  settingsBaseUrl: '接口地址',
  settingsBaseUrlHint: '填到 /chat/completions 之前的部分即可。粘贴完整地址会自动裁剪。',
  settingsApiKey: 'API 密钥',
  settingsShowKey: '显示密钥',
  settingsModel: '模型',
  settingsModelsAvailable: ({ count }) => `共 ${count} 个可用模型——点击输入框查看建议。`,
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
  settingsTools: '工具',
  settingsToolsHint:
    '每个启用的工具都会把其参数定义加入每次请求。关闭你用不到的工具，助手就看不到它。',
  settingsToolsEnableAll: '全部启用',
  settingsToolsDisableAll: '全部关闭',
  toolReadPage: '读取页面文本',
  toolReadPageWarn: '已关闭：助手无法读取当前页面的文本。',
  toolSnapshot: '快照页面元素',
  toolSnapshotWarn: '已关闭：助手无法看到按钮、链接、输入框，因此无法可靠地点击或填写。',
  toolListTabs: '列出标签页',
  toolListTabsWarn: '已关闭：助手无法查看或引用你打开的其他标签页。',
  toolClick: '点击元素',
  toolClickWarn: '已关闭：助手无法点击按钮或链接。',
  toolFill: '在输入框中输入',
  toolFillWarn: '已关闭：助手无法在输入框或文本域中输入文字。',
  toolSelect: '选择下拉选项',
  toolSelectWarn: '已关闭：助手无法在下拉框（<select>）中选择选项。',
  toolCheckbox: '勾选/取消复选框',
  toolCheckboxWarn: '已关闭：助手无法勾选或取消复选框、单选按钮。',
  toolPressKey: '按键',
  toolPressKeyWarn: '已关闭：助手无法按回车、Tab、Esc 等键盘快捷键。',
  toolScroll: '滚动页面',
  toolScrollWarn: '已关闭：助手无法显示屏幕外的内容（懒加载列表、“查看更多”、长文章）。',
  toolWait: '等待元素出现',
  toolWaitWarn: '已关闭：助手无法在加载或导航后等待内容出现。',
  toolOpenUrl: '打开网址',
  toolOpenUrlWarn: '已关闭：助手无法直接在当前标签页打开网址。',
  toolTabNew: '新建标签页',
  toolTabNewWarn: '已关闭：助手无法新建标签页。',
  toolTabSwitch: '切换标签页',
  toolTabSwitchWarn: '已关闭：助手无法在已打开的标签页之间切换。',
  toolTabClose: '关闭标签页',
  toolTabCloseWarn: '已关闭：助手无法关闭标签页。',
  toolProfile: '使用已保存资料',
  toolProfileWarn: '已关闭：助手无法读取你保存的姓名/邮箱/地址来自动填写个人表单。',
  toolListSecrets: '列出已保存密钥',
  toolListSecretsWarn: '已关闭：助手无法按名称查看你保存的键值密钥，无法决定该填哪一项。',
  toolSecret: '填写已保存密钥',
  toolSecretWarn: '已关闭：助手无法填写已保存的密码或密钥字段（需要你手动输入）。',
  toolSkill: '使用技能',
  toolSkillWarn: '已关闭：助手无法加载或应用已保存的技能。',

  settingsPageAccess: '页面读取权限',
  settingsPageAccessIntro:
    '助手读取页面时会临时注入一段只读脚本，因此仅在普通 http(s) 标签页有效——chrome:// 页面、应用商店和本地文件都无法读取。',
  settingsCheckTab: '检测当前标签页',
  settingsPageReadable: ({ title }) => `当前标签页可以读取：${title}`,
  settingsPageBlocked: ({ reason }) => `当前标签页无法读取。${reason}`,

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

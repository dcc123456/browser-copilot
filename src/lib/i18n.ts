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
  tabData: string
  tabSettings: string

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
  dataShowPassword: string
  dataHistory: string
  dataHistoryIntro: string
  dataHistoryEmpty: string
  dataClearHistory: string
  dataHistoryWhen: string
  dataConversation: string
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
  tabData: 'Data',
  tabSettings: 'Settings',

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
  dataShowPassword: 'Show',
  dataHistory: 'Action history',
  dataHistoryIntro:
    'A log of every page action the agent performed, so you can review or delete what happened.',
  dataHistoryEmpty: 'No actions recorded yet.',
  dataClearHistory: 'Clear all',
  dataHistoryWhen: 'When',
  dataConversation: 'Conversation',
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
  tabData: '数据',
  tabSettings: '设置',

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
  dataShowPassword: '显示',
  dataHistory: '操作记录',
  dataHistoryIntro: '助手在网页上执行过的每一步操作记录，可随时查看或删除。',
  dataHistoryEmpty: '暂无操作记录。',
  dataClearHistory: '全部清空',
  dataHistoryWhen: '时间',
  dataConversation: '会话',
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

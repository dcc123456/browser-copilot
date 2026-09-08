import { useCallback, useEffect, useState } from 'react'
import { api, setToken, type ConfigResponse, type ConfigView } from '../api'
import { Badge, Btn, Card, Field, Notice, inputClass } from '../ui'

/** Which UI field is shadowed by which env var (matches config-store.envOverrides). */
const ENV_OF: Record<string, string> = {
  'llm.baseUrl': 'BC_LLM_BASE_URL',
  'llm.apiKey': 'BC_LLM_API_KEY',
  'llm.model': 'BC_LLM_MODEL',
  'feishu.botEnabled': 'BC_FEISHU_BOT_ENABLED',
  'feishu.appId': 'BC_FEISHU_APP_ID',
  'feishu.appSecret': 'BC_FEISHU_APP_SECRET',
  'feishu.webhookUrl': 'BC_FEISHU_WEBHOOK_URL',
  'feishu.webhookSecret': 'BC_FEISHU_WEBHOOK_SECRET',
  'browser.mode': 'BC_BROWSER_MODE',
  'browser.cdpEndpoint': 'BC_CDP_ENDPOINT',
  'browser.headless': 'BC_BROWSER_HEADLESS',
  'browser.maxConcurrent': 'BC_MAX_CONCURRENT',
  token: 'BC_TOKEN',
  runTimeoutMs: 'BC_RUN_TIMEOUT_MS',
}

function EnvWarn({ field, overrides }: { field: string; overrides: string[] }) {
  if (!overrides.includes(field)) return null
  return <span className="mt-1 block text-xs text-warn">被环境变量 {ENV_OF[field]} 覆盖，修改配置文件不会生效</span>
}

type SaveState = { tone: 'ok' | 'err'; text: string } | null

export function SettingsPage({ onTokenChanged }: { onTokenChanged: () => void }) {
  const [config, setConfig] = useState<ConfigView | null>(null)
  const [overrides, setOverrides] = useState<string[]>([])
  const [feishuConnected, setFeishuConnected] = useState(false)
  const [restartRequired, setRestartRequired] = useState<string[]>([])

  // Form inputs. Secret inputs hold ONLY newly typed values (empty = keep).
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const [feishuBotEnabled, setFeishuBotEnabled] = useState(false)
  const [feishuAppId, setFeishuAppId] = useState('')
  const [feishuAppSecret, setFeishuAppSecret] = useState('')
  const [feishuWebhookUrl, setFeishuWebhookUrl] = useState('')
  const [feishuWebhookSecret, setFeishuWebhookSecret] = useState('')
  const [newToken, setNewToken] = useState('')
  const [browserMode, setBrowserMode] = useState<'local' | 'cdp'>('local')
  const [cdpEndpoint, setCdpEndpoint] = useState('')
  const [headless, setHeadless] = useState(true)
  const [maxConcurrent, setMaxConcurrent] = useState(2)
  const [runTimeoutMs, setRunTimeoutMs] = useState(600_000)

  const [llmSave, setLlmSave] = useState<SaveState>(null)
  const [feishuSave, setFeishuSave] = useState<SaveState>(null)
  const [tokenSave, setTokenSave] = useState<SaveState>(null)
  const [browserSave, setBrowserSave] = useState<SaveState>(null)
  const [llmTest, setLlmTest] = useState<SaveState>(null)
  const [feishuTest, setFeishuTest] = useState<SaveState>(null)

  const applyConfig = useCallback((response: ConfigResponse): void => {
    setConfig(response.config)
    setOverrides(response.envOverrides)
    setFeishuConnected(response.feishuConnected)
    setLlmBaseUrl(response.config.llm.baseUrl)
    setLlmModel(response.config.llm.model)
    setFeishuBotEnabled(response.config.feishu.botEnabled)
    setFeishuAppId(response.config.feishu.appId)
    setFeishuWebhookUrl(response.config.feishu.webhookUrl)
    setBrowserMode(response.config.browser.mode)
    setCdpEndpoint(response.config.browser.cdpEndpoint)
    setHeadless(response.config.browser.headless)
    setMaxConcurrent(response.config.browser.maxConcurrent)
    setRunTimeoutMs(response.config.runTimeoutMs)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      applyConfig(await api.get<ConfigResponse>('/api/config'))
    } catch (cause) {
      setLlmSave({ tone: 'err', text: (cause as Error).message })
    }
  }, [applyConfig])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (
    patch: Record<string, unknown>,
    setSave: (state: SaveState) => void,
    after?: (response: ConfigResponse) => void,
  ): Promise<void> => {
    try {
      const response = await api.put<ConfigResponse>('/api/config', patch)
      applyConfig(response)
      setSave({ tone: 'ok', text: '已保存并生效' })
      after?.(response)
    } catch (cause) {
      setSave({ tone: 'err', text: (cause as Error).message })
    }
  }

  const testLlm = async (): Promise<void> => {
    setLlmTest(null)
    try {
      const result = await api.post<{ ok: boolean; latencyMs?: number; sample?: string; error?: string }>(
        '/api/config/test-llm',
      )
      setLlmTest(
        result.ok
          ? { tone: 'ok', text: `连通正常（${result.latencyMs}ms）：${result.sample ?? ''}` }
          : { tone: 'err', text: result.error ?? '测试失败' },
      )
    } catch (cause) {
      setLlmTest({ tone: 'err', text: (cause as Error).message })
    }
  }

  const testFeishu = async (): Promise<void> => {
    setFeishuTest(null)
    try {
      const result = await api.post<{ ok: boolean; via?: string; hint?: string; error?: string }>(
        '/api/config/test-feishu',
      )
      setFeishuTest(
        result.ok
          ? { tone: 'ok', text: result.via === 'webhook' ? 'Webhook 推送成功' : (result.hint ?? '长连接在线') }
          : { tone: 'err', text: result.hint ?? result.error ?? '测试失败' },
      )
    } catch (cause) {
      setFeishuTest({ tone: 'err', text: (cause as Error).message })
    }
  }

  const secretPlaceholder = (secret: { set: boolean; masked: string }): string =>
    secret.set ? `已设置（${secret.masked}），留空保持不变` : '未设置'

  if (!config) return <p className="text-sm text-muted">加载中…</p>

  return (
    <div className="space-y-4">
      <h1 className="text-base font-semibold">设置</h1>

      <Card title="大模型（ai-agent / AI 接管）">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Base URL（OpenAI 兼容）" hint={<EnvWarn field="llm.baseUrl" overrides={overrides} />}>
            <input className={inputClass} value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} placeholder="https://api.deepseek.com/v1" />
          </Field>
          <Field label="模型名" hint={<EnvWarn field="llm.model" overrides={overrides} />}>
            <input className={inputClass} value={llmModel} onChange={(event) => setLlmModel(event.target.value)} placeholder="deepseek-chat" />
          </Field>
          <Field label="API Key" hint={<EnvWarn field="llm.apiKey" overrides={overrides} />}>
            <input
              className={inputClass}
              type="password"
              value={llmApiKey}
              onChange={(event) => setLlmApiKey(event.target.value)}
              placeholder={secretPlaceholder(config.llm.apiKey)}
            />
          </Field>
        </div>
        {llmSave && <div className="mt-3"><Notice tone={llmSave.tone}>{llmSave.text}</Notice></div>}
        {llmTest && <div className="mt-2"><Notice tone={llmTest.tone}>{llmTest.text}</Notice></div>}
        <div className="mt-3 flex justify-end gap-2">
          <Btn onClick={() => void testLlm()}>测试连接</Btn>
          <Btn
            tone="primary"
            onClick={() =>
              void save(
                { llm: { baseUrl: llmBaseUrl, model: llmModel, ...(llmApiKey ? { apiKey: llmApiKey } : {}) } },
                setLlmSave,
                () => setLlmApiKey(''),
              )
            }
          >
            保存
          </Btn>
        </div>
      </Card>

      <Card
        title="飞书机器人"
        actions={
          config.feishu.botEnabled ? (
            <Badge tone={feishuConnected ? 'ok' : 'warn'}>{feishuConnected ? '● 长连接在线' : '● 未连接'}</Badge>
          ) : (
            <Badge>未启用</Badge>
          )
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" checked={feishuBotEnabled} onChange={(event) => setFeishuBotEnabled(event.target.checked)} />
            启用飞书长连接机器人（私聊 /workflow 运行、/runs 查看）
          </label>
          <Field label="App ID" hint={<EnvWarn field="feishu.appId" overrides={overrides} />}>
            <input className={inputClass} value={feishuAppId} onChange={(event) => setFeishuAppId(event.target.value)} placeholder="cli_xxx" />
          </Field>
          <Field label="App Secret" hint={<EnvWarn field="feishu.appSecret" overrides={overrides} />}>
            <input
              className={inputClass}
              type="password"
              value={feishuAppSecret}
              onChange={(event) => setFeishuAppSecret(event.target.value)}
              placeholder={secretPlaceholder(config.feishu.appSecret)}
            />
          </Field>
          <Field label="群 Webhook（可选推送通道）" hint={<EnvWarn field="feishu.webhookUrl" overrides={overrides} />}>
            <input className={inputClass} value={feishuWebhookUrl} onChange={(event) => setFeishuWebhookUrl(event.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" />
          </Field>
          <Field label="Webhook 签名密钥（可选）" hint={<EnvWarn field="feishu.webhookSecret" overrides={overrides} />}>
            <input
              className={inputClass}
              type="password"
              value={feishuWebhookSecret}
              onChange={(event) => setFeishuWebhookSecret(event.target.value)}
              placeholder={secretPlaceholder(config.feishu.webhookSecret)}
            />
          </Field>
        </div>
        {feishuSave && <div className="mt-3"><Notice tone={feishuSave.tone}>{feishuSave.text}</Notice></div>}
        {feishuTest && <div className="mt-2"><Notice tone={feishuTest.tone}>{feishuTest.text}</Notice></div>}
        <div className="mt-3 flex justify-end gap-2">
          <Btn onClick={() => void testFeishu()}>测试</Btn>
          <Btn
            tone="primary"
            onClick={() =>
              void save(
                {
                  feishu: {
                    botEnabled: feishuBotEnabled,
                    appId: feishuAppId,
                    webhookUrl: feishuWebhookUrl,
                    ...(feishuAppSecret ? { appSecret: feishuAppSecret } : {}),
                    ...(feishuWebhookSecret ? { webhookSecret: feishuWebhookSecret } : {}),
                  },
                },
                setFeishuSave,
                () => {
                  setFeishuAppSecret('')
                  setFeishuWebhookSecret('')
                },
              )
            }
          >
            保存
          </Btn>
        </div>
      </Card>

      <Card title="安全（API Token）">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            当前状态：{config.token.set ? <Badge tone="ok">已设置（{config.token.masked}）</Badge> : <Badge tone="warn">未设置（API 无鉴权）</Badge>}
          </p>
          <Field label="新的 BC_TOKEN" hint={<EnvWarn field="token" overrides={overrides} />}>
            <input
              className={inputClass}
              type="password"
              value={newToken}
              onChange={(event) => setNewToken(event.target.value)}
              placeholder="输入新 Token；留空则不修改"
            />
          </Field>
          {tokenSave && <Notice tone={tokenSave.tone}>{tokenSave.text}</Notice>}
          <div className="flex justify-end">
            <Btn
              tone="primary"
              disabled={!newToken.trim()}
              onClick={() =>
                void save({ token: newToken.trim() }, setTokenSave, (response) => {
                  // Rotate the locally stored token so the console keeps working.
                  setToken(newToken.trim())
                  setNewToken('')
                  onTokenChanged()
                  void response
                })
              }
            >
              更新 Token
            </Btn>
          </div>
        </div>
      </Card>

      <Card title="浏览器与运行">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="浏览器模式" hint={<EnvWarn field="browser.mode" overrides={overrides} />}>
            <select className={inputClass} value={browserMode} onChange={(event) => setBrowserMode(event.target.value as 'local' | 'cdp')}>
              <option value="local">本地 Chromium</option>
              <option value="cdp">CDP 远端</option>
            </select>
          </Field>
          <Field label="CDP Endpoint" hint={browserMode === 'cdp' ? <EnvWarn field="browser.cdpEndpoint" overrides={overrides} /> : 'cdp 模式必填，如 ws://127.0.0.1:9222'}>
            <input className={`${inputClass} font-mono`} value={cdpEndpoint} onChange={(event) => setCdpEndpoint(event.target.value)} placeholder="ws://127.0.0.1:9222" />
          </Field>
          <Field label="并发运行数（热生效）" hint={<EnvWarn field="browser.maxConcurrent" overrides={overrides} />}>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={16}
              value={maxConcurrent}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
            />
          </Field>
          <Field label="单次运行超时 ms（热生效）" hint={<EnvWarn field="runTimeoutMs" overrides={overrides} />}>
            <input
              className={inputClass}
              type="number"
              min={1000}
              step={1000}
              value={runTimeoutMs}
              onChange={(event) => setRunTimeoutMs(Number(event.target.value))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={headless} onChange={(event) => setHeadless(event.target.checked)} />
            无头模式
          </label>
        </div>
        {browserSave && <div className="mt-3"><Notice tone={browserSave.tone}>{browserSave.text}</Notice></div>}
        <p className="mt-2 text-xs text-faint">
          端口（当前 {config.port}）与浏览器模式/无头/CDP 需重启进程生效；并发数与超时立即生效。
        </p>
        <div className="mt-3 flex justify-end">
          <Btn
            tone="primary"
            onClick={() =>
              void save(
                {
                  browser: { mode: browserMode, cdpEndpoint, headless, maxConcurrent },
                  runTimeoutMs,
                },
                setBrowserSave,
              )
            }
          >
            保存
          </Btn>
        </div>
      </Card>
    </div>
  )
}

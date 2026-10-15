/**
 * The Runner half of the notification block's Feishu leg. It must behave like the
 * extension executor (spec `specs/2026-10-15-notification-feishu-and-goal-free-design.md`
 * §3.2): send through the runner's own `config.feishu`, and log delivery problems
 * instead of failing a run whose work is already done.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RunDriver } from '../src/driver'
import type { RunnerConfig } from '../src/config'
import { createExecutors } from '../src/executors'
import { sendWebhookText } from '../../src/lib/feishu'
import type { WorkflowExecCtx } from '../../src/background/workflow-engine/executors'

vi.mock('../../src/lib/feishu', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/feishu')>()
  return { ...actual, sendWebhookText: vi.fn(async () => ({ ok: true, status: 200, body: '' })) }
})

function makeDeps(webhookUrl: string, webhookSecret = '') {
  return {
    driver: {
      async execOp() {
        return { ok: true }
      },
    } as unknown as RunDriver,
    config: {
      dataDir: join(tmpdir(), 'bc-feishu-test'),
      browser: { mode: 'local', headless: true, maxConcurrent: 1, cdpEndpoint: '' },
      feishu: { webhookUrl, webhookSecret, appId: '', appSecret: '', botEnabled: false },
    } as unknown as RunnerConfig,
    artifactsDir: join(tmpdir(), 'bc-feishu-artifacts'),
    signal: new AbortController().signal,
    provider: null,
  }
}

function makeCtx(variables: Record<string, unknown> = {}) {
  const events: { kind: string; text: string }[] = []
  const ctx: WorkflowExecCtx = {
    variables,
    refData: null,
    signal: new AbortController().signal,
    emit: (kind, text) => void events.push({ kind, text }),
  }
  return { ctx, events }
}

describe('runner notification: Feishu channel', () => {
  afterEach(() => vi.clearAllMocks())

  it('sends the interpolated title and body', async () => {
    const { ctx, events } = makeCtx({ n: 7 })
    const registry = createExecutors(
      makeDeps('https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'shh'),
    )

    await registry['notification']!(
      { title: '完成', message: '共 {{n}} 条', notifyFeishu: true },
      ctx,
    )

    expect(sendWebhookText).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
      '完成\n共 7 条',
      'shh',
    )
    expect(events.some((e) => e.kind === 'info' && e.text.includes('已发送飞书通知'))).toBe(true)
    expect(events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('logs an unconfigured webhook without failing the step', async () => {
    const { ctx, events } = makeCtx()
    const registry = createExecutors(makeDeps(''))

    await expect(
      registry['notification']!({ title: '完成', message: '正文', notifyFeishu: true }, ctx),
    ).resolves.toBeNull()

    expect(sendWebhookText).not.toHaveBeenCalled()
    expect(events.some((e) => e.kind === 'error' && e.text.includes('未设置'))).toBe(true)
  })

  it('logs a rejected webhook without failing the step', async () => {
    vi.mocked(sendWebhookText).mockRejectedValueOnce(new Error('boom'))
    const { ctx, events } = makeCtx()
    const registry = createExecutors(makeDeps('https://open.feishu.cn/open-apis/bot/v2/hook/abc'))

    await expect(
      registry['notification']!({ title: '完成', message: '正文', notifyFeishu: true }, ctx),
    ).resolves.toBeNull()

    expect(events.some((e) => e.kind === 'error' && e.text.includes('飞书通知发送失败'))).toBe(true)
  })

  it('does not reach for the webhook when the box is unchecked', async () => {
    const { ctx } = makeCtx()
    const registry = createExecutors(makeDeps('https://open.feishu.cn/open-apis/bot/v2/hook/abc'))

    await registry['notification']!({ title: '完成', message: '正文' }, ctx)

    expect(sendWebhookText).not.toHaveBeenCalled()
  })
})

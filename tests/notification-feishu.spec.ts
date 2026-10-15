/**
 * The Feishu leg of the `notification` operator (spec
 * `specs/2026-10-15-notification-feishu-and-goal-free-design.md` §3.2).
 *
 * Ruling: a Feishu delivery problem is logged, never thrown — the desktop
 * notification already happened, and a webhook outage must not turn a finished
 * run into a failed one. The desktop failure rule is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import { sendWebhookText } from '../src/lib/feishu'
import { getFeishuConfig } from '../src/lib/task-store'

vi.mock('../src/lib/feishu', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/feishu')>()
  return { ...actual, sendWebhookText: vi.fn(async () => ({ ok: true, status: 200, body: '' })) }
})

vi.mock('../src/lib/task-store', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/task-store')>()
  return { ...actual, getFeishuConfig: vi.fn(async () => ({ webhookUrl: '', webhookSecret: '' })) }
})

const notification = EXECUTORS['notification']!

function makeCtx(): { ctx: WorkflowExecCtx; emit: ReturnType<typeof vi.fn> } {
  const lines: Array<[string, string]> = []
  const emit = vi.fn((kind: 'status' | 'result' | 'error' | 'info', text: string) => {
    lines.push([kind, text])
  })
  const ctx: WorkflowExecCtx = {
    variables: { n: 3 },
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

/** The desktop-notification API the executor probes for. */
function stubDesktop(create: (options: unknown) => Promise<boolean>) {
  vi.stubGlobal('chrome', { notifications: { create } })
}

const configured = {
  webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
  webhookSecret: 's3cret',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('notification operator: Feishu channel', () => {
  it('stays out of the webhook when the box is not checked', async () => {
    stubDesktop(async () => true)
    const { ctx } = makeCtx()

    await expect(notification({ title: '完成', message: '共 {{n}} 条' }, ctx)).resolves.toBeNull()

    expect(sendWebhookText).not.toHaveBeenCalled()
    expect(getFeishuConfig).not.toHaveBeenCalled()
  })

  it('sends the interpolated title and body through the configured webhook', async () => {
    stubDesktop(async () => true)
    vi.mocked(getFeishuConfig).mockResolvedValueOnce(configured as never)
    const { ctx } = makeCtx()

    await notification({ title: '完成', message: '共 {{n}} 条', notifyFeishu: true }, ctx)

    expect(sendWebhookText).toHaveBeenCalledWith(
      configured.webhookUrl,
      '完成\n共 3 条',
      configured.webhookSecret,
    )
    expect(ctx.emit).toHaveBeenCalledWith('info', '已发送飞书通知')
    expect(ctx.emit).toHaveBeenCalledWith('result', '已通知')
  })

  it('warns instead of failing when no webhook is configured', async () => {
    stubDesktop(async () => true)
    const { ctx } = makeCtx()

    await expect(
      notification({ title: '完成', message: '正文', notifyFeishu: true }, ctx),
    ).resolves.toBeNull()

    expect(sendWebhookText).not.toHaveBeenCalled()
    expect(ctx.emit).toHaveBeenCalledWith('error', expect.stringContaining('未配置'))
    expect(ctx.emit).toHaveBeenCalledWith('result', '已通知')
  })

  it('warns instead of failing when the webhook rejects', async () => {
    stubDesktop(async () => true)
    vi.mocked(getFeishuConfig).mockResolvedValueOnce(configured as never)
    vi.mocked(sendWebhookText).mockRejectedValueOnce(new Error('rate limited'))
    const { ctx } = makeCtx()

    await expect(
      notification({ title: '完成', message: '正文', notifyFeishu: true }, ctx),
    ).resolves.toBeNull()

    expect(ctx.emit).toHaveBeenCalledWith('error', expect.stringContaining('飞书通知发送失败'))
    expect(ctx.emit).toHaveBeenCalledWith('result', '已通知')
  })

  it('still fails the step when the desktop notification cannot be shown', async () => {
    // The Feishu rule must not leak into the desktop path: an un-shown desktop
    // notification is a failed step (see the no-catch comment in the executor).
    stubDesktop(async () => {
      throw new Error('permissions')
    })
    const { ctx } = makeCtx()

    await expect(
      notification({ title: '完成', message: '正文', notifyFeishu: true }, ctx),
    ).rejects.toThrow()

    expect(sendWebhookText).not.toHaveBeenCalled()
  })

  it('degrades to the logged notice with no desktop API at all, Feishu included', async () => {
    const { ctx } = makeCtx()
    vi.mocked(getFeishuConfig).mockResolvedValueOnce(configured as never)

    await notification({ title: '完成', message: '正文', notifyFeishu: true }, ctx)

    expect(ctx.emit).toHaveBeenCalledWith('info', '通知不可用')
    expect(sendWebhookText).toHaveBeenCalledOnce()
  })
})

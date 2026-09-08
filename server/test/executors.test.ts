import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RunDriver } from '../src/driver'
import type { RunnerConfig } from '../src/config'
import { createExecutors } from '../src/executors'
import type { WorkflowExecCtx } from '../../src/background/workflow-engine/executors'
import type { OpResult } from '../../src/lib/ops'

const OP_BASE = { found: false, frameUrl: '', isTopFrame: true }

/** A driver stub that ACTUALLY evaluates the JS the executors send to pages. */
function makeDriverStub(): RunDriver {
  const driver = {
    async execJs(code: string, args: Record<string, unknown> = {}): Promise<OpResult> {
      try {
        const keys = Object.keys(args)
        // eslint-disable-next-line no-new-func
        const fn = new Function(...keys, `"use strict";\n${code}`)
        return { ...OP_BASE, ok: true, data: fn(...keys.map((k) => args[k])) }
      } catch (error) {
        return { ...OP_BASE, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async execWorkflowJs(): Promise<never> {
      // Force the local-fallback path for javascript-code blocks.
      throw new Error('no page in unit test')
    },
    async execOp(): Promise<OpResult> {
      return { ...OP_BASE, ok: true, note: 'stub' }
    },
    async countElements(): Promise<number> {
      return 0
    },
  }
  return driver as unknown as RunDriver
}

function makeCtx(variables: Record<string, unknown> = {}): WorkflowExecCtx & {
  outputs: Record<string, string>
  events: { kind: string; text: string }[]
} {
  const outputs: Record<string, string> = {}
  const events: { kind: string; text: string }[] = []
  return {
    variables,
    refData: null,
    signal: new AbortController().signal,
    outputs,
    events,
    emit(kind, text) {
      events.push({ kind, text })
    },
  }
}

function makeDeps(driver: RunDriver) {
  return {
    driver,
    config: {
      dataDir: join(tmpdir(), 'bc-exec-test'),
      browser: { mode: 'local', headless: true, maxConcurrent: 1, cdpEndpoint: '' },
    } as unknown as RunnerConfig,
    artifactsDir: join(tmpdir(), 'bc-exec-artifacts'),
    signal: new AbortController().signal,
    provider: null,
  }
}

describe('server executors', () => {
  it('covers the extension registry keys', () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    for (const key of [
      'trigger',
      'click',
      'fill',
      'set-variable',
      'increase-variable',
      'slice-variable',
      'regex-variable',
      'conditions',
      'javascript-code',
      'webhook',
      'forms',
      'execute-workflow',
      'loop-breakpoint',
      'ai-agent',
    ]) {
      expect(registry[key], `missing executor: ${key}`).toBeTypeOf('function')
    }
  })

  it('set-variable interpolates into the variable store', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ name: '世界' })
    await registry['set-variable']!({ variableName: 'greeting', value: '你好 {{name}}' }, ctx)
    expect(ctx.variables['greeting']).toBe('你好 世界')
  })

  it('javascript-code falls back to local evaluation with Automa helpers', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ seed: 2 })
    await registry['javascript-code']!(
      { code: "automaSetVariable('doubled', variables.seed * 2); automaNextBlock({ ok: true })" },
      ctx,
    )
    expect(ctx.variables['doubled']).toBe(4)
    expect(ctx.variables['lastResult']).toEqual({ ok: true })
  })

  it('conditions route through outputs handles (row semantics)', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ a: 'yes' })
    ctx.outputs['true'] = 'node-yes'
    ctx.outputs['false'] = 'node-no'
    const next = await registry['conditions']!(
      { conditions: [{ conditions: [{ name: 'a', compare: 'eql', value: 'yes' }] }] },
      ctx,
    )
    expect(next).toBe('node-yes')

    const ctx2 = makeCtx({ a: 'no' })
    ctx2.outputs['true'] = 'node-yes'
    ctx2.outputs['false'] = 'node-no'
    const next2 = await registry['conditions']!(
      { conditions: [{ conditions: [{ name: 'a', compare: 'eql', value: 'yes' }] }] },
      ctx2,
    )
    expect(next2).toBe('node-no')
  })

  it('javascript-code expression conditions evaluate via driver JS', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ count: 5 })
    ctx.outputs['true'] = 'big'
    const next = await registry['conditions']!({ code: 'vars.count > 3' }, ctx)
    expect(next).toBe('big')
  })

  it('increase-variable mutates the stored number', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ n: 1 })
    await registry['increase-variable']!({ variableName: 'n', value: '4' }, ctx)
    expect(ctx.variables['n']).toBe(5)
    // The multiply mode starts from 1 when the variable is absent.
    const ctx2 = makeCtx({})
    await registry['increase-variable']!({ variableName: 'm', value: '3', incType: 'multiply' }, ctx2)
    expect(ctx2.variables['m']).toBe(3)
  })

  it('regex-variable extracts a match', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ text: 'order-42-shipped' })
    await registry['regex-variable']!(
      { variableName: 'text', pattern: 'order-(\\d+)', output: 'out' },
      ctx,
    )
    expect(String(ctx.variables['out'])).toContain('42')
  })

  it('loop-breakpoint throws the LoopBreakpointError the engine catches', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    await expect(
      registry['loop-breakpoint']!({ loopId: 'l1' }, makeCtx()),
    ).rejects.toMatchObject({ name: 'LoopBreakpointError' })
  })
})

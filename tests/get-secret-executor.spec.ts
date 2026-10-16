import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import type { PasswordEntry } from '../src/lib/types'

// The block resolves rows against the user's stored credentials; the store is
// the only host surface this executor touches.
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, listPasswords: vi.fn() }
})

import { listPasswords } from '../src/lib/storage'

const listPasswordsMock = vi.mocked(listPasswords)

function entry(id: string, label: string, fields: [string, string][]): PasswordEntry {
  return {
    id,
    label,
    fields: fields.map(([key, value]) => ({ key, value, secret: true })),
    createdAt: 0,
    updatedAt: 0,
    useCount: 0,
  }
}

function makeCtx(): { ctx: WorkflowExecCtx; texts: string[] } {
  const texts: string[] = []
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: ((_kind: 'status' | 'result' | 'error' | 'info', text: string) => {
      texts.push(text)
    }) as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, texts }
}

const getSecret = EXECUTORS['get-secret']!

beforeEach(() => {
  listPasswordsMock.mockReset()
  listPasswordsMock.mockResolvedValue([
    entry('gh', 'GitHub PAT', [
      ['token', 'ghp-SECRET'],
      ['user', 'dcc'],
    ]),
    entry('mail', 'Mail', [['password', 'mail-SECRET']]),
  ])
})

describe('get-secret executor — one node, one row per credential', () => {
  it('writes every row of a multi-credential node', async () => {
    const { ctx, texts } = makeCtx()
    await getSecret!(
      {
        credential: 'gh::token',
        variableName: 'githubToken',
        credentials: [
          { credential: 'gh::token', variableName: 'githubToken' },
          { credential: 'mail::password', variableName: 'mailPassword' },
        ],
      },
      ctx,
    )
    expect(ctx.variables).toEqual({ githubToken: 'ghp-SECRET', mailPassword: 'mail-SECRET' })
    // One store read for the whole node, not one per row.
    expect(listPasswordsMock).toHaveBeenCalledTimes(1)
    // The log names the rows, never their values.
    expect(texts.join('\n')).toContain('mailPassword')
    expect(texts.join('\n')).not.toContain('SECRET')
  })

  it('still reads the flat pair a one-row node stores', async () => {
    const { ctx } = makeCtx()
    await getSecret!({ credential: 'gh::user', variableName: 'githubUser' }, ctx)
    expect(ctx.variables).toEqual({ githubUser: 'dcc' })
  })

  it('falls back to the password field for a credential-id-only reference', async () => {
    const { ctx } = makeCtx()
    await getSecret!({ credential: 'mail', variableName: 'pw' }, ctx)
    expect(ctx.variables).toEqual({ pw: 'mail-SECRET' })
  })

  /**
   * Each failure below is a step that must NOT report success: writing `''` let
   * a downstream `{{secret}}` fill a form with a blank value and still pass.
   */
  it('refuses a row with no output name, before opening the store', async () => {
    await expect(
      getSecret!(
        {
          credential: 'gh::token',
          variableName: 'githubToken',
          credentials: [
            { credential: 'gh::token', variableName: 'githubToken' },
            { credential: 'mail::password', variableName: '' },
          ],
        },
        makeCtx().ctx,
      ),
    ).rejects.toThrow('未指定输出变量名')
    expect(listPasswordsMock).not.toHaveBeenCalled()
  })

  it('refuses a node with no credential at all', async () => {
    await expect(getSecret!({}, makeCtx().ctx)).rejects.toThrow('未指定凭证')
    expect(listPasswordsMock).not.toHaveBeenCalled()
  })

  it('refuses a credential id the store does not have', async () => {
    await expect(
      getSecret!({ credential: 'nope::token', variableName: 'x' }, makeCtx().ctx),
    ).rejects.toThrow('nope')
  })
})

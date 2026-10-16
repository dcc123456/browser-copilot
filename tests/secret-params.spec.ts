/**
 * Unit tests for the `get-secret` credential data model.
 *
 * Multi-credential fetching rests on one contract: every reader goes through
 * {@link secretRequestsOf} and every writer through {@link secretRowsPatch}.
 * These pin the three stored shapes down, the row-1 mirror that keeps the older
 * consumers honest, and the env-var name the headless Runner reads.
 */
import { describe, expect, it } from 'vitest'
import {
  credentialRefOf,
  parseCredentialRef,
  secretEnvNameOf,
  secretRequestsOf,
  secretRowsOf,
  secretRowsPatch,
  secretVariableNameOf,
  secretVariableNamesOf,
  type SecretRow,
} from '../src/lib/workflow/secret-params'

describe('secretRequestsOf — whichever shape is stored', () => {
  it('reads the flat pair', () => {
    expect(secretRequestsOf({ credential: 'gh::token', variableName: 'githubToken' })).toEqual([
      { credentialId: 'gh', fieldKey: 'token', variableName: 'githubToken' },
    ])
  })

  it('prefers the credentials list once it has rows', () => {
    const data = {
      credential: 'gh::token',
      variableName: 'githubToken',
      credentials: [
        { credential: 'gh::token', variableName: 'githubToken' },
        { credential: 'mail::password', variableName: 'mailPassword' },
      ],
    }
    expect(secretRequestsOf(data).map((r) => r.variableName)).toEqual([
      'githubToken',
      'mailPassword',
    ])
  })

  it('falls back to the pre-dropdown secretId / fieldName pair', () => {
    expect(
      secretRequestsOf({ secretId: 'gh', fieldName: 'token', variableName: 'legacy' }),
    ).toEqual([{ credentialId: 'gh', fieldKey: 'token', variableName: 'legacy' }])
  })

  it('keeps a row with a credential but no name — the run must fail loudly', () => {
    expect(secretRequestsOf({ credential: 'gh::token' })).toEqual([
      { credentialId: 'gh', fieldKey: 'token', variableName: '' },
    ])
  })

  it('drops an empty form row instead of fetching a guess', () => {
    expect(secretRequestsOf({ credential: '', variableName: 'x' })).toEqual([])
  })

  it('reads a credential-id-only reference as an empty field', () => {
    expect(secretRequestsOf({ credential: 'gh', variableName: 'x' })).toEqual([
      { credentialId: 'gh', fieldKey: '', variableName: 'x' },
    ])
  })

  it('has nothing for a node that names no credential', () => {
    expect(secretRequestsOf({})).toEqual([])
    expect(secretRequestsOf(undefined)).toEqual([])
  })
})

describe('secretRowsOf / secretRowsPatch — one reader, one writer', () => {
  const rows: SecretRow[] = [
    { credential: 'gh::token', variableName: 'githubToken' },
    { credential: 'mail::password', variableName: 'mailPassword' },
  ]

  it('round-trips several rows through the row-1 mirror', () => {
    expect(secretRowsOf(secretRowsPatch(rows))).toEqual(rows)
  })

  it('writes a single row as the flat pair, with no list', () => {
    const patch = secretRowsPatch([{ credential: 'gh::token', variableName: 'token' }])
    expect(patch['credential']).toBe('gh::token')
    expect(patch['variableName']).toBe('token')
    expect(patch['credentials']).toBeUndefined()
  })

  it('clears the legacy params on every write', () => {
    const legacy = secretRowsOf({ secretId: 'gh', fieldName: 'token', variableName: 'x' })
    const patch = secretRowsPatch(legacy)
    expect(patch['credential']).toBe('gh::token')
    expect(patch['secretId']).toBeUndefined()
    expect(patch['fieldName']).toBeUndefined()
    // App.tsx merges the patch over the old data, so the cleared keys have to be
    // present as `undefined` — that is what removes them from the node.
    expect(Object.keys(patch)).toContain('secretId')
  })

  it('normalises a bare-id reference into a form row that reads back the same', () => {
    const normalized = secretRowsOf({ credential: 'gh', variableName: 'x' })
    expect(normalized).toEqual([{ credential: 'gh::', variableName: 'x' }])
    expect(secretRequestsOf(secretRowsPatch(normalized))).toEqual([
      { credentialId: 'gh', fieldKey: '', variableName: 'x' },
    ])
  })
})

describe('secretVariableNamesOf — what a node publishes', () => {
  it('lists every row name and skips the unnamed ones', () => {
    expect(
      secretVariableNamesOf({
        credentials: [
          { credential: 'gh::token', variableName: 'githubToken' },
          { credential: 'mail::password', variableName: '' },
        ],
      }),
    ).toEqual(['githubToken'])
  })
})

describe('the credential reference itself', () => {
  it('round-trips through credentialRefOf', () => {
    expect(credentialRefOf({ credentialId: 'gh', fieldKey: 'token' })).toBe('gh::token')
    expect(parseCredentialRef('gh::token')).toEqual({ credentialId: 'gh', fieldKey: 'token' })
  })

  it('rejects a reference missing either half', () => {
    expect(parseCredentialRef('gh::')).toBeNull()
    expect(parseCredentialRef('::token')).toBeNull()
    expect(parseCredentialRef('gh')).toBeNull()
    expect(parseCredentialRef(undefined)).toBeNull()
  })

  it('mints a collision-safe default name', () => {
    expect(secretVariableNameOf({ credentialId: 'gh', fieldKey: 'token' })).toBe('secret_gh_token')
  })
})

describe('secretEnvNameOf — the headless host’s naming', () => {
  it('uppercases and underscores both segments', () => {
    expect(secretEnvNameOf({ credentialId: 'github', fieldKey: 'token' })).toBe(
      'BC_SECRET_GITHUB_TOKEN',
    )
    expect(secretEnvNameOf({ credentialId: 'prod db', fieldKey: 'api.key' })).toBe(
      'BC_SECRET_PROD_DB_API_KEY',
    )
  })

  it('omits the field segment for an id-only reference', () => {
    expect(secretEnvNameOf({ credentialId: 'mail', fieldKey: '' })).toBe('BC_SECRET_MAIL')
  })
})

import { describe, expect, it } from 'vitest'
import { PUBLIC_REPO, parseRepoFullName, repoFullName } from '../src/lib/marketplace/repo'

describe('repo descriptor', () => {
  it('names the public marketplace', () => {
    expect(repoFullName(PUBLIC_REPO)).toBe('dcc123456/BC-workflow')
    expect(PUBLIC_REPO.isPrivate).toBe(false)
  })

  it('parses owner/repo as typed into settings', () => {
    expect(parseRepoFullName(' acme/team-workflows ')).toEqual({
      owner: 'acme',
      repo: 'team-workflows',
    })
    expect(parseRepoFullName('https://github.com/acme/team-workflows.git')).toEqual({
      owner: 'acme',
      repo: 'team-workflows',
    })
    expect(parseRepoFullName('acme/team.workflows_v2')).toEqual({
      owner: 'acme',
      repo: 'team.workflows_v2',
    })
  })

  it('rejects anything that is not exactly owner/repo', () => {
    expect(parseRepoFullName('')).toBeNull()
    expect(parseRepoFullName('acme')).toBeNull()
    expect(parseRepoFullName('acme/team/extra')).toBeNull()
    expect(parseRepoFullName('acme/..')).toBeNull()
    expect(parseRepoFullName('-acme/team')).toBeNull()
    expect(parseRepoFullName('acme/ team')).toBeNull()
  })
})

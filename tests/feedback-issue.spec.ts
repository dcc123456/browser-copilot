import { afterEach, describe, expect, it, vi } from 'vitest'
import { messagesFor } from '../src/lib/i18n'
import { collectFeedbackDiagnostics } from '../src/lib/feedback/diagnostics'
import {
  buildFeedbackIssue,
  feedbackIssueTitle,
  FEEDBACK_ISSUE_REPO,
  FEEDBACK_TITLE_MAX_CHARS,
  type FeedbackDiagnostics,
} from '../src/lib/feedback/issue'

const DIAGNOSTICS: FeedbackDiagnostics = {
  version: '0.6.16',
  build: 'abc123',
  userAgent: 'Chrome/130',
  locale: 'en',
}

describe('feedback issue title', () => {
  it('uses the first non-empty line', () => {
    expect(feedbackIssueTitle('\n\nSettings crashes\n\nSteps: open', 'Feedback')).toBe(
      'Settings crashes',
    )
  })

  it('collapses whitespace inside the line', () => {
    expect(feedbackIssueTitle('Settings   crashes\thard', 'Feedback')).toBe('Settings crashes hard')
  })

  it('falls back when the report is blank', () => {
    expect(feedbackIssueTitle('  \n\t\n', 'Feedback')).toBe('Feedback')
  })

  it('truncates a long line by code point', () => {
    const title = feedbackIssueTitle('😀'.repeat(150), 'Feedback')
    expect([...title]).toHaveLength(FEEDBACK_TITLE_MAX_CHARS)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('buildFeedbackIssue', () => {
  it('appends the diagnostics block', () => {
    const issue = buildFeedbackIssue(messagesFor('en'), {
      text: '  Dark mode breaks settings\n\nSteps\n',
      diagnostics: DIAGNOSTICS,
    })

    expect(issue.title).toBe('Dark mode breaks settings')
    expect(issue.body).toContain('Dark mode breaks settings\n\nSteps')
    expect(issue.body).toContain('**Diagnostics**')
    expect(issue.body).toContain('- Extension version: 0.6.16')
    expect(issue.body).toContain('- Build: abc123')
    expect(issue.body).toContain('- Browser: Chrome/130')
    expect(issue.body).toContain('- UI language: en')
  })

  it('uses the Chinese template on the Chinese panel', () => {
    const issue = buildFeedbackIssue(messagesFor('zh-CN'), {
      text: '设置页崩溃',
      diagnostics: { ...DIAGNOSTICS, locale: 'zh-CN' },
    })

    expect(issue.title).toBe('设置页崩溃')
    expect(issue.body).toContain('**诊断信息**')
    expect(issue.body).toContain('- 扩展版本：0.6.16')
    expect(issue.body).toContain('- 界面语言：zh-CN')
  })

  it('sends only the report when diagnostics are off', () => {
    const issue = buildFeedbackIssue(messagesFor('en'), {
      text: '  Just the text  ',
      diagnostics: null,
    })

    expect(issue).toEqual({ title: 'Just the text', body: 'Just the text' })
  })
})

describe('feedback target', () => {
  it('points at the project repository', () => {
    expect(FEEDBACK_ISSUE_REPO).toEqual({ owner: 'dcc123456', repo: 'browser-copilot' })
  })
})

describe('collectFeedbackDiagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads version, build, user agent and locale', () => {
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.6.16' }) } })
    vi.stubGlobal('navigator', { userAgent: 'TestAgent/1.0' })

    expect(collectFeedbackDiagnostics('zh-CN')).toEqual({
      version: '0.6.16',
      build: __BUILD_STAMP__,
      userAgent: 'TestAgent/1.0',
      locale: 'zh-CN',
    })
  })
})

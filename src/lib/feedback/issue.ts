/**
 * Turns a written report into the title and body of a GitHub issue.
 *
 * Free of `chrome` and the DOM so the same rules run in the node tests and in
 * the Runner's type program; the host collects diagnostics and passes them in.
 *
 * @module lib/feedback/issue
 */

import type { Messages } from '../i18n'
import { UPDATE_REPO_NAME, UPDATE_REPO_OWNER } from '../update/types'

/** The repository the updater already reads releases from — one literal, no drift. */
export const FEEDBACK_ISSUE_REPO = { owner: UPDATE_REPO_OWNER, repo: UPDATE_REPO_NAME } as const

/** Long enough for a full report with a log excerpt; GitHub's own cap is 65 536. */
export const FEEDBACK_MAX_CHARS = 4000
/** Keeps a derived title readable in the issue list; GitHub allows 256. */
export const FEEDBACK_TITLE_MAX_CHARS = 100

export interface FeedbackDiagnostics {
  version: string
  build: string
  userAgent: string
  /** Panel UI language at submit time, e.g. `zh-CN`. */
  locale: string
}

export interface FeedbackIssue {
  title: string
  body: string
}

/** First non-empty line with internal whitespace collapsed; empty when none. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate)
  return line ? line.replace(/\s+/g, ' ') : ''
}

/** Slices by code point so truncation cannot split a surrogate pair. */
export function feedbackIssueTitle(text: string, fallbackTitle: string): string {
  const line = firstLine(text)
  if (!line) return fallbackTitle
  const points = [...line]
  if (points.length <= FEEDBACK_TITLE_MAX_CHARS) return line
  return `${points.slice(0, FEEDBACK_TITLE_MAX_CHARS - 1).join('').trimEnd()}…`
}

export function buildFeedbackIssue(
  t: Messages,
  input: { text: string; diagnostics: FeedbackDiagnostics | null },
): FeedbackIssue {
  const text = input.text.trim()
  const title = feedbackIssueTitle(text, t.feedbackIssueFallbackTitle)
  const body = input.diagnostics
    ? t.feedbackIssueBody({
        text,
        version: input.diagnostics.version,
        build: input.diagnostics.build,
        userAgent: input.diagnostics.userAgent,
        locale: input.diagnostics.locale,
      })
    : text
  return { title, body }
}
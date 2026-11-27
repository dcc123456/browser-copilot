/**
 * Localized updater failures and the technical detail line.
 *
 * Backup/write failures are the ones where the browser's own error name is the
 * only actionable clue (the 0.6.22 OCR update left a 0-byte backup with a bare
 * "could not back up" toast); the detail must survive to the dialog, while a
 * code with a complete localized explanation must not repeat itself.
 */
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../src/lib/i18n'
import { describeApplyError, describeApplyErrorDetail } from '../src/sidepanel/update/error-text'
import { UpdateApplyError } from '../src/lib/update/types'

const en = messagesFor('en')
const zh = messagesFor('zh-CN')

describe('updater error text', () => {
  it('localizes an I/O failure and keeps the browser detail', () => {
    const detail =
      'Could not back up "tesseract/chi_sim.traineddata.gz": NotAllowedError: the file was not written'
    const error = new UpdateApplyError('backup-failed', detail)

    expect(describeApplyError(en, error)).toBe(en.updateErrorBackup)
    expect(describeApplyError(zh, error)).toBe(zh.updateErrorBackup)
    expect(describeApplyErrorDetail(error)).toBe(detail)
    expect(en.updateErrorDetail({ detail })).toContain(detail)
    expect(zh.updateErrorDetail({ detail })).toContain(detail)
  })

  it('does not repeat a complete localized explanation as detail', () => {
    expect(
      describeApplyErrorDetail(new UpdateApplyError('archive-invalid', 'The ZIP archive is bad.')),
    ).toBeNull()
    expect(describeApplyErrorDetail(new Error('boom'))).toBeNull()
  })
})

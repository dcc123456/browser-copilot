/**
 * Element selector actions — React port of Automa's SharedElSelectorActions.
 *
 * The pick button injects the element picker into the user's active browser
 * tab and writes back the selector it reports; the verify button asks the same
 * picker how many elements the current selector matches. The round trip itself
 * lives in `./element-pick`, which the AI operator chat dock uses too.
 *
 * @module workflow-editor/blocks/shared/ElSelectorActions
 */

import { CheckCheck, Focus, LoaderCircle } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from '../../../ui/toast'
import { useEditorLocale } from '../../locale-context'
import {
  describePickFailure,
  requestElementPick,
  verifyElementSelector,
  type ElementPickFailure,
} from './element-pick'

export default function ElSelectorActions({
  selector,
  findBy = 'cssSelector',
  multiple = false,
  onSelector,
  onMessage,
}: {
  selector: string
  findBy?: 'cssSelector' | 'xpath'
  multiple?: boolean
  onSelector: (selector: string) => void
  /** Optional toast-style callback for verify results. */
  onMessage?: (text: string, kind: 'ok' | 'error') => void
}) {
  const [busy, setBusy] = useState<null | 'pick' | 'verify'>(null)
  const { bt, locale } = useEditorLocale()

  /** Escape is the user's own choice, so only a real failure has anything to say. */
  const reportFailure = useCallback(
    (result: { failure: ElementPickFailure; error?: string }) => {
      const problem = describePickFailure(result.failure, result.error)
      if (problem) toast(bt(problem), 'error')
    },
    [bt],
  )

  const start = useCallback(
    async (mode: 'select' | 'verify') => {
      setBusy(mode === 'select' ? 'pick' : 'verify')
      if (mode === 'select') {
        const result = await requestElementPick({ findBy, multiple, locale })
        setBusy(null)
        if (result.ok) onSelector(result.selector)
        else reportFailure(result)
        return
      }
      const result = await verifyElementSelector({ selector, findBy, locale })
      setBusy(null)
      if (result.ok) {
        if (result.count > 0) {
          onMessage?.(
            bt('Verified: {count} element(s) match').replace('{count}', String(result.count)),
            'ok',
          )
          return
        }
        onMessage?.(bt('Element not found'), 'error')
        toast(bt('Element not found'), 'error')
        return
      }
      reportFailure(result)
    },
    [findBy, multiple, selector, locale, onSelector, onMessage, bt, reportFailure],
  )

  return (
    <span className="wf-el-actions">
      <button
        type="button"
        className="wf-icon-btn"
        title={bt('Pick element on page')}
        disabled={busy !== null}
        onClick={() => void start('select')}
      >
        {busy === 'pick' ? <LoaderCircle size={14} className="wf-spin" /> : <Focus size={14} />}
      </button>
      <button
        type="button"
        className="wf-icon-btn"
        title={bt('Verify selector')}
        disabled={busy !== null || !selector}
        onClick={() => void start('verify')}
      >
        {busy === 'verify' ? (
          <LoaderCircle size={14} className="wf-spin" />
        ) : (
          <CheckCheck size={14} />
        )}
      </button>
    </span>
  )
}

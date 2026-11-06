/**
 * Page-level mount for the `parameter-prompt` dialog.
 *
 * Rendered through a portal to `document.body` so it works from any surface —
 * including a side-panel tab that stays mounted but is `display:none` while
 * another tab is active.
 *
 * @module ui/RunInputHost
 */

import { createPortal } from 'react-dom'
import RunInputDialog, { type RunInputDialogLabels } from './RunInputDialog'
import { useRunInputRequest } from './use-run-input-request'

export default function RunInputHost({
  labels,
}: {
  labels: RunInputDialogLabels
}): React.ReactElement {
  const { request, submit, cancel } = useRunInputRequest()
  if (!request) return <></>
  return createPortal(
    <RunInputDialog
      key={request.requestId}
      labels={labels}
      onCancel={cancel}
      onSubmit={submit}
      request={request}
    />,
    document.body,
  )
}

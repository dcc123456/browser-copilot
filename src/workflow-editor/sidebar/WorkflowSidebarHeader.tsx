/**
 * Workflow sidebar header — icon, name, rename dialog, copyable workflow id and
 * unsaved marker.
 *
 * Automa keeps the workflow identity at the top of the left panel, above the
 * block search; the top toolbar only carries view tabs and actions.
 *
 * @module workflow-editor/sidebar/WorkflowSidebarHeader
 */

import { Check, Copy, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copyText } from '../../lib/clipboard'
import { BlockIcon } from '../../lib/workflow/blocks/icons'
import { useEditorLocale } from '../locale-context'
import Modal from '../ui/Modal'

type CopyState = 'idle' | 'copied' | 'failed'

export default function WorkflowSidebarHeader({
  workflowId,
  workflowName,
  workflowIcon,
  dirty,
  onRename,
}: {
  /** Null until the editor finishes loading the workflow. */
  workflowId: string | null
  workflowName: string
  workflowIcon: string
  dirty: boolean
  onRename: (name: string) => void
}) {
  const { t } = useEditorLocale()
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState(workflowName)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const copyResetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyResetTimer.current), [])

  const confirmRename = (): void => {
    const next = nameDraft.trim()
    if (next && next !== workflowName) onRename(next)
    setRenameOpen(false)
  }

  const copyId = async (): Promise<void> => {
    if (!workflowId) return
    try {
      await copyText(workflowId)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopyState('idle'), 1600)
  }

  const copyLabel =
    copyState === 'copied'
      ? t('workflowIdCopied')
      : copyState === 'failed'
        ? t('workflowIdCopyFailed')
        : t('copyWorkflowId')

  return (
    <>
      <div className="flex flex-none items-center gap-2 px-3 pb-2 pt-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <BlockIcon icon={workflowIcon || 'lucide:Workflow'} size={16} />
        </span>
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-hover"
          title={t('renameWorkflow')}
          onClick={() => {
            setNameDraft(workflowName)
            setRenameOpen(true)
          }}
        >
          <span className="truncate text-sm font-semibold text-ink">
            {workflowName || t('untitled')}
          </span>
          <Pencil size={11} className="shrink-0 text-faint group-hover:text-muted" />
          {dirty && (
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              title={t('unsavedChanges')}
            />
          )}
        </button>
      </div>

      <div className="flex flex-none items-center gap-1.5 px-3 pb-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-faint">
          {t('workflowId')}
        </span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
          title={workflowId ?? ''}
        >
          {workflowId}
        </code>
        {copyState === 'failed' && (
          <span className="shrink-0 text-[10px] text-err">{t('workflowIdCopyFailed')}</span>
        )}
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-muted disabled:cursor-default disabled:opacity-40"
          title={copyLabel}
          aria-label={copyLabel}
          disabled={!workflowId}
          onClick={() => void copyId()}
        >
          {copyState === 'copied' ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
        </button>
      </div>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('renameWorkflow')}
        size="sm"
      >
        <input
          autoFocus
          aria-label={t('workflowName')}
          className="wf-rename-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') confirmRename()
          }}
        />
        <div className="wf-rename-actions">
          <button type="button" className="wf-tab" onClick={() => setRenameOpen(false)}>
            {t('cancel')}
          </button>
          <button type="button" className="wf-tab wf-tab-active" onClick={confirmRename}>
            {t('save')}
          </button>
        </div>
      </Modal>
    </>
  )
}

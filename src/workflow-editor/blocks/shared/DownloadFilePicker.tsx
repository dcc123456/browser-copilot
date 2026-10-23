/**
 * DownloadFilePicker — choose a concrete file inside the authorised download
 * folders for the `file-path` source of `upload-file` / `parse-excel`.
 *
 * The value is a path relative to the download root (`reports/2026-10/sales.xlsx`),
 * never a host absolute path. A typed value may reference a workflow variable
 * (`{{folder}}/sales.xlsx`): the executor interpolates it before reading, so the
 * field offers the variable menu through its `{}` button rather than the usual
 * `/` trigger, which is a path separator here. Browsing is lazy: the folders are
 * only scanned when the list is opened, and the list is recursive (files the
 * user keeps in subfolders are reachable) with the same entry limit the runtime
 * scan uses.
 *
 * @module workflow-editor/blocks/shared/DownloadFilePicker
 */

import { useState } from 'react'
import {
  listDownloadedFileCandidates,
  type DownloadedFileCandidate,
  type DownloadedFileScan,
} from '../../../lib/download-dir'
import { matchesAccept } from '../../../lib/workflow/latest-file'
import { useEditorLocale } from '../../locale-context'
import { TextInput } from './Field'

type ScanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; scan: DownloadedFileScan }
  | { status: 'error' }

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function sourceLabel(source: DownloadedFileCandidate['source']): string {
  return source === 'configured-download-dir' ? 'Configured downloads' : 'Internal downloads'
}

export default function DownloadFilePicker({
  value,
  onChange,
  accept = '',
}: {
  value: string
  onChange: (v: string) => void
  /** Optional accept list used only to narrow the list (the runtime check is the operator's). */
  accept?: string
}) {
  const { bt } = useEditorLocale()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ScanState>({ status: 'idle' })

  const load = async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      setState({ status: 'ready', scan: await listDownloadedFileCandidates({ recursive: true }) })
    } catch {
      setState({ status: 'error' })
    }
  }

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (state.status === 'idle' || state.status === 'error') void load()
  }

  const visible =
    state.status === 'ready'
      ? state.scan.candidates
          .filter((candidate) => matchesAccept(accept, candidate.name, candidate.mimeType))
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      : []

  return (
    <div
      className="wf-field"
      title={bt(
        'Pick a file inside the download folder; its path is stored relative to that folder',
      )}
    >
      <label>{bt('File path in the download folder')}</label>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <TextInput
            value={value}
            placeholder="reports/2026-10/sales.xlsx"
            onChange={onChange}
            noSlash
            variableMenu
          />
        </div>
        <button type="button" className="wf-btn-accent shrink-0" onClick={toggle}>
          {bt(open ? 'Close' : 'Browse downloads')}
        </button>
      </div>
      <p className="m-0 text-[11px] text-muted">
        {bt(
          'The path may contain a variable, e.g. {{folder}}/sales.xlsx. Files in subfolders are listed too.',
        )}
      </p>

      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{bt('Pick a downloaded file')}</span>
            <button type="button" className="wf-btn-accent" onClick={() => void load()}>
              {bt('Refresh')}
            </button>
          </div>

          {state.status === 'loading' && (
            <p className="text-xs text-muted">{bt('Loading files…')}</p>
          )}
          {state.status === 'error' && (
            <p className="text-xs text-err">{bt('Could not read the download folders.')}</p>
          )}
          {state.status === 'ready' && (
            <>
              {state.scan.candidates.length === 0 ? (
                <p className="text-xs text-muted">
                  {bt('No files in the download folders. Download one first or put a file there.')}
                </p>
              ) : visible.length === 0 ? (
                <p className="text-xs text-muted">{bt('No files match the accepted types.')}</p>
              ) : (
                <div className="flex max-h-56 flex-col overflow-y-auto">
                  {visible.map((candidate) => (
                    <button
                      key={`${candidate.source}:${candidate.relativePath}`}
                      type="button"
                      onClick={() => {
                        onChange(candidate.relativePath)
                        setOpen(false)
                      }}
                      className={`flex flex-col items-start gap-0.5 rounded px-2 py-1 text-left hover:bg-hover ${
                        candidate.relativePath === value ? 'bg-accent-soft' : ''
                      }`}
                    >
                      <span className="w-full break-all font-mono text-xs text-ink">
                        {candidate.relativePath}
                      </span>
                      <span className="text-[11px] text-muted">
                        {bt(sourceLabel(candidate.source))} · {formatSize(candidate.size)} ·{' '}
                        {new Date(candidate.lastModified).toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {state.scan.skipped.length > 0 && (
                <p className="text-xs text-warn">
                  {bt('Some folders could not be read (permission or access).')}
                </p>
              )}
              {state.scan.truncated === true && (
                <p className="text-xs text-warn">{bt('Showing only the first files found.')}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

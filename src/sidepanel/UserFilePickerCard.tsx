/**
 * UserFilePickerCard — answers the worker's `workflow:user-file-required`
 * requests in the side panel.
 *
 * A hidden `<input type=file>` is opened from the real click on "Choose
 * file" (native choosers may only be opened from a user gesture). Picked
 * files are read into `WorkflowFileArtifact[]` (bytes, not paths) and sent
 * back via `sendResponse`; cancelling reports `{ ok:false, canceled:true }`.
 *
 * Multiple concurrent requests each render their own card, keyed by
 * requestId. The component is mounted once at the App root.
 *
 * @module sidepanel/UserFilePickerCard
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  USER_FILE_PICKER_REQUEST,
  type UserFilePickerRequest,
} from '../lib/workflow/user-file-picker'
import { artifactFromFile } from '../lib/workflow/file-artifact'
import { useT } from './i18n'

interface PendingRequest {
  request: UserFilePickerRequest
  sendResponse: (response?: unknown) => void
}

/** One card for a single pending picker request. */
function PickerCard({
  request,
  sendResponse,
}: PendingRequest): ReactElement {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  // OS picker must open synchronously inside the click gesture.
  const openPicker = (): void => inputRef.current?.click()

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = event.target.files ? Array.from(event.target.files) : []
    if (picked.length === 0) {
      sendResponse({ ok: false, canceled: true })
      return
    }
    setBusy(true)
    try {
      const files = await Promise.all(picked.map(artifactFromFile))
      sendResponse({ ok: true, files })
    } catch (error) {
      sendResponse({
        ok: false,
        canceled: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-accent-border bg-accent-soft p-3">
      <p className="m-0 text-sm text-ink">{t.uploadFileWaiting}</p>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={request.accept || undefined}
        multiple={request.multiple}
        onChange={(e) => void handleChange(e)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={openPicker}
        className="mt-2 cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:cursor-default disabled:opacity-60"
      >
        {busy ? t.uploadFileReading : t.uploadFileChoose}
      </button>
    </div>
  )
}

/**
 * Listens for worker picker requests and renders a card per pending request.
 */
export default function UserFilePickerCardHost(): ReactElement {
  const [pending, setPending] = useState<PendingRequest[]>([])

  useEffect(() => {
    const handler = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | undefined => {
      const msg = message as { type?: string } | undefined
      if (msg?.type !== USER_FILE_PICKER_REQUEST) return undefined
      const request = message as UserFilePickerRequest
      setPending((prev) =>
        prev.some((p) => p.request.requestId === request.requestId)
          ? prev
          : [...prev, { request, sendResponse }],
      )
      // Keep the message channel open: the response is sent after the user
      // interacts with the card (possibly minutes later).
      return true
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  // A card removes itself once it has answered.
  const drop = (requestId: string): void =>
    setPending((prev) => prev.filter((p) => p.request.requestId !== requestId))

  if (pending.length === 0) return <></>

  return (
    <div className="pointer-events-auto fixed bottom-3 left-3 z-50 flex w-72 flex-col gap-2">
      {pending.map((item) => (
        <div key={item.request.requestId} className="relative">
          <PickerCardWrapper item={item} onAnswered={() => drop(item.request.requestId)} />
        </div>
      ))}
    </div>
  )
}

/** Wrapper that removes the card after its response callback fires. */
function PickerCardWrapper({
  item,
  onAnswered,
}: {
  item: PendingRequest
  onAnswered: () => void
}): ReactElement {
  const answeredRef = useRef(false)
  const sendResponse = (response?: unknown): void => {
    if (answeredRef.current) return
    answeredRef.current = true
    item.sendResponse(response)
    onAnswered()
  }
  return <PickerCard request={item.request} sendResponse={sendResponse} />
}

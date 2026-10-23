/**
 * Help chip for the javascript-code block: an Info icon plus the helper
 * signature, toggling an anchored bubble with "what it does" / "when to use
 * it" copy. The bubble is a disclosure, not a tooltip — it stays open while
 * the author reads it and closes on a second click or a click elsewhere.
 *
 * @module workflow-editor/ui/HelperTip
 */

import { Info } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useEditorLocale } from '../locale-context'

export default function HelperTip({
  signature,
  what,
  when,
}: {
  signature: string
  what: string
  when: string
}) {
  const { bt } = useEditorLocale()
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const bubbleId = useId()

  useEffect(() => {
    if (!isOpen) return
    // Capture phase: CodeMirror and the editor surfaces stop propagation on
    // pointerdown, so a bubble-phase listener would miss clicks inside them.
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [isOpen])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={isOpen ? bubbleId : undefined}
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-sunken px-2 py-1 font-mono text-[11.5px] leading-none text-ink transition-colors hover:bg-hover"
      >
        <Info size={12} className="shrink-0 text-accent" />
        <span>{signature}</span>
      </button>
      {isOpen && (
        <div
          id={bubbleId}
          role="dialog"
          aria-label={signature}
          className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-lg border border-border bg-panel p-3 text-left shadow-xl"
        >
          <p className="font-mono text-[11.5px] font-semibold text-ink">{signature}</p>
          <p className="mt-2 text-[10px] font-semibold tracking-wide text-muted uppercase">
            {bt('What it does')}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink">{bt(what)}</p>
          <p className="mt-2 text-[10px] font-semibold tracking-wide text-muted uppercase">
            {bt('When to use it')}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink">{bt(when)}</p>
        </div>
      )}
    </div>
  )
}

/**
 * SelectorField — the shared "element selector" control: the find-by dropdown
 * (or a static CSS label), the pick/verify element-picker actions, the
 * selector textarea/input, the verify-status line and the conversation-locator
 * hint. One implementation for every block form that edits an element selector
 * (previously re-assembled by hand in seven forms).
 *
 * Value-driven (`selector`/`onSelector` instead of `data`/`onChange`) so it
 * edits both top-level block data and nested records (e.g. the trigger's
 * observeElement). The capture path behind the picker is CSS-only, so forms
 * without a find-by dropdown omit `findBy`/`onFindBy` and get the static
 * "CSS Selector" label.
 *
 * @module workflow-editor/blocks/shared/SelectorField
 */

import { useState } from 'react'
import { useEditorLocale } from '../../locale-context'
import ElSelectorActions from './ElSelectorActions'
import { Field, Select, TextArea, TextInput } from './Field'
import { targetSummary } from './InteractionBase'

export interface SelectorFieldProps {
  selector: string
  onSelector: (selector: string) => void
  /** Provide BOTH findBy + onFindBy to render the CSS/XPath dropdown. */
  findBy?: string
  onFindBy?: (findBy: string) => void
  /** Single-line input instead of the auto-growing textarea. Default 'textarea'. */
  inputVariant?: 'textarea' | 'input'
  /** Field label wrapping the whole control (omit for the unlabeled layout). */
  label?: string
  /** Textarea/input placeholder; defaults follow findBy / the locator hint. */
  placeholder?: string
  /** Pass-through to the picker (multi-element pick mode). */
  multiple?: boolean
  /** Block data for the conversation-locator hint (targetSummary); omit for nested records. */
  data?: Record<string, unknown>
  /** Render the conversation-locator hint. Default true (when `data` is given). */
  showLocatorHint?: boolean
}

export default function SelectorField({
  selector,
  onSelector,
  findBy,
  onFindBy,
  inputVariant = 'textarea',
  label,
  placeholder,
  multiple = false,
  data,
  showLocatorHint = true,
}: SelectorFieldProps) {
  const { bt } = useEditorLocale()
  // Latest "verify selector" outcome, shown inline so the operator has feedback
  // even though ElSelectorActions has no toast host of its own in this popup.
  const [verifyStatus, setVerifyStatus] = useState<{ text: string; kind: 'ok' | 'error' } | null>(
    null,
  )
  const reportVerify = (text: string, kind: 'ok' | 'error'): void =>
    setVerifyStatus({ text, kind })
  // A generated node may carry the conversation's locator instead of a CSS
  // selector — show it read-only so the edit panel is not blank.
  const locatorHint = data && showLocatorHint && !selector ? targetSummary(data) : ''
  const effectivePlaceholder =
    placeholder ??
    (locatorHint
      ? 'Leave empty to use the conversation locator above; type a CSS selector to override'
      : findBy === 'xpath'
        ? '//div[@class="..."]'
        : '.css-selector')

  const control =
    inputVariant === 'input' ? (
      <TextInput value={selector} placeholder={effectivePlaceholder} onChange={onSelector} />
    ) : (
      <TextArea mono value={selector} placeholder={effectivePlaceholder} onChange={onSelector} />
    )

  // Unlabeled mode mirrors InteractionBase's original markup: the bare row,
  // then the control inside an unlabeled Field wrapper. Labeled mode wraps the
  // whole control (row + status + hint + input) in the labeled Field.
  const body = (
    <>
      {/* Automa: find-by select (flex-1) + pick/verify buttons on ONE row. */}
      <div className="wf-selector-row">
        {findBy !== undefined && onFindBy ? (
          <div className="wf-selector-findby">
            <Select
              value={findBy}
              onChange={onFindBy}
              options={[
                { value: 'cssSelector', label: 'CSS selector' },
                { value: 'xpath', label: 'XPath' },
              ]}
            />
          </div>
        ) : (
          <div className="wf-selector-findby">
            <span style={{ fontSize: 12, opacity: 0.75 }}>{bt('CSS Selector')}</span>
          </div>
        )}
        <ElSelectorActions
          selector={selector}
          findBy={findBy === 'xpath' ? 'xpath' : 'cssSelector'}
          multiple={multiple}
          onSelector={onSelector}
          onMessage={reportVerify}
        />
      </div>
      {verifyStatus && (
        <p className={`wf-form-note wf-verify-${verifyStatus.kind}`}>{verifyStatus.text}</p>
      )}
      {locatorHint && <p className="wf-form-note">{locatorHint}</p>}
      {label ? control : <Field>{control}</Field>}
    </>
  )

  return label ? <Field label={label}>{body}</Field> : body
}

/**
 * EditOcr — edit form for the local `ocr` block (Browser Copilot extension).
 *
 * Input — one of three sources: an img-typed variable holding an image data
 * URL / bare base64 payload / http(s) link, an img element selected on the
 * page (CSS selector with the shared pick-from-page + verify actions, like
 * the click blocks), or the previous page snapshot (the visible page the run
 * is driving). Output — the recognized string (type always string), stored
 * in the editable `variableName` variable (default `lastOcrText`).
 *
 * @module workflow-editor/blocks/batchB/EditOcr
 */

import { useState } from 'react'
import type { EditFormProps } from '../EditForms'
import ElSelectorActions from '../shared/ElSelectorActions'
import { bool, str, targetSummary } from '../shared/InteractionBase'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'

const SOURCES = [
  { value: 'variable', label: 'An image variable (img)' },
  { value: 'element', label: 'An img element on the page' },
  { value: 'page', label: 'The previous page snapshot' },
]

export default function EditOcr({ data, onChange }: EditFormProps) {
  const source = str(data, 'source') || 'page'
  const selector = str(data, 'selector')
  // A generated node may carry the conversation's locator instead of a CSS
  // selector — show it read-only so the edit panel is not blank.
  const locatorHint = selector ? '' : targetSummary(data)
  // Latest "verify selector" outcome, shown inline (ElSelectorActions has no
  // toast host of its own in this popup).
  const [verifyStatus, setVerifyStatus] = useState<{ text: string; kind: 'ok' | 'error' } | null>(
    null,
  )
  const reportVerify = (text: string, kind: 'ok' | 'error'): void =>
    setVerifyStatus({ text, kind })

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Input image">
        <Select value={source} onChange={(v) => onChange({ source: v })} options={SOURCES} />
      </Field>

      {source === 'variable' && (
        <Field label="Image variable (data URL / base64 / link)">
          <TextInput
            value={str(data, 'imageVariable')}
            placeholder="lastScreenshot"
            onChange={(v) => onChange({ imageVariable: v })}
          />
        </Field>
      )}

      {source === 'element' && (
        <>
          {/* Pick/verify actions on one row, like the interaction blocks. The
              capture path is CSS-only, so there is no find-by dropdown. */}
          <div className="wf-selector-row">
            <div className="wf-selector-findby">
              <span style={{ fontSize: 12, opacity: 0.75 }}>CSS Selector</span>
            </div>
            <ElSelectorActions
              selector={selector}
              findBy="cssSelector"
              onSelector={(sel) => onChange({ selector: sel })}
              onMessage={reportVerify}
            />
          </div>
          {verifyStatus && (
            <p className={`wf-form-note wf-verify-${verifyStatus.kind}`}>{verifyStatus.text}</p>
          )}
          {locatorHint && <p className="wf-form-note">{locatorHint}</p>}
          <Field label="CSS Selector">
            <TextArea
              mono
              value={selector}
              placeholder={
                locatorHint
                  ? 'Leave empty to use the conversation locator above; type a CSS selector to override'
                  : 'img.captcha'
              }
              onChange={(v) => onChange({ selector: v })}
            />
          </Field>
        </>
      )}

      <Field label="Language (empty = global setting)">
        <TextInput
          value={str(data, 'lang')}
          placeholder="eng / chi_sim+eng"
          onChange={(v) => onChange({ lang: v })}
        />
      </Field>

      <Checkbox
        checked={bool(data, 'preprocess')}
        onChange={(v) => onChange({ preprocess: v })}
        label="Enhance image before OCR (upscale + contrast)"
      />

      <Field label="Output variable (type: string)">
        <TextInput
          value={str(data, 'variableName')}
          placeholder="lastOcrText"
          onChange={(v) => onChange({ variableName: v })}
        />
      </Field>
    </div>
  )
}

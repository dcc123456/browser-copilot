/**
 * EditOcr — edit form for the local `ocr` block (Browser Copilot extension).
 *
 * Input — one of three sources: an img-typed variable holding an image data
 * URL / bare base64 payload / http(s) link, an element on the page (img /
 * canvas / a text-less container — shared pick-from-page + verify actions,
 * like the click blocks), or the previous page snapshot (the visible page the
 * run is driving). Output — the recognized string (type always string), stored
 * in the editable `variableName` variable (default `lastOcrText`).
 *
 * @module workflow-editor/blocks/batchB/EditOcr
 */

import type { EditFormProps } from '../EditForms'
import { bool, str } from '../shared/InteractionBase'
import SelectorField from '../shared/SelectorField'
import { Checkbox, Field, Select, TextArea, TextInput } from '../shared/Field'

const SOURCES = [
  { value: 'variable', label: 'An image variable (img)' },
  { value: 'element', label: 'An element on the page (img / canvas)' },
  { value: 'page', label: 'The previous page snapshot' },
]

export default function EditOcr({ data, onChange }: EditFormProps) {
  const source = str(data, 'source') || 'page'
  const selector = str(data, 'selector')

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
        // The capture path is CSS-only, so there is no find-by dropdown.
        <SelectorField
          data={data}
          selector={selector}
          onSelector={(sel) => onChange({ selector: sel })}
          placeholder="img.captcha"
        />
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

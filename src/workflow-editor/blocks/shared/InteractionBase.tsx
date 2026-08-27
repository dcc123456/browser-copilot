/**
 * InteractionBase — React port of Automa's EditInteractionBase.
 *
 * The shared skeleton for every element-interaction block (click, forms,
 * get-text, hover, ...): a description field, a find-by dropdown (CSS/XPath),
 * the selector textarea with pick/verify actions, and a "selector options"
 * fold-out (multiple, mark element, wait-for-selector + timeout). Block forms
 * render extra fields above/below via `children` and `header` slots.
 *
 * @module workflow-editor/blocks/shared/InteractionBase
 */

import type { ReactNode } from 'react'
import { Checkbox, Expand, Field, Select, TextArea, TextInput } from './Field'
import ElSelectorActions from './ElSelectorActions'
import type { Patch } from './Field'

export interface InteractionBaseProps {
  data: Record<string, unknown>
  onChange: Patch
  /** Extra fields rendered between description and the selector row. */
  header?: ReactNode
  /** Extra fields rendered after the selector options. */
  children?: ReactNode
  hideSelector?: boolean
  hideMultiple?: boolean
  hideMarkEl?: boolean
  hideDescription?: boolean
}

export function str(data: Record<string, unknown>, key: string): string {
  const v = data[key]
  return typeof v === 'string' ? v : ''
}
export function bool(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true
}
export function num(data: Record<string, unknown>, key: string, fallback = 0): number {
  const v = data[key]
  return typeof v === 'number' ? v : fallback
}

export default function InteractionBase({
  data,
  onChange,
  header,
  children,
  hideSelector,
  hideMultiple,
  hideMarkEl,
  hideDescription,
}: InteractionBaseProps) {
  const findBy = str(data, 'findBy') || 'cssSelector'
  const selector = str(data, 'selector')

  return (
    <div className="wf-form">
      {!hideDescription && (
        <Field label="Description">
          <TextArea
            value={str(data, 'description')}
            placeholder="Description (shown on the node)"
            onChange={(v) => onChange({ description: v })}
          />
        </Field>
      )}

      {header}

      {!hideSelector && (
        <>
          <Field label="Find element by">
            <div className="wf-selector-row">
              <div className="wf-selector-findby">
                <Select
                  value={findBy}
                  onChange={(v) => onChange({ findBy: v })}
                  options={[
                    { value: 'cssSelector', label: 'CSS selector' },
                    { value: 'xpath', label: 'XPath' },
                  ]}
                />
              </div>
              <ElSelectorActions
                selector={selector}
                findBy={findBy === 'xpath' ? 'xpath' : 'cssSelector'}
                multiple={bool(data, 'multiple')}
                onSelector={(sel) => onChange({ selector: sel })}
              />
            </div>
          </Field>
          <Field label="Selector">
            <TextArea
              mono
              value={selector}
              placeholder={findBy === 'xpath' ? '//div[@class="..."]' : '.css-selector'}
              onChange={(v) => onChange({ selector: v })}
            />
          </Field>

          <Expand title="Selector options">
            {!hideMultiple && (
              <Checkbox
                checked={bool(data, 'multiple')}
                onChange={(v) => onChange({ multiple: v })}
                label="Select multiple elements"
                title="Apply the block to every matched element"
              />
            )}
            {!hideMarkEl && findBy === 'cssSelector' && (
              <Checkbox
                checked={bool(data, 'markEl')}
                onChange={(v) => onChange({ markEl: v })}
                label="Mark the element on execution"
              />
            )}
            <Checkbox
              checked={bool(data, 'waitForSelector')}
              onChange={(v) => onChange({ waitForSelector: v })}
              label="Wait for selector"
            />
            {bool(data, 'waitForSelector') && (
              <Field label="Timeout (ms)">
                <TextInput
                  type="number"
                  value={num(data, 'waitSelectorTimeout', 5000)}
                  onChange={(v) => onChange({ waitSelectorTimeout: Number(v) || 5000 })}
                />
              </Field>
            )}
          </Expand>
        </>
      )}

      {children}
    </div>
  )
}

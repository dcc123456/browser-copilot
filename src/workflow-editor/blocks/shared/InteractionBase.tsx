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

import { useState, type ReactNode } from 'react'
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

/** One spec of a conversation locator, as human-readable text. */
function describeSpec(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return ''
  const s = spec as { how?: unknown; value?: unknown; role?: unknown; tag?: unknown; nth?: unknown }
  if (typeof s.how !== 'string' || !s.how || typeof s.value !== 'string') return ''
  const tag = typeof s.tag === 'string' && s.tag.trim() ? `${s.tag.trim()} ` : ''
  const nth = typeof s.nth === 'number' && s.nth > 0 ? ` [#${s.nth + 1}]` : ''
  if (s.how === 'role') {
    const role = typeof s.role === 'string' && s.role.trim() ? s.role.trim() : 'element'
    return `${tag}role=${role} "${s.value}"${nth}`
  }
  if (s.how === 'text') return `${tag}text "${s.value}"${nth}`
  return `${tag}${s.how}=${s.value}${nth}`
}

/**
 * Human summary of the node's conversation locator (`data.target`, written by
 * the chat→workflow generator for role/text targets a CSS selector cannot
 * express). Empty when the node has none — the plain selector shows instead.
 * Exported for forms that render a selector row outside this skeleton (the
 * ocr block's element source).
 */
export function targetSummary(data: Record<string, unknown>): string {
  const target = data['target'] as { primary?: unknown; fallbacks?: unknown } | undefined
  const primary = describeSpec(target?.primary)
  if (!primary) return ''
  const fallbacks = Array.isArray(target?.fallbacks) ? target.fallbacks : []
  const extra = fallbacks.map(describeSpec).filter(Boolean)
  return extra.length > 0 ? `${primary} ｜ fallback: ${extra.join(', ')}` : primary
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
  // A generated node may carry the conversation's locator instead of a CSS
  // selector — show it read-only so the edit panel is not blank.
  const locatorHint = selector ? '' : targetSummary(data)
  // Latest "verify selector" outcome, shown inline so the operator has feedback
  // even though ElSelectorActions has no toast host of its own in this popup.
  const [verifyStatus, setVerifyStatus] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null)
  const reportVerify = (text: string, kind: 'ok' | 'error'): void => setVerifyStatus({ text, kind })

  return (
    <div className="wf-form">
      {!hideDescription && (
        <Field>
          <TextArea
            value={str(data, 'description')}
            placeholder="Description"
            onChange={(v) => onChange({ description: v })}
          />
        </Field>
      )}

      {header}

      {!hideSelector && (
        <>
          {/* Automa: find-by select (flex-1) + pick/verify buttons on ONE row. */}
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
              onMessage={reportVerify}
            />
          </div>
          {verifyStatus && (
            <p className={`wf-form-note wf-verify-${verifyStatus.kind}`}>{verifyStatus.text}</p>
          )}
          {locatorHint && <p className="wf-form-note">{locatorHint}</p>}
          <Field>
            <TextArea
              mono
              value={selector}
              placeholder={
                locatorHint
                  ? 'Leave empty to use the conversation locator above; type a CSS selector to override'
                  : findBy === 'xpath'
                    ? '//div[@class="..."]'
                    : '.css-selector'
              }
              onChange={(v) => onChange({ selector: v })}
            />
          </Field>

          <Expand title="Selector options">
            <div className="wf-selector-options">
              <div className="wf-selector-options-row">
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
              </div>
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
            </div>
          </Expand>
        </>
      )}

      {children}
    </div>
  )
}

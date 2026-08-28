/**
 * EditLoopElements — "Loop elements" block form.
 *
 * React port of Automa's EditLoopElements.vue. Built on the shared interaction
 * skeleton (the "multiple"/"mark element" options are hidden — this block
 * always iterates all matched elements). Extra fields:
 *   - Loop ID (auto-generated like Automa's nanoid(6) when empty)
 *   - Max data to loop (0 to disable)
 *   - Reverse loop order
 *   - "Load more elements" section: load-more action (none / click-element /
 *     click-link / scroll down / scroll up), the action-element selector with
 *     pick actions, max wait times, and the scroll-to-bottom/top flag.
 *
 * @module workflow-editor/blocks/batchA/EditLoopElements
 */
import { useEffect } from 'react'
import { Checkbox, Field, Select, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, num, str } from '../shared/InteractionBase'
import ElSelectorActions from '../shared/ElSelectorActions'
import { nanoid } from './_shared'

const LOAD_MORE_ACTIONS = [
  { value: 'none', label: 'None' },
  { value: 'click-element', label: 'Click an element' },
  { value: 'click-link', label: 'Click a link' },
  { value: 'scroll', label: 'Scroll down' },
  { value: 'scroll-up', label: 'Scroll up' },
]

export default function EditLoopElements({ data, onChange }: EditFormProps) {
  const loadMoreAction = str(data, 'loadMoreAction') || 'none'
  const actionElSelector = str(data, 'actionElSelector')

  // Automa auto-assigns a loop id on mount; replicate that on first render.
  useEffect(() => {
    if (!str(data, 'loopId')) {
      onChange({ loopId: nanoid(6) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <InteractionBase data={data} onChange={onChange} hideMultiple hideMarkEl
      header={
        <Field label="Loop ID">
          <TextInput
            value={str(data, 'loopId')}
            placeholder="Loop ID"
            onChange={(v) => onChange({ loopId: v.replace(/\s/g, '') || nanoid(6) })}
          />
        </Field>
      }
    >
      <Field label="Max data to loop (0 to disable)" >
        <TextInput
          value={str(data, 'maxLoop') || '0'}
          onChange={(v) => onChange({ maxLoop: v })}
        />
      </Field>
      <Checkbox
        checked={bool(data, 'reverseLoop')}
        onChange={(v) => onChange({ reverseLoop: v })}
        label="Reverse loop order"
      />

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--bc-border, rgba(128,128,128,0.25))' }}>
        <p style={{ fontSize: 13, opacity: 0.75, margin: '0 0 8px' }}>Load more elements</p>
        <Field label="Action">
          <Select
            value={loadMoreAction}
            onChange={(v) => onChange({ loadMoreAction: v })}
            options={LOAD_MORE_ACTIONS}
          />
        </Field>

        {(loadMoreAction === 'click-element' || loadMoreAction === 'click-link') && (
          <Field label="Element selector">
            <div className="wf-selector-row">
              <TextInput
                value={actionElSelector}
                placeholder="CSS Selector or XPath"
                onChange={(v) => onChange({ actionElSelector: v })}
              />
              <ElSelectorActions
                selector={actionElSelector}
                onSelector={(sel) => onChange({ actionElSelector: sel })}
              />
            </div>
          </Field>
        )}

        {['click-element', 'scroll', 'scroll-up'].includes(loadMoreAction) && (
          <Field label="Max seconds wait for more elements">
            <TextInput
              type="number"
              value={num(data, 'actionElMaxWaitTime', 5)}
              placeholder="0"
              onChange={(v) => onChange({ actionElMaxWaitTime: Number(v) || 0 })}
            />
          </Field>
        )}

        {loadMoreAction.includes('scroll') && (
          <Checkbox
            checked={bool(data, 'scrollToBottom')}
            onChange={(v) => onChange({ scrollToBottom: v })}
            label={loadMoreAction === 'scroll-up' ? 'Scroll to top' : 'Scroll to bottom'}
          />
        )}

        {loadMoreAction === 'click-link' && (
          <Field label="Max seconds wait for the page to load">
            <TextInput
              type="number"
              value={num(data, 'actionPageMaxWaitTime', 10)}
              placeholder="0"
              onChange={(v) => onChange({ actionPageMaxWaitTime: Number(v) || 0 })}
            />
          </Field>
        )}
      </div>
    </InteractionBase>
  )
}

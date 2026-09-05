/**
 * EditLoopElements — React port of Automa's EditLoopElements.vue.
 *
 * Reuses the interaction skeleton (description + find-by + selector +
 * selector options; multiple/mark-el hidden) and adds the loop id, max-loop,
 * reverse toggle, and the "load more elements" section (click an element,
 * click a link / paginate, or scroll to load more). The on-page element
 * picker for the action selector is out of scope — a plain selector field.
 *
 * @module workflow-editor/blocks/batchC/EditLoopElements
 */

import { useEffect } from 'react'
import type { EditFormProps } from '../EditForms'
import InteractionBase from '../shared/InteractionBase'
import { Checkbox, Field, NumberInput, Select, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import { id } from './shared'

const ACTIONS = [
  { value: 'none', label: 'None' },
  { value: 'click-element', label: 'Click an element' },
  { value: 'click-link', label: 'Click a link' },
  { value: 'scroll', label: 'Scroll down' },
  { value: 'scroll-up', label: 'Scroll up' },
]

export default function EditLoopElements({ data, onChange }: EditFormProps) {
  useEffect(() => {
    if (!str(data, 'loopId')) onChange({ loopId: id(6) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const action = str(data, 'loadMoreAction') || 'none'

  return (
    <InteractionBase
      data={data}
      onChange={onChange}
      hideMultiple
      hideMarkEl
      header={
        <Field label="Loop ID">
          <TextInput
            value={str(data, 'loopId')}
            placeholder="Loop ID"
            onChange={(v) => onChange({ loopId: v.replace(/\s/g, '') })}
          />
        </Field>
      }
    >
      <Field label="Max data to loop (0 to disable)" title="Max number of data to loop">
        <NumberInput
          value={typeof data.maxLoop === 'string' || typeof data.maxLoop === 'number' ? (data.maxLoop as string | number) : '0'}
          fallback={0}
          onChange={(n) => onChange({ maxLoop: n })}
        />
      </Field>
      <Checkbox checked={bool(data, 'reverseLoop')} onChange={(v) => onChange({ reverseLoop: v })} label="Reverse loop order" />

      <div style={{ borderTop: '1px solid var(--bc-border, #ccc)', marginTop: 16, paddingTop: 16 }}>
        <p className="wf-form-note">Load more elements</p>
        <Field label="Action">
          <Select value={action} onChange={(v) => onChange({ loadMoreAction: v })} options={ACTIONS} />
        </Field>

        {(action === 'click-element' || action === 'click-link') && (
          <Field label="Element selector">
            <TextInput
              value={str(data, 'actionElSelector')}
              placeholder="CSS Selector or XPath"
              onChange={(v) => onChange({ actionElSelector: v })}
            />
          </Field>
        )}

        {(action === 'click-element' || action === 'scroll' || action === 'scroll-up') && (
          <Field label="Max seconds wait for more elements">
            <NumberInput
              value={num(data, 'actionElMaxWaitTime', 5)}
              placeholder="0"
              fallback={0}
              onChange={(n) => onChange({ actionElMaxWaitTime: n })}
            />
          </Field>
        )}

        {action.includes('scroll') && (
          <Checkbox
            checked={bool(data, 'scrollToBottom')}
            onChange={(v) => onChange({ scrollToBottom: v })}
            label={action === 'scroll-up' ? 'Scroll to top' : 'Scroll to bottom'}
          />
        )}

        {action === 'click-link' && (
          <Field label="Max seconds wait for the page to load">
            <NumberInput
              value={num(data, 'actionPageMaxWaitTime', 10)}
              placeholder="0"
              fallback={0}
              onChange={(n) => onChange({ actionPageMaxWaitTime: n })}
            />
          </Field>
        )}
      </div>
    </InteractionBase>
  )
}

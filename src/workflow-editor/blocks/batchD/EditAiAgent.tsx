/**
 * EditAiAgent — Browser-Copilot's own "AI agent" block form.
 *
 * Unlike the Automa-ported forms, this block does not exist upstream: at
 * runtime it reads a target element's text, hands it plus the user's prompt to
 * the tool-calling agent loop, and stores the agent's final answer in a
 * variable. The form therefore collects:
 *   - a description (shown on the node)
 *   - an optional target element (CSS/XPath selector with pick/verify)
 *   - the user's prompt (supports {{variable}} interpolation)
 *   - an "act on page" switch (off = read-only analysis, on = full-auto)
 *   - advanced: tool-round budget, output variable name, auto-snapshot
 *
 * @module workflow-editor/blocks/batchD/EditAiAgent
 */

import type { EditFormProps } from '../EditForms'
import { Checkbox, Expand, Field, NumberInput, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import ElSelectorActions from '../shared/ElSelectorActions'

export default function EditAiAgent({ data, onChange }: EditFormProps) {
  const findBy = str(data, 'findBy') || 'cssSelector'
  const selector = str(data, 'selector')
  const actOnPage = bool(data, 'actOnPage')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Target element (optional)">
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
            onSelector={(sel) => onChange({ selector: sel })}
          />
        </div>
      </Field>
      <Field label="Selector" title="Leave empty to let the agent read the whole page itself.">
        <TextArea
          mono
          value={selector}
          placeholder={findBy === 'xpath' ? '//div[@class="..."] (optional)' : '.css-selector (optional)'}
          onChange={(v) => onChange({ selector: v })}
        />
      </Field>
      <p className="wf-form-note">
        The matched element's text is read at runtime and given to the agent. Leave it empty and the
        agent reads the page itself via its tools.
      </p>

      <Field label="Prompt *">
        <TextArea
          rows={5}
          value={str(data, 'prompt')}
          placeholder={'e.g. Summarize the price in this element and fill the coupon code box.\nUse {{variableName}} to insert a workflow variable.'}
          onChange={(v) => onChange({ prompt: v })}
        />
      </Field>

      <Checkbox
        checked={actOnPage}
        onChange={(v) => onChange({ actOnPage: v })}
        label={
          <>
            Allow the agent to <strong>act on the page</strong> (click, fill, navigate)
          </>
        }
        title="Off: the agent only reads and analyzes (read-only). On: it performs actions autonomously without per-step confirmation."
      />
      <p className="wf-form-note">
        {actOnPage
          ? 'Full auto: the agent may click, type, and navigate to finish the task. Every action is written to the run log.'
          : 'Read-only: the agent can read/snapshot the page and answer, but cannot click, type, or navigate.'}
      </p>

      <Expand title="Advanced">
        <Field label="Max tool rounds">
          <NumberInput
            value={num(data, 'maxToolRounds', 20)}
            min={1}
            max={50}
            fallback={20}
            onChange={(n) => onChange({ maxToolRounds: n })}
          />
        </Field>
        <Field label="Output variable name">
          <TextInput
            value={str(data, 'variableName')}
            placeholder="lastAIAgent"
            fallback="lastAIAgent"
            onChange={(v) => onChange({ variableName: v })}
          />
        </Field>
        <Checkbox
          checked={bool(data, 'useSnapshot')}
          onChange={(v) => onChange({ useSnapshot: v })}
          label="Take a page snapshot before acting"
          title="Lets the agent list buttons/links/fields so it can locate elements itself."
        />
      </Expand>
    </div>
  )
}

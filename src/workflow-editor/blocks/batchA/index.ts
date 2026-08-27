/**
 * Batch A — Web interaction block edit forms.
 *
 * React ports of Automa's edit/Edit*.vue forms for the interaction-category
 * blocks (click, forms, link, get-text, attribute, hover, press-key, scroll,
 * trigger-event, element-exists, loop-elements, create-element, upload-file,
 * switch-frame). Every form receives `{ data, onChange, blockId }`
 * (EditFormProps) and merges Automa-shaped patches into the block data.
 *
 * Wiring note: blocks whose catalog `editComponent` is `EditInteractionBase`
 * (event-click, hover-element) use the thin EditEventClick / EditHoverElement
 * wrappers; the element-scroll catalog entry points at `EditScrollElement` and
 * is satisfied here by EditElementScroll.
 *
 * @module workflow-editor/blocks/batchA
 */
import type { ComponentType } from 'react'
import type { EditFormProps } from '../EditForms'

import EditEventClick from './EditEventClick'
import EditForms from './EditForms'
import EditLink from './EditLink'
import EditGetText from './EditGetText'
import EditAttributeValue from './EditAttributeValue'
import EditHoverElement from './EditHoverElement'
import EditPressKey from './EditPressKey'
import EditElementScroll from './EditElementScroll'
import EditTriggerEvent from './EditTriggerEvent'
import EditElementExists from './EditElementExists'
import EditLoopElements from './EditLoopElements'
import EditCreateElement from './EditCreateElement'
import EditUploadFile from './EditUploadFile'
import EditSwitchTo from './EditSwitchTo'

export {
  EditEventClick,
  EditForms,
  EditLink,
  EditGetText,
  EditAttributeValue,
  EditHoverElement,
  EditPressKey,
  EditElementScroll,
  EditTriggerEvent,
  EditElementExists,
  EditLoopElements,
  EditCreateElement,
  EditUploadFile,
  EditSwitchTo,
}

export const BatchAForms: Record<string, ComponentType<EditFormProps>> = {
  EditEventClick,
  EditForms,
  EditLink,
  EditGetText,
  EditAttributeValue,
  EditHoverElement,
  EditPressKey,
  EditElementScroll,
  EditTriggerEvent,
  EditElementExists,
  EditLoopElements,
  EditCreateElement,
  EditUploadFile,
  EditSwitchTo,
}

/**
 * Batch C form registry — DATA + CONTROL-FLOW (conditions) blocks.
 *
 * Maps Automa `editComponent` names (from the block catalog) to their React
 * ports. The workflow editor's block edit form looks components up by these
 * keys; blocks not registered here fall back to the generic key/value editor.
 *
 * Cloud blocks (ai-workflow / block-package / google-sheets*) are intentionally
 * absent. `element-exists` (EditElementExists) is owned by batch A.
 *
 * @module workflow-editor/blocks/batchC
 */

import type { ComponentType } from 'react'
import type { EditFormProps } from '../EditForms'

import EditConditions from './EditConditions'
import EditWhileLoop from './EditWhileLoop'
import EditLoopData from './EditLoopData'
import EditLoopElements from './EditLoopElements'
import EditJavascriptCode from './EditJavascriptCode'
import EditExecuteWorkflow from './EditExecuteWorkflow'
import EditExportData from './EditExportData'
import EditLogData from './EditLogData'
import EditInsertData from './EditInsertData'
import EditDeleteData from './EditDeleteData'
import EditSliceVariable from './EditSliceVariable'
import EditIncreaseVariable from './EditIncreaseVariable'
import EditRegexVariable from './EditRegexVariable'
import EditDataMapping from './EditDataMapping'
import EditSortData from './EditSortData'

export const BatchCForms: Record<string, ComponentType<EditFormProps>> = {
  // Control flow (conditions category)
  EditConditions,
  EditWhileLoop,
  EditLoopData,
  EditLoopElements,
  EditJavascriptCode,
  EditExecuteWorkflow,
  // Data
  EditExportData,
  EditLogData,
  EditInsertData,
  EditDeleteData,
  EditSliceVariable,
  EditIncreaseVariable,
  EditRegexVariable,
  EditDataMapping,
  EditSortData,
}

/**
 * Batch D — GENERAL + ONLINE-SERVICES (local) + TRIGGER block edit forms.
 *
 * Registry mapping Automa `editComponent` names to their React ports. Only
 * local (non-cloud) blocks in the `general` category are covered here; the
 * cloud online-services blocks (Google Sheets / Drive) are excluded, as are the
 * interaction / browser / data / control-flow forms owned by batches A–C.
 *
 * @module workflow-editor/blocks/batchD
 */

import type { ComponentType } from 'react'
import type { EditFormProps } from '../EditForms'

import EditNotification from './EditNotification'
import EditWebhook from './EditWebhook'
import EditExportData from './EditExportData'
import EditWorkflowState from './EditWorkflowState'
import EditParameterPrompt from './EditParameterPrompt'
import EditTrigger from './EditTrigger'
import EditAiAgent from './EditAiAgent'

export const BatchDForms: Record<string, ComponentType<EditFormProps>> = {
  EditTrigger,
  EditWebhook,
  EditExportData,
  EditNotification,
  EditWorkflowState,
  EditParameterPrompt,
  // Browser-Copilot extension block (not from Automa's catalog).
  EditAiAgent,
}

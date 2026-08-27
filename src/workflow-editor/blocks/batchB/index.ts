/**
 * Batch B block edit forms — React ports of Automa's browser / navigation
 * block forms (new-tab, new-window, switch-tab, close-tab, go-back,
 * forward-page, reload-tab, tab-url, take-screenshot, clipboard, cookie,
 * handle-dialog, handle-download, delay, proxy, wait-connections,
 * save-assets, note).
 *
 * Keys match Automa's `editComponent` names in the block catalog.
 *
 * @module workflow-editor/blocks/batchB
 */

import type { ComponentType } from 'react'
import type { EditFormProps } from '../EditForms'

import EditNewTab from './EditNewTab'
import EditNewWindow from './EditNewWindow'
import EditSwitchTab from './EditSwitchTab'
import EditCloseTab from './EditCloseTab'
import EditGoBack from './EditGoBack'
import EditForwardPage from './EditForwardPage'
import EditReloadTab from './EditReloadTab'
import EditTabUrl from './EditTabUrl'
import EditTakeScreenshot from './EditTakeScreenshot'
import EditClipboard from './EditClipboard'
import EditCookie from './EditCookie'
import EditHandleDialog from './EditHandleDialog'
import EditHandleDownload from './EditHandleDownload'
import EditDelay from './EditDelay'
import EditProxy from './EditProxy'
import EditWaitConnections from './EditWaitConnections'
import EditSaveAssets from './EditSaveAssets'
import EditBlockNote from './EditBlockNote'
import EditBrowserEvent from './EditBrowserEvent'

export const BatchBForms: Record<string, ComponentType<EditFormProps>> = {
  EditNewTab,
  EditNewWindow,
  EditSwitchTab,
  EditCloseTab,
  EditGoBack,
  EditForwardPage,
  EditReloadTab,
  EditTabUrl,
  EditTakeScreenshot,
  EditClipboard,
  EditCookie,
  EditHandleDialog,
  EditHandleDownload,
  EditDelay,
  EditProxy,
  EditWaitConnections,
  EditSaveAssets,
  EditBlockNote,
  EditBrowserEvent,
}

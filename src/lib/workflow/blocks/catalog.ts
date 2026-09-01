/**
 * Browser Copilot block catalog. Authored from scratch for Browser Copilot;
 * not derived from any third-party workflow source. Licensed under the
 * repository LICENSE (SPDX: PolyForm-Noncommercial-1.0.0).
 *
 * @module lib/workflow/blocks/catalog
 */

import type { BlockCatalogEntry, BlockCategory, CategoryMeta } from './types'

export const CATEGORY_META: Record<BlockCategory, CategoryMeta> = {
  "interaction": {
    "name": "Web interaction",
    "light": {
      "bg": "#bbf7d0",
      "border": "#bbf7d0"
    },
    "dark": {
      "bg": "#86efac",
      "border": "#86efac"
    }
  },
  "browser": {
    "name": "Browser",
    "light": {
      "bg": "#fed7aa",
      "border": "#fed7aa"
    },
    "dark": {
      "bg": "#fdba74",
      "border": "#fdba74"
    }
  },
  "general": {
    "name": "General",
    "light": {
      "bg": "#fef08a",
      "border": "#fef08a"
    },
    "dark": {
      "bg": "#fde047",
      "border": "#fde047"
    }
  },
  "onlineServices": {
    "name": "Online services",
    "light": {
      "bg": "#fecaca",
      "border": "#fecaca"
    },
    "dark": {
      "bg": "#fca5a5",
      "border": "#fca5a5"
    }
  },
  "data": {
    "name": "Data",
    "light": {
      "bg": "#d9f99d",
      "border": "#d9f99d"
    },
    "dark": {
      "bg": "#bef264",
      "border": "#bef264"
    }
  },
  "conditions": {
    "name": "Control flow",
    "light": {
      "bg": "#bfdbfe",
      "border": "#bfdbfe"
    },
    "dark": {
      "bg": "#93c5fd",
      "border": "#93c5fd"
    }
  },
  "package": {
    "name": "Packages",
    "light": {
      "bg": "#a5f3fc",
      "border": "#a5f3fc"
    },
    "dark": {
      "bg": "#67e8f9",
      "border": "#67e8f9"
    }
  }
}

export const BLOCK_CATALOG: BlockCatalogEntry[] = [
  {
    "id": "trigger",
    "name": "Trigger",
    "description": "Entry point at which a workflow starts running",
    "icon": "riFlashlightLine",
    "component": "Default",
    "editComponent": "EditTrigger",
    "category": "general",
    "inputs": 0,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "url"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "type": "manual",
      "interval": 60,
      "delay": 5,
      "date": "",
      "time": "00:00",
      "url": "",
      "shortcut": "",
      "activeInInput": false,
      "isUrlRegex": false,
      "days": [],
      "contextMenuName": "",
      "contextTypes": [],
      "parameters": [],
      "preferParamsInTab": false,
      "observeElement": {
        "selector": "",
        "baseSelector": "",
        "matchPattern": "",
        "targetOptions": {
          "subtree": false,
          "childList": true,
          "attributes": false,
          "attributeFilter": [],
          "characterData": false
        },
        "baseElOptions": {
          "subtree": false,
          "childList": true,
          "attributes": false,
          "attributeFilter": [],
          "characterData": false
        }
      }
    },
    "cloud": false
  },
  {
    "id": "ai-workflow",
    "name": "AI Workflow",
    "description": "Runs a workflow produced by an AI assistant",
    "icon": "https://winrobot-pub-a-1302949341.cos.ap-shanghai.myqcloud.com/image/20250717194249/10e0c06a7b243d15ac9a9385b07ce4e2.svg",
    "component": "Default",
    "editComponent": "EditAiWorkflow",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "tag": "AI",
    "data": {
      "disableBlock": false,
      "flowUuid": "",
      "flowLabel": "",
      "description": "",
      "inputs": [],
      "outputs": [],
      "assignVariable": false,
      "variableName": "",
      "saveData": false,
      "dataColumn": ""
    },
    "cloud": true
  },
  {
    "id": "execute-workflow",
    "name": "Execute workflow",
    "description": "Run another workflow and hand data to it",
    "icon": "riFlowChart",
    "component": "Default",
    "editComponent": "EditExecuteWorkflow",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "globalData"
    ],
    "data": {
      "disableBlock": false,
      "executeId": "",
      "workflowId": "",
      "globalData": "",
      "description": "",
      "insertAllVars": false,
      "insertAllGlobalData": false
    },
    "cloud": false
  },
  {
    "id": "active-tab",
    "name": "Active tab",
    "description": "Treat the current tab as the one being worked on",
    "icon": "riWindowLine",
    "component": "Default",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false
    },
    "cloud": false
  },
  {
    "id": "new-tab",
    "name": "New tab",
    "description": "Open a URL in a brand-new browser tab",
    "icon": "riGlobalLine",
    "component": "Default",
    "editComponent": "EditNewTab",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "url",
      "userAgent"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "url": "",
      "userAgent": "",
      "active": true,
      "tabZoom": 1,
      "inGroup": false,
      "waitTabLoaded": false,
      "updatePrevTab": false,
      "customUserAgent": false
    },
    "cloud": false
  },
  {
    "id": "switch-tab",
    "name": "Switch tab",
    "description": "Bring a matching open tab to the foreground",
    "icon": "riArrowLeftRightLine",
    "component": "Default",
    "editComponent": "EditSwitchTab",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "url",
      "matchPattern",
      "tabTitle"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "url": "",
      "tabIndex": 0,
      "tabTitle": "",
      "matchPattern": "",
      "activeTab": true,
      "createIfNoMatch": false,
      "findTabBy": "match-patterns"
    },
    "cloud": false
  },
  {
    "id": "new-window",
    "name": "New window",
    "description": "Open a URL in a separate browser window",
    "icon": "riWindow2Line",
    "component": "Default",
    "editComponent": "EditNewWindow",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "url"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "top": 0,
      "left": 0,
      "width": 0,
      "url": "",
      "height": 0,
      "type": "normal",
      "incognito": false,
      "windowState": "normal"
    },
    "cloud": false
  },
  {
    "id": "proxy",
    "name": "Proxy",
    "description": "Route browser network traffic through a proxy",
    "icon": "riShieldKeyholeLine",
    "component": "Default",
    "editComponent": "EditProxy",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "host",
      "port",
      "scheme"
    ],
    "data": {
      "description": "",
      "disableBlock": false,
      "scheme": "https",
      "host": "",
      "port": 443,
      "bypassList": "",
      "clearProxy": false
    },
    "cloud": false
  },
  {
    "id": "go-back",
    "name": "Go back",
    "description": "Navigate to the previous page in history",
    "icon": "riArrowGoBackLine",
    "component": "Default",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false
    },
    "cloud": false
  },
  {
    "id": "forward-page",
    "name": "Go forward",
    "description": "Navigate to the next page in history",
    "icon": "riArrowGoForwardLine",
    "component": "Default",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false
    },
    "cloud": false
  },
  {
    "id": "close-tab",
    "name": "Close tab/window",
    "description": "Close the current tab or browser window",
    "icon": "riCloseCircleLine",
    "component": "Default",
    "editComponent": "EditCloseTab",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "url"
    ],
    "data": {
      "disableBlock": false,
      "url": "",
      "description": "",
      "activeTab": true,
      "closeType": "tab",
      "allWindows": false
    },
    "cloud": false
  },
  {
    "id": "take-screenshot",
    "name": "Take screenshot",
    "description": "Capture an image of the visible page",
    "icon": "riImageLine",
    "component": "Default",
    "editComponent": "EditTakeScreenshot",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "fileName",
      "selector",
      "variableName"
    ],
    "data": {
      "description": "",
      "disableBlock": false,
      "fileName": "",
      "ext": "png",
      "quality": 100,
      "dataColumn": "",
      "variableName": "",
      "selector": "",
      "fullPage": false,
      "saveToColumn": false,
      "saveToComputer": true,
      "assignVariable": false,
      "captureActiveTab": true
    },
    "cloud": false
  },
  {
    "id": "browser-event",
    "name": "Browser event",
    "description": "Pause until a chosen browser event occurs",
    "icon": "riLightbulbLine",
    "component": "Default",
    "editComponent": "EditBrowserEvent",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "timeout": 10000,
      "eventName": "tab:loaded",
      "setAsActiveTab": true,
      "activeTabLoaded": true,
      "tabLoadedUrl": "",
      "tabUrl": "",
      "fileQuery": ""
    },
    "cloud": false
  },
  {
    "id": "event-click",
    "name": "Click element",
    "description": "Perform a click on an element in the page",
    "icon": "riCursorLine",
    "component": "Default",
    "editComponent": "EditInteractionBase",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "multiple": false
    },
    "cloud": false
  },
  {
    "id": "delay",
    "name": "Delay",
    "description": "Pause before running the next block for a set time",
    "icon": "riTimerLine",
    "component": "Delay",
    "editComponent": "EditDelay",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "time"
    ],
    "data": {
      "disableBlock": false,
      "time": 500
    },
    "cloud": false
  },
  {
    "id": "get-text",
    "name": "Get text",
    "description": "Read the text rendered by an element",
    "icon": "riParagraph",
    "component": "Default",
    "editComponent": "EditGetText",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "variableName",
      "prefixText",
      "suffixText",
      "extraRowValue"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "multiple": false,
      "regex": "",
      "prefixText": "",
      "suffixText": "",
      "regexExp": [],
      "dataColumn": "",
      "saveData": true,
      "includeTags": false,
      "addExtraRow": false,
      "assignVariable": false,
      "useTextContent": false,
      "variableName": "",
      "extraRowValue": "",
      "extraRowDataColumn": ""
    },
    "cloud": false
  },
  {
    "id": "export-data",
    "name": "Export data",
    "description": "Write collected data out to a file",
    "icon": "riDownloadLine",
    "component": "Default",
    "editComponent": "EditExportData",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "name",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "name": "",
      "refKey": "",
      "type": "json",
      "description": "",
      "variableName": "",
      "csvDelimiter": ",",
      "addBOMHeader": true,
      "onConflict": "uniquify",
      "dataToExport": "data-columns"
    },
    "cloud": false
  },
  {
    "id": "element-scroll",
    "name": "Scroll element",
    "description": "Scroll an element by a specified offset",
    "icon": "riMouseLine",
    "component": "Default",
    "editComponent": "EditScrollElement",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "html",
      "markEl": false,
      "multiple": false,
      "scrollY": 0,
      "scrollX": 0,
      "incX": false,
      "incY": false,
      "smooth": false,
      "scrollIntoView": false
    },
    "cloud": false
  },
  {
    "id": "link",
    "name": "Link",
    "description": "Follow a link element in the page",
    "icon": "riLink",
    "component": "Default",
    "editComponent": "EditLink",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "disableMultiple": true,
      "openInNewTab": false
    },
    "cloud": false
  },
  {
    "id": "attribute-value",
    "name": "Attribute value",
    "description": "Read or update an attribute on an element",
    "icon": "riBracketsLine",
    "component": "Default",
    "editComponent": "EditAttributeValue",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "variableName",
      "attributeName",
      "extraRowValue",
      "attributeValue"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "multiple": false,
      "attributeValue": "",
      "attributeName": "",
      "assignVariable": false,
      "variableName": "",
      "dataColumn": "",
      "saveData": true,
      "action": "get",
      "addExtraRow": false,
      "extraRowValue": "",
      "extraRowDataColumn": ""
    },
    "cloud": false
  },
  {
    "id": "forms",
    "name": "Forms",
    "description": "Fill or manipulate form controls such as inputs and selects",
    "icon": "riInputCursorMove",
    "component": "Default",
    "editComponent": "EditForms",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "variableName",
      "value",
      "optionPosition",
      "delay"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "multiple": false,
      "selected": true,
      "clearValue": true,
      "getValue": false,
      "saveData": false,
      "dataColumn": "",
      "selectOptionBy": "value",
      "optionPosition": "1",
      "assignVariable": false,
      "variableName": "",
      "type": "text-field",
      "value": "",
      "delay": 0,
      "events": []
    },
    "cloud": false
  },
  {
    "id": "repeat-task",
    "name": "Repeat task",
    "description": "Run the attached branch a set number of times",
    "icon": "riRepeat2Line",
    "component": "RepeatTask",
    "category": "conditions",
    "inputs": 1,
    "outputs": 2,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "repeatFor"
    ],
    "data": {
      "disableBlock": false,
      "repeatFor": "1"
    },
    "cloud": false
  },
  {
    "id": "javascript-code",
    "name": "JavaScript code",
    "description": "Run custom JavaScript inside the page context",
    "icon": "riCodeSSlashLine",
    "component": "Default",
    "editComponent": "EditJavascriptCode",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "timeout": 20000,
      "context": "website",
      "code": "console.log(\"Script started\");\nautomaNextBlock()",
      "preloadScripts": [],
      "everyNewTab": false,
      "runBeforeLoad": false
    },
    "cloud": false
  },
  {
    "id": "trigger-event",
    "name": "Trigger event",
    "description": "Dispatch an event on the page",
    "icon": "riLightbulbFlashLine",
    "component": "Default",
    "editComponent": "EditTriggerEvent",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "eventParams.clientX",
      "eventParams.clientY"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "html",
      "markEl": false,
      "multiple": false,
      "eventName": "",
      "eventType": "",
      "eventParams": {
        "bubbles": true,
        "cancelable": false
      }
    },
    "cloud": false
  },
  {
    "id": "google-sheets",
    "name": "Google Sheets",
    "description": "Read or write a Google Sheets spreadsheet",
    "icon": "riTableLine",
    "component": "Default",
    "editComponent": "EditGoogleSheets",
    "category": "onlineServices",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "customData",
      "range",
      "spreadsheetId",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "range": "",
      "refKey": "",
      "type": "get",
      "customData": "",
      "description": "",
      "spreadsheetId": "",
      "dataColumn": "",
      "saveData": true,
      "assignVariable": false,
      "variableName": "",
      "firstRowAsKey": false,
      "keysAsFirstRow": true,
      "valueInputOption": "RAW",
      "InsertDataOption": "INSERT_ROWS",
      "dataFrom": "data-columns"
    },
    "cloud": true
  },
  {
    "id": "google-sheets-drive",
    "name": "Google Sheets (Drive)",
    "description": "Work with a spreadsheet stored in Google Drive",
    "icon": "riDriveFill",
    "component": "Default",
    "editComponent": "EditGoogleSheetsDrive",
    "category": "onlineServices",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "customData",
      "range",
      "spreadsheetId",
      "sheetName",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "range": "",
      "refKey": "",
      "type": "get",
      "customData": "",
      "description": "",
      "spreadsheetId": "",
      "dataColumn": "",
      "inputSpreadsheetId": "connected",
      "saveData": true,
      "sheetName": "",
      "assignVariable": false,
      "variableName": "",
      "firstRowAsKey": false,
      "keysAsFirstRow": true,
      "valueInputOption": "RAW",
      "InsertDataOption": "INSERT_ROWS",
      "dataFrom": "data-columns"
    },
    "cloud": true
  },
  {
    "id": "google-drive",
    "name": "Google Drive",
    "description": "Upload files to a Google Drive account",
    "icon": "riDriveLine",
    "component": "Default",
    "editComponent": "EditGoogleDrive",
    "category": "onlineServices",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [],
    "data": {
      "disableBlock": false,
      "action": "upload",
      "filePaths": []
    },
    "cloud": true
  },
  {
    "id": "conditions",
    "name": "Conditions",
    "description": "Branch execution according to tested conditions",
    "icon": "riAB",
    "component": "Conditions",
    "editComponent": "EditConditions",
    "category": "conditions",
    "inputs": 1,
    "outputs": 0,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "description": "",
      "disableBlock": false,
      "conditions": [],
      "retryConditions": false,
      "retryCount": 10,
      "retryTimeout": 1000
    },
    "cloud": false
  },
  {
    "id": "element-exists",
    "name": "Element exists",
    "description": "Branch on whether an element is present",
    "icon": "riFocus3Line",
    "component": "ElementExists",
    "editComponent": "EditElementExists",
    "category": "conditions",
    "inputs": 1,
    "outputs": 2,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "selector": "",
      "tryCount": 1,
      "timeout": 500,
      "markEl": false,
      "throwError": false
    },
    "cloud": false
  },
  {
    "id": "webhook",
    "name": "HTTP Request",
    "description": "Send an HTTP request to a remote endpoint",
    "icon": "riEarthLine",
    "component": "Default",
    "editComponent": "EditWebhook",
    "category": "general",
    "inputs": 1,
    "outputs": 2,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "body",
      "url",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "url": "",
      "body": "{}",
      "headers": [],
      "method": "POST",
      "timeout": 10000,
      "dataPath": "",
      "contentType": "json",
      "variableName": "",
      "assignVariable": false,
      "saveData": false,
      "dataColumn": "",
      "responseType": "json"
    },
    "cloud": false
  },
  {
    "id": "while-loop",
    "name": "While loop",
    "description": "Keep running the branch while a condition holds",
    "icon": "riRefreshFill",
    "component": "Default",
    "editComponent": "EditWhileLoop",
    "category": "conditions",
    "inputs": 1,
    "outputs": 2,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "conditions": null
    },
    "cloud": false
  },
  {
    "id": "loop-data",
    "name": "Loop data",
    "description": "Iterate over table rows or variable values",
    "icon": "riRefreshLine",
    "component": "Default",
    "editComponent": "EditLoopData",
    "category": "conditions",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "maxLoop",
      "loopData",
      "selector",
      "startIndex",
      "variableName",
      "referenceKey",
      "elementSelector"
    ],
    "data": {
      "disableBlock": false,
      "loopId": "",
      "maxLoop": 0,
      "toNumber": 10,
      "fromNumber": 1,
      "startIndex": 0,
      "loopData": "[]",
      "description": "",
      "variableName": "",
      "referenceKey": "",
      "reverseLoop": false,
      "elementSelector": "",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "resumeLastWorkflow": false,
      "loopThrough": "data-columns"
    },
    "cloud": false
  },
  {
    "id": "loop-elements",
    "name": "Loop elements",
    "description": "Iterate over page elements matching a selector",
    "icon": "riRestartLine",
    "component": "Default",
    "editComponent": "EditLoopElements",
    "category": "conditions",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "maxLoop",
      "selector",
      "variableName",
      "elementSelector",
      "actionElSelector"
    ],
    "data": {
      "disableBlock": false,
      "loopId": "",
      "selector": "",
      "maxLoop": "0",
      "description": "",
      "reverseLoop": false,
      "actionElSelector": "",
      "findBy": "cssSelector",
      "actionElMaxWaitTime": 5,
      "actionPageMaxWaitTime": 10,
      "loadMoreAction": "none",
      "scrollToBottom": true,
      "waitForSelector": false,
      "waitSelectorTimeout": 5000
    },
    "cloud": false
  },
  {
    "id": "loop-breakpoint",
    "name": "Loop breakpoint",
    "description": "Stop the enclosing loop at this point",
    "icon": "riStopLine",
    "component": "LoopBreakpoint",
    "category": "conditions",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false,
      "loopId": "",
      "clearLoop": false
    },
    "cloud": false
  },
  {
    "id": "blocks-group",
    "name": "Blocks group",
    "description": "Bundle a set of blocks into a group",
    "icon": "riFolderZipLine",
    "component": "Group",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false,
      "name": "",
      "blocks": []
    },
    "cloud": false
  },
  {
    "id": "clipboard",
    "name": "Clipboard",
    "description": "Read or write the system clipboard",
    "icon": "riClipboardLine",
    "component": "Default",
    "editComponent": "EditClipboard",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "dataToCopy",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "type": "get",
      "assignVariable": false,
      "variableName": "",
      "saveData": true,
      "dataColumn": "",
      "dataToCopy": "",
      "copySelectedText": false
    },
    "cloud": false
  },
  {
    "id": "insert-data",
    "name": "Insert data",
    "description": "Append records to a table or variable",
    "icon": "riDatabase2Line",
    "component": "Default",
    "editComponent": "EditInsertData",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "dataList": []
    },
    "cloud": false
  },
  {
    "id": "switch-to",
    "name": "Switch frame",
    "description": "Point later steps at the main window or a frame",
    "icon": "riArrowUpDownLine",
    "component": "Default",
    "editComponent": "EditSwitchTo",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "findBy": "cssSelector",
      "selector": "",
      "windowType": "main-window"
    },
    "cloud": false
  },
  {
    "id": "upload-file",
    "name": "Upload file",
    "description": "Attach a file to a file input element",
    "icon": "riFileUploadLine",
    "component": "Default",
    "editComponent": "EditUploadFile",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "filePaths"
    ],
    "data": {
      "disableBlock": false,
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "filePaths": []
    },
    "cloud": false
  },
  {
    "id": "hover-element",
    "name": "Hover element",
    "description": "Move the pointer over an element",
    "icon": "riCursorFill",
    "component": "Default",
    "editComponent": "EditInteractionBase",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "multiple": false
    },
    "cloud": false
  },
  {
    "id": "save-assets",
    "name": "Save assets",
    "description": "Download an image, video, audio, or other file",
    "icon": "riImageLine",
    "component": "Default",
    "editComponent": "EditSaveAssets",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "url",
      "filename",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "findBy": "cssSelector",
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "",
      "markEl": false,
      "multiple": false,
      "type": "element",
      "url": "",
      "filename": "",
      "saveDownloadIds": false,
      "onConflict": "uniquify",
      "dataColumn": "",
      "saveData": true,
      "assignVariable": false,
      "variableName": "",
      "saveToGDrive": false
    },
    "cloud": false
  },
  {
    "id": "press-key",
    "name": "Press key",
    "description": "Send a single key or a key combination",
    "icon": "riKeyboardLine",
    "component": "Default",
    "editComponent": "EditPressKey",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "selector",
      "keys",
      "keysToPress",
      "pressTime"
    ],
    "data": {
      "disableBlock": false,
      "keys": "",
      "selector": "",
      "pressTime": "0",
      "description": "",
      "keysToPress": "",
      "action": "press-key"
    },
    "cloud": false
  },
  {
    "id": "handle-dialog",
    "name": "Handle dialog",
    "description": "Accept or dismiss a browser dialog such as alert or confirm",
    "icon": "riChat3Line",
    "component": "Default",
    "editComponent": "EditHandleDialog",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "promptText"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "accept": true,
      "promptText": ""
    },
    "cloud": false
  },
  {
    "id": "handle-download",
    "name": "Handle download",
    "description": "Manage a file downloaded by the browser",
    "icon": "riFileDownloadLine",
    "component": "Default",
    "editComponent": "EditHandleDownload",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "filename",
      "downloadId",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "filename": "",
      "timeout": 20000,
      "onConflict": "uniquify",
      "waitForDownload": true,
      "dataColumn": "",
      "saveData": true,
      "assignVariable": false,
      "variableName": "",
      "downloadId": ""
    },
    "cloud": false
  },
  {
    "id": "save-local",
    "name": "Save to local",
    "description": "Write a value or data to a local file",
    "icon": "riSaveLine",
    "component": "Default",
    "editComponent": "EditSaveLocal",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "value",
      "filename",
      "saveMode",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "value": "",
      "filename": "",
      "saveMode": "auto",
      "variableName": "lastSavedPath"
    },
    "cloud": false
  },
  {
    "id": "reload-tab",
    "name": "Reload tab",
    "description": "Refresh the active tab",
    "icon": "riRestartLine",
    "component": "Default",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false
    },
    "cloud": false
  },
  {
    "id": "delete-data",
    "name": "Delete data",
    "description": "Remove records from a table or variable",
    "icon": "riDeleteBin7Line",
    "component": "Default",
    "editComponent": "EditDeleteData",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "deleteList": []
    },
    "cloud": false
  },
  {
    "id": "wait-connections",
    "name": "Wait connections",
    "description": "Wait for other incoming flows to finish before continuing",
    "icon": "riTimerFlashLine",
    "component": "Default",
    "editComponent": "EditWaitConnections",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "timeout": 10000,
      "specificFlow": false,
      "flowBlockId": ""
    },
    "cloud": false
  },
  {
    "id": "notification",
    "name": "Notification",
    "description": "Show a desktop notification",
    "icon": "riNotification3Line",
    "component": "Default",
    "editComponent": "EditNotification",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "message",
      "title",
      "iconUrl",
      "imageUrl"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "message": "",
      "iconUrl": "",
      "imageUrl": "",
      "title": "Hello world!"
    },
    "cloud": false
  },
  {
    "id": "log-data",
    "name": "Get log data",
    "description": "Read the most recent log entries of a workflow",
    "icon": "riFileHistoryLine",
    "component": "Default",
    "editComponent": "EditLogData",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "workflowId": "",
      "dataColumn": "",
      "saveData": true,
      "assignVariable": false,
      "variableName": ""
    },
    "cloud": false
  },
  {
    "id": "tab-url",
    "name": "Get tab URL",
    "description": "Read the URL of the active or a matching tab",
    "icon": "riLinksLine",
    "component": "Default",
    "editComponent": "EditTabURL",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "type": "active-tab",
      "dataColumn": "",
      "saveData": true,
      "assignVariable": false,
      "variableName": "",
      "qTitle": "",
      "qMatchPatterns": ""
    },
    "cloud": false
  },
  {
    "id": "slice-variable",
    "name": "Slice variable",
    "description": "Take a segment of a variable's value",
    "icon": "riSliceLine",
    "component": "Default",
    "editComponent": "EditSliceVariable",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "endIdxEnabled": false,
      "startIdxEnabled": true,
      "endIndex": 0,
      "startIndex": 0,
      "variableName": ""
    },
    "cloud": false
  },
  {
    "id": "increase-variable",
    "name": "Increase variable",
    "description": "Add a fixed amount to a variable's value",
    "icon": "riIncreaseDecreaseLine",
    "component": "Default",
    "editComponent": "EditIncreaseVariable",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "increaseBy": 1,
      "variableName": ""
    },
    "cloud": false
  },
  {
    "id": "regex-variable",
    "name": "RegEx variable",
    "description": "Match or transform a variable value with a regular expression",
    "icon": "riFunctionLine",
    "component": "Default",
    "editComponent": "EditRegexVariable",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "replaceVal"
    ],
    "data": {
      "disableBlock": false,
      "method": "match",
      "replaceVal": "",
      "description": "",
      "expression": "",
      "flag": []
    },
    "cloud": false
  },
  {
    "id": "data-mapping",
    "name": "Data mapping",
    "description": "Remap fields from a table or variable",
    "icon": "riMindMap",
    "component": "Default",
    "editComponent": "EditDataMapping",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "dataSource": "table",
      "sources": [],
      "varSourceName": "",
      "dataColumn": "",
      "saveData": false,
      "assignVariable": false,
      "variableName": ""
    },
    "cloud": false
  },
  {
    "id": "sort-data",
    "name": "Sort data",
    "description": "Order the items of a data set",
    "icon": "riSortAsc",
    "component": "Default",
    "editComponent": "EditSortData",
    "category": "data",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "sortByProperty": false,
      "itemProperties": [],
      "dataSource": "table",
      "varSourceName": "",
      "dataColumn": "",
      "saveData": false,
      "assignVariable": false,
      "variableName": ""
    },
    "cloud": false
  },
  {
    "id": "create-element",
    "name": "Create element",
    "description": "Inject a new element into the page",
    "icon": "riHtml5Line",
    "component": "Default",
    "editComponent": "EditCreateElement",
    "category": "interaction",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "html",
      "css",
      "selector"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "javascript": "",
      "html": "",
      "css": "",
      "preloadScripts": [],
      "findBy": "cssSelector",
      "insertAt": "after",
      "runBeforeLoad": false,
      "waitForSelector": false,
      "waitSelectorTimeout": 5000,
      "selector": "body"
    },
    "cloud": false
  },
  {
    "id": "cookie",
    "name": "Cookie",
    "description": "Get, set, or remove browser cookies",
    "icon": "riCookieLine",
    "component": "Default",
    "editComponent": "EditCookie",
    "category": "browser",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "domain",
      "expirationDate",
      "path",
      "sameSite",
      "name",
      "url",
      "value",
      "jsonCode",
      "variableName"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "type": "get",
      "jsonCode": "{\n\n}",
      "useJson": false,
      "getAll": false,
      "domain": "",
      "expirationDate": "",
      "path": "",
      "sameSite": "",
      "name": "",
      "url": "",
      "value": "",
      "httpOnly": false,
      "secure": false,
      "session": false,
      "assignVariable": false,
      "variableName": "",
      "saveData": true,
      "dataColumn": ""
    },
    "cloud": false
  },
  {
    "id": "block-package",
    "name": "Block package",
    "description": "Run blocks provided by an installed package",
    "icon": "riHtml5Line",
    "component": "Package",
    "editComponent": "EditPackage",
    "category": "package",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {},
    "cloud": true
  },
  {
    "id": "note",
    "name": "Note",
    "description": "Attach a free-form note to the workflow",
    "icon": "riFileEditLine",
    "component": "Note",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "disableEdit": true,
    "data": {
      "disableBlock": false,
      "note": "",
      "drawing": false,
      "width": 280,
      "height": 168,
      "color": "white",
      "fontSize": "regular"
    },
    "cloud": false
  },
  {
    "id": "workflow-state",
    "name": "Workflow State",
    "description": "Stop or otherwise change workflow execution",
    "icon": "riSettings3Line",
    "component": "Default",
    "editComponent": "EditWorkflowState",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "refDataKeys": [
      "errorMessage"
    ],
    "data": {
      "disableBlock": false,
      "description": "",
      "type": "stop-current",
      "exceptCurrent": false,
      "workflowsToStop": [],
      "throwError": false,
      "errorMessage": ""
    },
    "cloud": false
  },
  {
    "id": "parameter-prompt",
    "name": "Parameter prompt",
    "description": "Prompt for parameter values before proceeding",
    "icon": "riCommandLine",
    "component": "Default",
    "editComponent": "EditParameterPrompt",
    "category": "general",
    "inputs": 1,
    "outputs": 1,
    "allowedInputs": true,
    "maxConnection": 1,
    "data": {
      "disableBlock": false,
      "description": "",
      "timeout": 60000,
      "parameters": []
    },
    "cloud": false
  }
]
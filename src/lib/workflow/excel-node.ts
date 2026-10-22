/**
 * Node-level glue for the `parse-excel` operator, shared by the extension and
 * Runner executors: read the block's params, turn a Workflow file artifact into
 * parsed rows, and store both output variables.
 *
 * The parser itself stays in `excel-parse.ts` (bytes + filename only); this
 * module is where the operator's data-field names live.
 *
 * @module lib/workflow/excel-node
 */

import { decodeDataUrlBytes, type WorkflowFileArtifact } from './file-artifact'
import { parseSpreadsheet, type ParsedSpreadsheet } from './excel-parse'

export interface SpreadsheetOutputNames {
  variableName: string
  rawVariableName: string
}

function nameOrDefault(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  return name || fallback
}

/** The two output variables this node writes (defaults mirror the catalog). */
export function spreadsheetOutputNames(data: Record<string, unknown>): SpreadsheetOutputNames {
  return {
    variableName: nameOrDefault(data['variableName'], 'lastExcelRows'),
    rawVariableName: nameOrDefault(data['rawVariableName'], 'lastExcelRawRows'),
  }
}

/** Parse one file artifact with the node's sheet / header settings. */
export async function parseSpreadsheetFile(
  file: WorkflowFileArtifact,
  data: Record<string, unknown>,
): Promise<ParsedSpreadsheet> {
  return parseSpreadsheet(decodeDataUrlBytes(file.dataUrl), file.name, {
    sheetName: typeof data['sheetName'] === 'string' ? data['sheetName'].trim() : '',
    hasHeader: data['hasHeader'] !== false,
  })
}

/**
 * Write the object rows, the raw 2-D array, and the selected sheet name into
 * the run's variables. Returns the names actually used.
 */
export function storeSpreadsheetOutput(
  variables: Record<string, unknown>,
  data: Record<string, unknown>,
  parsed: ParsedSpreadsheet,
): SpreadsheetOutputNames {
  const names = spreadsheetOutputNames(data)
  variables[names.variableName] = parsed.rows
  variables[names.rawVariableName] = parsed.rawRows
  variables['lastExcelSheet'] = parsed.sheetName
  return names
}

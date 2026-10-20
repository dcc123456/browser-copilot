/**
 * One download path for JSON payloads.
 *
 * The side panel exports several kinds of records (workflows, workflow groups,
 * secrets, profiles); they all end up as a `.json` file, so the blob/anchor
 * handling lives here instead of being copied per tab.
 *
 * @module lib/download-json
 */
import { downloadBlob } from './export-answer'

/** Serialises `data` and saves it as `filename`. */
export async function downloadJSONFile(filename: string, data: unknown): Promise<boolean> {
  return downloadBlob(JSON.stringify(data, null, 2), 'application/json', filename)
}

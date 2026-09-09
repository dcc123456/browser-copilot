/**
 * SaveOutputs — thin re-export of the shared OutputVariableFields with batchB's
 * original label strings (the former local implementation moved to
 * `blocks/shared/OutputVariableFields`).
 *
 * @module workflow-editor/blocks/batchB/SaveOutputs
 */

import OutputVariableFields from '../shared/OutputVariableFields'
import type { Patch } from '../shared/Field'

export interface SaveOutputsProps {
  data: Record<string, unknown>
  onChange: Patch
}

export default function SaveOutputs(props: SaveOutputsProps) {
  return <OutputVariableFields {...props} />
}

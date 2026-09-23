/**
 * Generation pipeline stages view (spec §6 · Commit 07).
 *
 * Renders every pipeline stage with its status and summary, so the generation
 * card shows the work done at each phase rather than a single success line.
 * Styling uses semantic Tailwind tokens only; copy goes through i18n.
 *
 * @module sidepanel/GenerationStages
 */

import type { ReactNode } from 'react'
import {
  CheckCircle2,
  CircleDashed,
  MinusCircle,
  AlertTriangle,
} from 'lucide-react'
import type { useT } from './i18n'
import type {
  GenerationStageId,
  GenerationStageReport,
  GenerationStageStatus,
} from '../lib/workflow/generation-report'

type TFn = ReturnType<typeof useT>

const STAGE_LABEL_KEY: Record<GenerationStageId, keyof TFn> = {
  NORMALIZE: 'generationStageNormalize',
  GENERALIZE_INPUTS: 'generationStageGeneralizeInputs',
  HARDEN_TARGETS: 'generationStageHardenTargets',
  BUILD_RELIABILITY: 'generationStageBuildReliability',
  STATIC_VALIDATE: 'generationStageStaticValidate',
  INDEPENDENT_VERIFY: 'generationStageIndependentVerify',
}

function StatusGlyph({ status }: { status: GenerationStageStatus }): ReactNode {
  if (status === 'ok') return <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
  if (status === 'warn') return <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden />
  if (status === 'skipped') return <MinusCircle className="h-3.5 w-3.5 text-muted" aria-hidden />
  return <CircleDashed className="h-3.5 w-3.5 text-muted" aria-hidden />
}

interface Props {
  t: TFn
  stages: readonly GenerationStageReport[]
}

export function GenerationStagesView({ t, stages }: Props): ReactNode {
  if (stages.length === 0) return null
  return (
    <div className="ai-prefill-list" role="group" aria-label={t.generationStagesTitle}>
      <p className="hint">{t.generationStagesTitle}</p>
      <ul className="flex flex-col gap-1">
        {stages.map((stage) => {
          const label = t[STAGE_LABEL_KEY[stage.stage]] as string
          return (
            <li className="ai-prefill-item items-start" key={stage.stage}>
              <span className="mt-0.5 mr-1 inline-flex shrink-0">
                <StatusGlyph status={stage.status} />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-ink">{label}</span>
                <span className="text-muted break-words text-xs">{stage.summary}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

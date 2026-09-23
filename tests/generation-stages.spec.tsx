import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { GenerationStagesView } from '../src/sidepanel/GenerationStages'
import type { useT } from '../src/sidepanel/i18n'
import type {
  GenerationStageReport,
} from '../src/lib/workflow/generation-report'

type TFn = ReturnType<typeof useT>

/** Minimal t: localized labels for stage keys and the title; proxy for rest. */
function makeT(): TFn {
  const labels: Record<string, string> = {
    generationStagesTitle: 'Generation stages',
    generationStageNormalize: 'Normalize',
    generationStageGeneralizeInputs: 'Generalize inputs',
    generationStageHardenTargets: 'Harden targets',
    generationStageBuildReliability: 'Build reliability',
    generationStageStaticValidate: 'Static validate',
    generationStageIndependentVerify: 'Independent verify',
  }
  return new Proxy(labels, {
    get(target, prop: string) {
      return prop in target ? target[prop] : prop
    },
  }) as unknown as TFn
}

describe('GenerationStagesView', () => {
  it('renders every stage with its localized label and summary', () => {
    const stages: GenerationStageReport[] = [
      { stage: 'NORMALIZE', status: 'ok', summary: 'removed 2 redundant node(s)' },
      { stage: 'GENERALIZE_INPUTS', status: 'ok', summary: 'declared 1 runtime input(s)' },
      { stage: 'HARDEN_TARGETS', status: 'ok', summary: 'all element actions carry a locator' },
      { stage: 'BUILD_RELIABILITY', status: 'ok', summary: 'completed contract on 3 node(s)' },
      { stage: 'STATIC_VALIDATE', status: 'ok', summary: 'static validation passed' },
      { stage: 'INDEPENDENT_VERIFY', status: 'pending', summary: 'pending first run' },
    ]
    const html = renderToStaticMarkup(
      createElement(GenerationStagesView, { t: makeT(), stages }),
    )
    expect(html).toContain('Generation stages')
    expect(html).toContain('Normalize')
    expect(html).toContain('removed 2 redundant node(s)')
    expect(html).toContain('Independent verify')
    expect(html).toContain('pending first run')
  })

  it('renders nothing for an empty stage list', () => {
    const html = renderToStaticMarkup(
      createElement(GenerationStagesView, { t: makeT(), stages: [] }),
    )
    expect(html).toBe('')
  })

  it('shows warn and skipped summaries', () => {
    const stages: GenerationStageReport[] = [
      { stage: 'HARDEN_TARGETS', status: 'warn', summary: '1/3 actions lack a locator' },
      { stage: 'GENERALIZE_INPUTS', status: 'skipped', summary: 'no inputs' },
    ]
    const html = renderToStaticMarkup(
      createElement(GenerationStagesView, { t: makeT(), stages }),
    )
    expect(html).toContain('1/3 actions lack a locator')
    expect(html).toContain('no inputs')
  })
})

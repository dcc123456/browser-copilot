/**
 * Seed recall tests (specs/2026-10-14-workflow-seed-recall-design.md §4.1/§5).
 *
 * No browser, no model. These cover the acceptance rows E1–E4: eligibility
 * before scoring (a badge cannot be earned by keywords), the poison guard, the
 * two floors that keep a cross-site seed out, the offer's byte budget and its
 * deterministic truncation order, and the credential/literal scrub.
 *
 * The ranking table in `describe('ranking table (A3 falsification)')` is the
 * hand-read fixture the design demanded BEFORE wiring: six candidates, three
 * near-miss goals, ordering asserted by name so a future weight change that
 * flips it fails loudly here rather than in a generation turn.
 */
import { describe, expect, it } from 'vitest'
import {
  buildSeedOffer,
  rankWorkflowSeeds,
  SEED_MAX_CANDIDATES,
  SEED_MAX_AGE_DAYS,
  SEED_FLOOR_TEXT_ONLY,
  SEED_FLOOR_WITH_SITE,
  SEED_MAX_STEPS,
  SEED_OFFER_MAX_CHARS,
} from '../src/lib/workflow/seed-recall'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import type { TaskRunLog } from '../src/lib/scheduler-types'

const DAY = 86_400_000
const NOW = 1_760_000_000_000

let seq = 0
function nid(): string {
  return `s${++seq}`
}

function node(blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  const base: WorkflowNode = {
    id: nid(),
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  }
  if (blockId === 'trigger') return base
  base.data = withNodeGoalContract(base.data, {
    version: 1,
    goal: typeof data['description'] === 'string' ? data['description'] : `${blockId} step`,
    successCriteria: [{ kind: 'variableExists', name: 'ok' }],
  })
  return base
}

function workflow(overrides: {
  id?: string
  name?: string
  description?: string
  settings?: Record<string, unknown>
  nodes?: WorkflowNode[]
  updatedAt?: number
  trigger?: Workflow['trigger']
}): Workflow {
  return {
    id: overrides.id ?? nid(),
    name: overrides.name ?? 'Saved flow',
    ...(overrides.description ? { description: overrides.description } : {}),
    createdAt: (overrides.updatedAt ?? NOW) - DAY,
    updatedAt: overrides.updatedAt ?? NOW,
    drawflow: {
      nodes: overrides.nodes ?? [
        node('trigger', { type: 'manual' }),
        node('event-click', { selector: '[data-testid="save-draft"]', description: '保存草稿' }),
      ],
      edges: [],
    },
    ...(overrides.trigger ? { trigger: overrides.trigger } : {}),
    settings: {
      certificationStatus: 'certified',
      reliabilityMode: 'generated-strict',
      provenance: 'chat-generate',
      // The chat-generate record path always writes the site the workflow was
      // proven on, so an eligibility fixture without one would be testing the
      // text-only floor rather than eligibility. `generationOriginUrl` is one of
      // the two places recall is allowed to read a site from.
      generationOriginUrl: 'https://creator.xiaohongshu.com/publish/publish',
      goalSpec: {
        summary: '图文笔记已保存为草稿，草稿箱出现新条目',
        successConditions: [{ kind: 'elementExists', target: { text: '草稿箱' } }],
      },
      ...(overrides.settings ?? {}),
    } as Workflow['settings'],
  }
}

function run(workflowId: string, ok: boolean, at = NOW, skipped = false): TaskRunLog {
  return {
    id: nid(),
    trigger: 'manual',
    workflowId,
    at,
    ok,
    skipped,
    summary: ok ? 'passed' : 'failed',
    ...(ok ? {} : { failureCategory: 'LOCATOR' }),
  }
}

describe('eligibility (E1)', () => {
  it('offers a certified workflow with a goal and a recorded selector', () => {
    const candidate = workflow({})
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [],
      goalSummary: '把图文笔记保存成草稿',
      siteHints: ['https://creator.xiaohongshu.com/publish/publish'],
      now: NOW,
    })
    expect(seeds).toHaveLength(1)
    expect(seeds[0]!.workflowId).toBe(candidate.id)
    expect(seeds[0]!.siteMatch).toBe(true)
    expect(seeds[0]!.score).toBeGreaterThanOrEqual(SEED_FLOOR_WITH_SITE)
    expect(seeds[0]!.steps[0]!.selector).toBe('[data-testid="save-draft"]')
  })

  it('refuses an uncertified workflow however well its words match', () => {
    const candidate = workflow({
      name: '草稿流程',
      description: '图文笔记已保存为草稿，草稿箱出现新条目',
      settings: { certificationStatus: 'unverified' },
    })
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [],
      goalSummary: '图文笔记已保存为草稿，草稿箱出现新条目',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toEqual([])
  })

  it('refuses a certified workflow that declares no goal', () => {
    const candidate = workflow({ settings: { goalSpec: undefined } })
    expect(candidate.settings.certificationStatus).toBe('certified')
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toEqual([])
  })

  it('excludes a badge whose newest counted run failed', () => {
    const candidate = workflow({})
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [run(candidate.id, true, NOW - 10 * DAY), run(candidate.id, false, NOW - DAY)],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toEqual([])
  })

  it('treats a skipped newest run as no evidence, not as poison', () => {
    const candidate = workflow({})
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [run(candidate.id, true, NOW - 2 * DAY), run(candidate.id, false, NOW - DAY, true)],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toHaveLength(1)
  })

  it('keeps a freshly certified workflow with no run log at all (the bootstrap round)', () => {
    // The verify path stamps `settings.trialRun`, not necessarily a TaskRunLog.
    // Excluding `no-data` would mean round A can never seed round B.
    const candidate = workflow({})
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toHaveLength(1)
  })

  it('excludes an old certified workflow that has never passed a run', () => {
    const candidate = workflow({ updatedAt: NOW - (SEED_MAX_AGE_DAYS + 110) * DAY })
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toEqual([])
  })

  it('keeps an old workflow whose runs did pass', () => {
    const candidate = workflow({ updatedAt: NOW - (SEED_MAX_AGE_DAYS + 110) * DAY })
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [run(candidate.id, true, NOW - 5 * DAY)],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toHaveLength(1)
  })

  it('excludes a workflow whose only content is a bare node with no evidence', () => {
    const candidate = workflow({
      nodes: [node('trigger', { type: 'manual' }), node('set-variable', { name: 'x' })],
    })
    const seeds = rankWorkflowSeeds({
      workflows: [candidate],
      runs: [],
      goalSummary: '图文笔记已保存为草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toEqual([])
  })
})

describe('floors and cross-site safety (E2)', () => {
  const xhs = workflow({
    name: '小红书存草稿',
    settings: { generationOriginUrl: 'https://creator.xiaohongshu.com/publish/publish' },
  })
  const noSiteRecorded = workflow({
    name: '无站点记录',
    settings: { generationOriginUrl: undefined, pageContext: undefined },
  })

  it('refuses a same-shape task on a different site without a strong text match', () => {
    const seeds = rankWorkflowSeeds({
      workflows: [xhs],
      runs: [],
      goalSummary: '在 GitHub 仓库提交一个新的 issue 并确认成功提示出现',
      siteHints: ['https://github.com'],
      now: NOW,
    })
    expect(seeds).toEqual([])
  })

  it('excludes a workflow whose recorded site contradicts the hints, same words and all', () => {
    // Identical goal wording is exactly how a wrong-site seed would slip in, so
    // a recorded site the task is NOT about is evidence against, not merely
    // evidence-less — this row is the mechanism, per A3.
    const lookalike = workflow({
      name: '措辞极像站点不同',
      description: '图文笔记已保存为草稿，草稿箱出现新条目',
      settings: { generationOriginUrl: 'https://other.example.com' },
    })
    const seeds = rankWorkflowSeeds({
      workflows: [lookalike, xhs],
      runs: [],
      goalSummary: '把图文笔记保存成草稿，确认草稿箱出现新条目',
      siteHints: ['https://creator.xiaohongshu.com/publish/publish'],
      now: NOW,
    })
    expect(seeds.map((seed) => seed.workflowName)).toEqual(['小红书存草稿'])
  })

  it('refuses a site-less goal unless the text match is overwhelming', () => {
    // Without a site signal the only honest evidence is a goal that re-states
    // the saved workflow's own words; a shorter goal that shares a few bigrams
    // with it is a topic rhyme, not the same task.
    const weak = rankWorkflowSeeds({
      workflows: [noSiteRecorded],
      runs: [],
      goalSummary: '把图文笔记保存成草稿',
      now: NOW,
    })
    expect(weak).toEqual([])
    const verbose = rankWorkflowSeeds({
      workflows: [noSiteRecorded],
      runs: [],
      goalSummary:
        '图文笔记已保存为草稿，草稿箱出现新条目：填写标题与正文后点击保存草稿，' +
        '在小红书创作服务平台把这篇图文笔记保存为草稿，草稿箱出现新条目',
      now: NOW,
    })
    expect(verbose).toEqual([])
    const restated = rankWorkflowSeeds({
      workflows: [noSiteRecorded],
      runs: [],
      goalSummary: '图文笔记已保存为草稿，草稿箱出现新条目',
      now: NOW,
    })
    expect(restated).toHaveLength(1)
    expect(restated[0]!.siteMatch).toBe(false)
    expect(restated[0]!.score).toBeGreaterThanOrEqual(SEED_FLOOR_TEXT_ONLY)
  })

  it('caps the candidate list', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      workflow({
        name: `草稿流程 ${index}`,
        settings: { generationOriginUrl: 'https://creator.xiaohongshu.com' },
      }),
    )
    const seeds = rankWorkflowSeeds({
      workflows: many,
      runs: [],
      goalSummary: '把图文笔记保存成草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds.length).toBeLessThanOrEqual(SEED_MAX_CANDIDATES)
  })
})

describe('ranking table (A3 falsification)', () => {
  const corpus = [
    workflow({
      id: 'w-publish',
      name: '小红书图文存草稿',
      description: '在小红书创作服务平台生成图文笔记并保存草稿',
      settings: { generationOriginUrl: 'https://creator.xiaohongshu.com/publish/publish' },
      nodes: [
        node('trigger', { type: 'manual' }),
        node('javascript-code', { description: '画封面图' }),
        node('forms', {
          selector: 'input[placeholder="请输入标题"]',
          value: '{{title}}',
          description: '填写标题',
        }),
        node('event-click', { selector: '[data-testid="draf7-save"]', description: '保存草稿' }),
      ],
    }),
    workflow({
      id: 'w-read-list',
      name: '读评论区列表',
      description: '读取笔记评论区的文字列表并保存为本地文件',
      settings: { generationOriginUrl: 'https://www.xiaohongshu.com' },
      nodes: [
        node('trigger', { type: 'manual' }),
        node('get-text', { selector: '.comment-item', description: '读评论' }),
        node('save-local', { value: '{{comments}}', description: '存文件' }),
      ],
    }),
    workflow({
      id: 'w-gh-issue',
      name: 'GitHub 提 issue',
      description: '在 GitHub 仓库提交 issue 并确认成功提示',
      settings: { generationOriginUrl: 'https://github.com/new' },
      nodes: [
        node('trigger', { type: 'manual' }),
        node('forms', { selector: 'textarea#issue_body', value: '{{body}}' }),
        node('event-click', { selector: '[data-testid="submit-new-issue"]' }),
      ],
    }),
    workflow({
      id: 'w-feishu',
      name: '飞书文档发布',
      description: '把生成的正文粘贴进飞书文档并发布',
      settings: { generationOriginUrl: 'https://feishu.cn' },
      nodes: [
        node('trigger', { type: 'manual' }),
        node('forms', { selector: '.doc-editor', value: '{{content}}' }),
      ],
    }),
  ]

  const goals: { label: string; summary: string; hints: string[]; expect: string[] }[] = [
    {
      label: '同站点同任务',
      summary: '在小红书创作服务平台写一篇图文笔记，保存为草稿，绝不发布',
      hints: ['https://creator.xiaohongshu.com/publish/publish'],
      expect: ['w-publish'],
    },
    {
      label: '同站点不同任务',
      summary: '把这篇小红书笔记评论区的评论读出来存成本地文件',
      hints: ['https://www.xiaohongshu.com/explore'],
      expect: ['w-read-list'],
    },
    {
      label: '跨站近邻（都有填表+点击）',
      summary: '在 GitHub 新建 issue，填写正文并提交，确认 issue 出现',
      hints: ['https://github.com'],
      expect: ['w-gh-issue'],
    },
    {
      label: '无站点线索的模糊任务',
      summary: '帮我做个自动化',
      hints: [],
      expect: [],
    },
  ]

  for (const goal of goals) {
    it(`${goal.label} → ${goal.expect.length ? goal.expect.join(',') : 'no seed'}`, () => {
      const seeds = rankWorkflowSeeds({
        workflows: corpus,
        runs: [],
        goalSummary: goal.summary,
        siteHints: goal.hints,
        now: NOW,
      })
      // The hand-read contract: the table below is what the design's floor
      // choices were judged against.
      const table = seeds.map((seed) => ({
        id: seed.workflowId,
        score: seed.score,
        siteMatch: seed.siteMatch,
        why: seed.why,
      }))
      expect(table.map((row) => row.id)).toEqual(goal.expect)
      if (goal.expect.length > 0) expect(seeds[0]!.steps.length).toBeGreaterThan(0)
      // Vague, site-less asks must not seed anything.
      if (goal.hints.length === 0 && goal.expect.length === 0) {
        expect(seeds).toEqual([])
      }
    })
  }
})

describe('offer scrub and caps (E3/E4)', () => {
  function candidateWith(steps: Record<string, unknown>[]) {
    return rankWorkflowSeeds({
      workflows: [
        workflow({
          settings: { generationOriginUrl: 'https://creator.xiaohongshu.com' },
          nodes: [
            node('trigger', { type: 'manual' }),
            ...steps.map((data) => node(String(data['blockId']), data)),
          ],
        }),
      ],
      runs: [],
      goalSummary: '把图文笔记保存成草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
  }

  it('never offers a credential-typed form value', () => {
    const seeds = candidateWith([
      {
        blockId: 'forms',
        selector: '#password',
        forms: [
          { name: 'user', type: 'text', value: '{{login}}' },
          { name: 'pwd', type: 'password', value: 'hunter2-secret' },
        ],
      },
    ])
    const offer = buildSeedOffer(seeds)!
    const forms = offer[0]!.steps[0]!.params!['forms'] as Record<string, unknown>[]
    expect(forms).toHaveLength(2)
    expect(JSON.stringify(offer)).not.toContain('hunter2-secret')
    expect(forms[1]!['value']).toBeUndefined()
    expect(offer[0]!.steps[0]!.droppedCredentialFields).toContain('pwd')
  })

  it('passes a {{reference}} through verbatim whatever its length', () => {
    const long = `{{body}}${'x'.repeat(300)}`
    const seeds = candidateWith([{ blockId: 'forms', selector: '#ed', value: long }])
    const offer = buildSeedOffer(seeds)!
    expect(offer[0]!.steps[0]!.params!['value']).toBe(long)
  })

  it('drops a long literal that carries no reference', () => {
    const seeds = candidateWith([{ blockId: 'forms', selector: '#ed', value: 'y'.repeat(200) }])
    const offer = buildSeedOffer(seeds)!
    const step = offer[0]!.steps[0]!
    expect(step.params?.['value']).toBeUndefined()
    expect(JSON.stringify(offer)).not.toContain('yyyy')
  })

  it('strips bookkeeping keys out of the offered params', () => {
    const seeds = candidateWith([
      { blockId: 'event-click', selector: '#go', description: '点它', generated: true, next: 'x' },
    ])
    const offer = buildSeedOffer(seeds)!
    // Nothing survives the scrub, so the key is absent rather than an empty
    // object the model would have to interpret.
    expect(offer[0]!.steps[0]!.params).toBeUndefined()
    expect(offer[0]!.steps[0]!.selector).toBe('#go')
  })

  it('stays inside the byte budget and truncates steps before candidates', () => {
    const steps = Array.from({ length: 12 }, (_, index) => ({
      blockId: 'event-click',
      selector: `[data-testid="row-${index}"]`,
      value: `cell content ${index}`,
      description: `第 ${index} 行：点击这一行并确认状态变化写入变量`,
    }))
    const many = (name: string) =>
      workflow({
        name,
        settings: { generationOriginUrl: 'https://creator.xiaohongshu.com' },
        nodes: [
          node('trigger', { type: 'manual' }),
          ...steps.map((data) => node(String(data['blockId']), data)),
        ],
      })
    const seeds = rankWorkflowSeeds({
      workflows: [many('第一条'), many('第二条')],
      runs: [],
      goalSummary: '把图文笔记保存成草稿',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    })
    expect(seeds).toHaveLength(2)
    const offer = buildSeedOffer(seeds)!
    expect(JSON.stringify(offer).length).toBeLessThanOrEqual(SEED_OFFER_MAX_CHARS)
    // Both candidates survive: the order is steps first, candidates second.
    expect(offer).toHaveLength(2)
    expect(offer[0]!.steps.length).toBeLessThan(SEED_MAX_STEPS)
    expect(offer[0]!.steps.length).toBeGreaterThan(0)
  })

  it('drops a step larger than the whole budget instead of voiding the offer', () => {
    const bloatedStep = {
      workflowId: 'w',
      workflowName: 'w',
      score: 1,
      siteMatch: true,
      why: ['site:x'],
      steps: [
        { blockId: 'forms', selector: '#a' },
        {
          blockId: 'forms',
          selector: '#b',
          params: { rows: Array.from({ length: 400 }, (_, index) => `row ${index} payload`) },
        },
      ],
    }
    const offer = buildSeedOffer([bloatedStep])!
    expect(offer[0]!.steps.map((step) => step.selector)).toEqual(['#a'])
    expect(JSON.stringify(offer).length).toBeLessThanOrEqual(SEED_OFFER_MAX_CHARS)
  })

  it('returns no offer when nothing survives the budget', () => {
    const bloated = [
      {
        workflowId: 'w',
        workflowName: 'w',
        score: 1,
        siteMatch: true,
        why: ['site:x'],
        steps: [
          {
            blockId: 'forms',
            selector: '#a',
            params: { blob: 'q'.repeat(SEED_OFFER_MAX_CHARS) },
          },
        ],
      },
    ]
    expect(buildSeedOffer(bloated)).toBeUndefined()
  })

  it('is deterministic for equal scores (oldest updated first keeps a stable order)', () => {
    const a = workflow({
      id: 'a',
      name: 'A',
      updatedAt: NOW - 3 * DAY,
      settings: { generationOriginUrl: 'https://creator.xiaohongshu.com' },
    })
    const b = workflow({
      id: 'b',
      name: 'B',
      updatedAt: NOW - DAY,
      settings: { generationOriginUrl: 'https://creator.xiaohongshu.com' },
    })
    const first = rankWorkflowSeeds({
      workflows: [b, a],
      runs: [],
      goalSummary: '图文笔记已保存为草稿，草稿箱出现新条目',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    }).map((seed) => seed.workflowId)
    const second = rankWorkflowSeeds({
      workflows: [a, b],
      runs: [],
      goalSummary: '图文笔记已保存为草稿，草稿箱出现新条目',
      siteHints: ['https://creator.xiaohongshu.com'],
      now: NOW,
    }).map((seed) => seed.workflowId)
    expect(first).toEqual(second)
    expect(first[0]).toBe('a')
  })
})

describe('empty input (G3 degradation)', () => {
  it('returns nothing for a blank goal', () => {
    expect(
      rankWorkflowSeeds({ workflows: [workflow({})], runs: [], goalSummary: '   ', now: NOW }),
    ).toEqual([])
  })

  it('returns nothing when the store is empty', () => {
    expect(
      rankWorkflowSeeds({
        workflows: [],
        runs: [],
        goalSummary: '把图文笔记保存成草稿',
        now: NOW,
      }),
    ).toEqual([])
  })

  it('returns no offer from no candidates', () => {
    expect(buildSeedOffer([])).toBeUndefined()
  })
})

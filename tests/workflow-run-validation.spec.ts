import { describe, expect, it } from 'vitest'
import {
  formatRunIssue,
  nodeRunIssuesOf,
  validateWorkflowForRun,
} from '../src/lib/workflow/validation'
import { OFFERED_TRIGGER_TYPES, isOfferedTriggerType } from '../src/lib/workflow/trigger-options'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'test',
    createdAt: 1,
    updatedAt: 1,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: {
      nodes: [
        node('t', 'trigger', { type: 'manual' }),
        node('a', 'event-click', { selector: '#x' }),
      ],
      edges: [{ id: 'e1', source: 't', target: 'a', sourceHandle: 'trigger-output-1' }],
    },
    trigger: { type: 'manual', enabled: true },
    ...overrides,
  }
}

describe('validateWorkflowForRun', () => {
  it('accepts a healthy manual workflow', () => {
    const out = validateWorkflowForRun(workflow())
    expect(out.errors).toEqual([])
    expect(out.warnings).toEqual([])
  })

  it('blocks a workflow with no trigger node and no top-level trigger', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: undefined,
        drawflow: { nodes: [node('a', 'event-click', { selector: '#x' })], edges: [] },
      }),
    )
    expect(out.errors.some((e) => e.includes('缺少触发器'))).toBe(true)
  })

  it('accepts a trigger that lives only in the top-level mirror', () => {
    // Workflows from another creation path (older imports, integrations) may
    // carry no trigger NODE at all. Reading the node alone would report a
    // missing parameter and block a correctly configured run.
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'visit-web', urlPattern: 'https://x.test/*' },
        drawflow: { nodes: [node('a', 'event-click', { selector: '#x' })], edges: [] },
      }),
    )
    expect(out.errors).toEqual([])
  })

  it('reads the context-menu name off the mirror too', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'context-menu', menuItemId: 'Summarise page' },
        drawflow: { nodes: [node('a', 'event-click', { selector: '#x' })], edges: [] },
      }),
    )
    expect(out.errors).toEqual([])
  })

  it('reads the mirror for the two kinds whose runtime is mirror-driven', () => {
    // `visit-web` matches on `workflow.trigger.urlPattern` and the context menu
    // registers `workflow.trigger.menuItemId` — both read the TOP-LEVEL mirror,
    // not the node. A node that lost its `url` while the mirror still has one is
    // therefore a runnable workflow, and reporting a missing parameter would be
    // a false alarm.
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'visit-web', urlPattern: 'https://mirror.test/*' },
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'visit-web' }),
            node('a', 'event-click', { selector: '#x' }),
          ],
          edges: [],
        },
      }),
    )
    expect(out.errors).toEqual([])
  })

  it('still reports a missing parameter when neither source has it', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'visit-web' },
        drawflow: {
          nodes: [node('t', 'trigger', { type: 'visit-web' }), node('a', 'event-click')],
          edges: [],
        },
      }),
    )
    expect(out.errors.some((e) => e.includes('url'))).toBe(true)
  })

  it('blocks a disabled trigger', () => {
    const out = validateWorkflowForRun(workflow({ trigger: { type: 'manual', enabled: false } }))
    expect(out.errors.some((e) => e.includes('触发器已被禁用'))).toBe(true)
  })

  it('blocks a workflow whose graph has nothing but the trigger', () => {
    const out = validateWorkflowForRun(
      workflow({
        drawflow: { nodes: [node('t', 'trigger', { type: 'manual' })], edges: [] },
      }),
    )
    expect(out.errors.some((e) => e.includes('没有可执行的节点'))).toBe(true)
  })

  it('blocks a visit-web trigger with no URL pattern', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'visit-web', enabled: true },
        drawflow: {
          nodes: [node('t', 'trigger', { type: 'visit-web' }), node('a', 'event-click')],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors.some((e) => e.includes('"url"'))).toBe(true)
  })

  it('accepts a visit-web trigger once the URL is filled in', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'visit-web', enabled: true, urlPattern: 'https://example.com/*' },
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'visit-web', url: 'https://example.com/*' }),
            node('a', 'event-click', { selector: '#x' }),
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors).toEqual([])
  })

  it('blocks an interval trigger with a non-numeric interval', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'interval', enabled: true },
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'interval', interval: 'abc' }),
            node('a', 'event-click'),
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors.some((e) => e.includes('"interval"'))).toBe(true)
  })

  it('warns — but does not block — on a trigger kind this build never arms', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'scheduled', enabled: true },
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'scheduled' }),
            node('a', 'event-click', { selector: '#x' }),
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors).toEqual([])
    expect(out.warnings.some((w) => w.includes('scheduled'))).toBe(true)
  })

  it('blocks an element-change trigger with no observed selector', () => {
    // The selector is nested (`data.observeElement.selector`); without it the
    // injected observer has nothing to watch and the workflow never fires.
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'element-change', enabled: true },
        drawflow: {
          nodes: [node('t', 'trigger', { type: 'element-change' }), node('a', 'event-click')],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors.some((e) => e.includes('observeElement.selector'))).toBe(true)
  })

  it('accepts an element-change trigger once the selector is filled in', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: { type: 'element-change', enabled: true },
        drawflow: {
          nodes: [
            node('t', 'trigger', {
              type: 'element-change',
              observeElement: { selector: '#feed' },
            }),
            node('a', 'event-click', { selector: '#x' }),
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors).toEqual([])
    expect(out.warnings).toEqual([])
  })

  it('blocks edges pointing at nodes that do not exist', () => {
    const out = validateWorkflowForRun(
      workflow({
        drawflow: {
          nodes: [node('t', 'trigger'), node('a', 'event-click')],
          edges: [
            { id: 'e1', source: 't', target: 'a' },
            { id: 'e2', source: 'a', target: 'ghost' },
          ],
        },
      }),
    )
    expect(out.errors.some((e) => e.includes('"ghost"'))).toBe(true)
  })

  it('warns when a generated unanchored graph has no navigation before its first element action', () => {
    // The workflow was generated against https://gen.test/page and starts
    // clicking right away: a replay only works on THAT page.
    const out = validateWorkflowForRun(
      workflow({
        settings: {
          saveLog: false,
          debugMode: false,
          notification: false,
          reuseLastState: false,
          generationOriginUrl: 'https://gen.test/page',
        },
      }),
    )
    expect(out.errors).toEqual([])
    expect(out.warnings.some((w) => w.includes('gen.test'))).toBe(true)
  })

  it('does not warn when the graph opens its own page first', () => {
    const out = validateWorkflowForRun(
      workflow({
        settings: {
          saveLog: false,
          debugMode: false,
          notification: false,
          reuseLastState: false,
          generationOriginUrl: 'https://gen.test/page',
        },
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'manual' }),
            node('n', 'new-tab', { url: 'https://other.test' }),
            node('a', 'event-click', { selector: '#x' }),
          ],
          edges: [
            { id: 'e1', source: 't', target: 'n' },
            { id: 'e2', source: 'n', target: 'a' },
          ],
        },
      }),
    )
    // The dead-data warning on the literal URL is expected pre-existing
    // behavior; the ANCHOR warning must be absent.
    expect(out.warnings.every((w) => !w.includes('生成时的页面'))).toBe(true)
  })

  it('does not warn for workflows without a generation origin', () => {
    // Hand-built / imported graphs have no generationOriginUrl — the anchor
    // warning is scoped to generated workflows only.
    const out = validateWorkflowForRun(workflow())
    expect(out.warnings).toEqual([])
  })

  it('runs a graph whose scroll node has nothing to scroll, and says so', () => {
    // A `element-scroll` with neither a locator nor a delta is a NO-OP, not a
    // broken step. The gate used to refuse the entire run over it, which threw
    // away every node that did work — and a workflow generated before the
    // compile fix (`mode:'top'` → scrollY 0) stays runnable after it.
    const out = validateWorkflowForRun(
      workflow({
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'manual' }),
            node('s', 'element-scroll', { selector: '', scrollX: 0, scrollY: 0 }),
            node('a', 'event-click', { selector: '#x' }),
          ],
          edges: [
            { id: 'e1', source: 't', target: 's' },
            { id: 'e2', source: 's', target: 'a' },
          ],
        },
      }),
    )
    expect(out.errors).toEqual([])
    expect(out.warnings.some((w) => w.includes('缺少滚动目标'))).toBe(true)
  })

  it('still blocks a node whose step cannot work at all', () => {
    // The counterfactual for the warning above: severity is per finding, not a
    // blanket downgrade of the requirement table.
    const out = validateWorkflowForRun(
      workflow({
        drawflow: {
          nodes: [node('t', 'trigger', { type: 'manual' }), node('a', 'press-key')],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    )
    expect(out.errors.some((e) => e.includes('要按的键'))).toBe(true)
  })
})

describe('the run gate’s findings are structured, not just prose', () => {
  // The strings stay (the save card and the callers read them), but a caller
  // that wants to highlight the offending node must not parse a sentence back
  // into an id — `issues` carries the handles.
  const broken = workflow({
    drawflow: {
      nodes: [
        node('t', 'trigger', { type: 'manual' }),
        node('g', 'get-text', { description: '读取草稿标题', selector: '' }),
      ],
      edges: [{ id: 'e1', source: 't', target: 'g' }],
    },
  })

  it('blames the node, its block and the parameter at fault', () => {
    const issue = validateWorkflowForRun(broken).issues.find((i) => i.param === 'selector')
    expect(issue).toMatchObject({
      severity: 'error',
      nodeId: 'g',
      blockId: 'get-text',
      nodeName: 'Get text: 读取草稿标题',
    })
    expect(issue?.message).toContain('缺少必填参数 selector')
  })

  it('renders the same findings as the strings callers already read', () => {
    const out = validateWorkflowForRun(broken)
    expect(out.errors).toEqual(out.issues.filter((i) => i.severity === 'error').map(formatRunIssue))
    expect(out.warnings).toEqual(
      out.issues.filter((i) => i.severity === 'warning').map(formatRunIssue),
    )
  })

  it('leaves a workflow-level finding without a node to blame', () => {
    const out = validateWorkflowForRun(
      workflow({
        trigger: undefined,
        drawflow: { nodes: [node('a', 'event-click', { selector: '#x' })], edges: [] },
      }),
    )
    const missingTrigger = out.issues.find((i) => i.message.includes('缺少触发器'))
    expect(missingTrigger?.nodeId).toBeUndefined()
    expect(missingTrigger?.nodeName).toBe('')
    // No node prefix when there is no node to prefix.
    expect(formatRunIssue(out.issues[0]!)).toBe(out.issues[0]!.message)
  })

  it('gives the editor the very rule the gate used, per node', () => {
    // The canvas marks a node red as the user types, before any run. Same
    // helper, so the badge and the run log can never disagree.
    const perNode = nodeRunIssuesOf(node('g', 'get-text', { description: 'x', selector: '' }))
    const graphGate = validateWorkflowForRun(
      workflow({
        drawflow: {
          nodes: [
            node('t', 'trigger', { type: 'manual' }),
            node('g', 'get-text', { description: 'x', selector: '' }),
          ],
          edges: [],
        },
      }),
    )
    expect(perNode.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual(
      graphGate.issues
        .filter((i) => i.severity === 'error' && i.nodeId === 'g')
        .map((i) => i.message),
    )
  })
})

describe('OFFERED_TRIGGER_TYPES', () => {
  it('covers every kind the background actually arms', () => {
    for (const kind of [
      'manual',
      'on-startup',
      'keyboard-shortcut',
      'context-menu',
      'visit-web',
      'interval',
      'specific-day',
      'date',
      'element-change',
    ]) {
      expect(isOfferedTriggerType(kind)).toBe(true)
    }
  })

  it('excludes the kinds with no working listener', () => {
    // `scheduled` (cron) is documented as not auto-armed; the integration kinds
    // are created by their own paths and must not be pickable here.
    expect(isOfferedTriggerType('scheduled')).toBe(false)
    expect(OFFERED_TRIGGER_TYPES).not.toContain('github')
    expect(OFFERED_TRIGGER_TYPES).not.toContain('feishu')
  })
})

/**
 * The pre-save trial replay: what it may run, and how to describe what it saw.
 *
 * A generated workflow has been proved STEP BY STEP, paced by a model that
 * looked at the page between steps. Nothing proves the graph runs back to back
 * on a replay — and the user is the one who normally discovers that, on their
 * first run. The trial is that discovery, moved to before the save: run the
 * graph for real, once, and write down what happened.
 *
 * The two rules that make this safe to run automatically:
 *
 *   1. **Nothing that cannot be undone is executed.** The trial stops in front
 *      of the first step `idempotencyOf` classifies as unsafe — a submit, a
 *      send, a login. Whatever the trial proves, it never proves it by placing
 *      a second order.
 *   2. **The workflow is saved no matter what the trial says.** A trial is
 *      evidence and a self-heal trigger, never a gate. `compat` mode, a missing
 *      page, a thrown run: all of it lands as a record on `settings.trialRun`
 *      and the save proceeds. A feature that lowered the number of workflows
 *      that get saved would have made the problem worse, not better.
 *
 * Pure module: the path walk and the record reduction are testable without a
 * browser, and the runner that touches the engine lives in
 * `background/workflow-engine/repair/generation-trial.ts`.
 *
 * @module lib/workflow/trial-run
 */

import {
  hasUnsafeIntent,
  idempotencyOf,
  intentOf,
  NEGATED_COMMIT_VERB,
  nodeReliabilityOf,
  PAGE_NAME_ESCAPE,
} from './reliability'
import type { Workflow, WorkflowNode } from './types'
import { DEFAULT_GOAL_TEMPLATES } from './node-goal-instantiation'

/** How long a trial may take before it is stopped and recorded as such. */
export const TRIAL_BUDGET_MS = 45_000

export type TrialOutcome =
  /** Every step in the reachable graph ran clean. */
  | 'passed'
  /** The safe prefix ran clean and the trial stopped at its cutoff. */
  | 'partial'
  /** A step failed. The record says which one and with what code. */
  | 'failed'
  /** Stopped by the caller (user cancelled the generation, worker died). */
  | 'cancelled'
  /** The budget ran out. A slow page, not a broken graph. */
  | 'timeout'
  /** The trial did not run, with the reason in `reason`. */
  | 'skipped'

export interface TrialRunRecord {
  outcome: TrialOutcome
  /** When the trial finished, for the health card's "last verified" line. */
  at: number
  durationMs?: number
  runId?: string
  /** True when there was no cutoff — the whole reachable graph was safe to run. */
  full: boolean
  /** Steps proved by the trial, and steps the graph can reach. */
  coveredSteps: number
  totalSteps: number
  /** The step the trial refused to execute because replaying it is not undoable. */
  cutoffNodeId?: string
  /** True only when the run really fired the graph's draft-save commit: a draft exists. */
  draftSaved?: boolean
  failedNodeId?: string
  /** Machine-readable failure prefix (`READINESS_TIMEOUT`, `LOCATOR_NOT_FOUND`, …). */
  failureCode?: string
  /** Steps whose locator had to degrade — the self-heal wrote these back. */
  degradedSteps?: number
  reason?: string
}

/** Raw facts the runner observed from one trial execution. */
export interface TrialRunInput {
  outcome: 'ok' | 'failed' | 'cancelled'
  /** Engine reported it stopped at the cutoff instead of reaching the end. */
  stoppedBefore?: string
  failedNodeId?: string
  error?: string
  completedSteps: number
  degradedSteps?: number
  /** The caller's budget aborted the run. */
  timedOut?: boolean
  cancelledByCaller?: boolean
  durationMs?: number
  runId?: string
  at?: number
}

/** The block id of a node: `data.blockId`, falling back to the label. */
function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

/** Trigger-ish blocks that start a run rather than doing work. */
const TRIGGER_BLOCK_IDS = new Set([
  'trigger',
  'manual',
  'schedule',
  'scheduled',
  'visit-web',
  'context-menu',
  'on-startup',
  'keyboard-shortcut',
  'date',
  'specific-day',
  'element-change',
])

/**
 * The chain a run actually walks, in execution order: start at the trigger (or
 * the first node) and follow the FIRST outgoing edge at every step, which is
 * exactly how the engine picks `defaultNext`.
 *
 * A generated graph is a single chain, so this answers the question the trial
 * needs ("what would run, in what order") without a general reachability
 * solver. Branches are simply not part of the prefix the trial proves, and the
 * `visited` guard keeps a hand-wired loop from walking forever.
 */
export function executionPath(workflow: Workflow): WorkflowNode[] {
  const nodes = workflow.drawflow.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const firstOut = new Map<string, string>()
  for (const edge of workflow.drawflow.edges) {
    if (!firstOut.has(edge.source)) firstOut.set(edge.source, edge.target)
  }
  let current: string | null =
    nodes.find((node) => TRIGGER_BLOCK_IDS.has(blockIdOf(node)))?.id ?? nodes[0]?.id ?? null
  const path: WorkflowNode[] = []
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    const node = byId.get(current)
    if (!node) break
    if (!TRIGGER_BLOCK_IDS.has(blockIdOf(node))) path.push(node)
    current = firstOut.get(current) ?? null
  }
  return path
}

/**
 * The node that starts a run instead of doing work.
 *
 * The engine lists it among the nodes that executed, the trial does not count it
 * as a step (see {@link executionPath}) — so a clean full run of a 12-step graph
 * would otherwise report 13/12.
 */
export function isTriggerNode(node: WorkflowNode): boolean {
  return TRIGGER_BLOCK_IDS.has(blockIdOf(node))
}

/**
 * The first step on the execution path that must not be re-fired.
 *
 * Reads come first and are exactly what the trial is for; the cutoff is where
 * "prove it again" turns into "do it again". A graph with no such step returns
 * undefined, and the trial runs the whole thing.
 */
export function trialCutoffNodeId(workflow: Workflow): string | undefined {
  return executionPath(workflow).find((node) => isUnsafeNode(node))?.id
}

/** Does this node's step repeat something the site already committed? */
export function isUnsafeNode(node: WorkflowNode): boolean {
  return idempotencyOf(blockIdOf(node), node.data ?? {}, nodeReliabilityOf(node)) === 'unsafe'
}

/**
 * The blocks that ACTUATE something, as opposed to merely touching the page.
 *
 * `unsafe` is a keyword test over prose the model wrote, and it over-classifies:
 * an upload step whose intent reads "上传到图文发布的图片上传入口" is unsafe because
 * the NAME of the page contains 发布, and a body-text step is unsafe because its
 * intent says "不点击任何发布按钮". Neither commits anything — one adds a file to a
 * form, the other types into a box. What a replay genuinely must not re-fire is
 * the press of the control: a click, a submit, a key that sends, a script told to
 * post, a webhook.
 */
const COMMIT_BLOCK_IDS: ReadonlySet<string> = new Set([
  'click',
  'event-click',
  'press-key',
  'trigger-event',
  'handle-dialog',
  'javascript-code',
  'webhook',
  'feishu-message',
])

/**
 * A body that asks a server to change something: a mutating HTTP verb, a beacon,
 * a socket, an XHR. Reads do not count — see {@link JS_REMOTE_EVIDENCE}.
 */
const JS_REMOTE_SOURCE =
  String.raw`\bfetch\s*\([^)]{0,240}?\bmethod\s*:\s*['"\x60]?\s*(?:post|put|patch|delete|options)\b` +
  String.raw`|\.open\s*\(\s*['"\x60]?\s*(?:post|put|patch|delete|options)\b` +
  String.raw`|\bsendBeacon\s*\(|\bnew\s+WebSocket\b|\bnew\s+XMLHttpRequest\b`

/**
 * What makes a script a commit — read off the script's OWN body.
 *
 * A JS node is judged by its prose everywhere else, and prose is the weaker
 * source here: the step that draws three poster canvases was classified as an
 * unreversible commit because its capability-gap justification says 「没有任何算子能
 * 新建一张画布」 (an unrelated 新建), and the step that types into the Quill editor
 * says 存草稿 in its explanation. Neither line of code presses anything. The body is
 * the thing that will actually run, so the body decides.
 *
 * Every term is a control press, a form submission, a navigation away, or a write
 * that leaves the page — the four ways a replay can do something a user cannot
 * take back. An event dispatch that is NOT one of those (a Quill work-around
 * fires `new InputEvent('input')` to make the editor re-read its own state) is
 * typing, which the `forms` fill this policy already allows.
 */
const JS_COMMIT_EVIDENCE = new RegExp(
  String.raw`\.(?:click|submit|requestSubmit)\s*\(\s*\)` +
    String.raw`|new\s+(?:Mouse|Pointer|Keyboard|Touch|HTMLEvents|UI)Event` +
    String.raw`|window\.open\s*\(|(?:location|window\.location)\s*=|location\.(?:assign|replace)\s*\(` +
    String.raw`|EventSource|` +
    JS_REMOTE_SOURCE,
  'i',
)

/**
 * What proves a script stays inside the page: it draws an artifact no declarative
 * operator produces, or it writes text into a field.
 *
 * The exemption needs POSITIVE evidence, not just the absence of a `.click()` — a
 * body that shows neither may be doing something no keyword list predicts (a
 * `localStorage` cart write, a call into the site's own publish handler), and the
 * cautious reading of an unparseable script is the one the whole policy uses:
 * refuse. `javascript-code` is unsafe by default; only a body that says otherwise
 * gets run.
 */
const JS_IN_PAGE_EVIDENCE =
  /getContext\s*\(\s*['"`]2d|toDataURL|\.toBlob\s*\(|convertToBlob|\bdrawImage\b|createImageBitmap|\bImageBitmap\b|OffscreenCanvas|html2canvas|dom-to-image|image\/(?:png|jpe?g|webp|gif|bmp)|\.innerHTML\s*=|\.innerText\s*=|\.textContent\s*=|\.value\s*=\s*|insertText\s*\(|setText\s*\(|\.setContents\s*\(|execCommand\s*\(|dispatchEvent\s*\(\s*new\s+InputEvent/

/**
 * Does this script do nothing but draw an artifact or edit the page it runs on?
 *
 * Then it presses nothing and sends nothing out, which is the same class of
 * side effect as the `forms` fill this policy lets through: a replay repeating it
 * leaves the page exactly where it was.
 */
function isInPageScript(code: unknown): boolean {
  if (typeof code === 'string' && code !== '' && !JS_COMMIT_EVIDENCE.test(code)) {
    return JS_IN_PAGE_EVIDENCE.test(code)
  }
  return false
}

/**
 * Pressing something inside the already-open page: a tab, a button, a key. The
 * page cannot leave this script, and no server call comes out of it, so whether
 * it commits is a question about WHAT it presses — i.e. about the words the step
 * carries, exactly like every other block in this policy.
 */
const JS_LOCAL_ACT_EVIDENCE =
  /\.(?:click|submit|requestSubmit)\s*\(\s*\)|new\s+(?:Mouse|Pointer|Keyboard|Touch|HTMLEvents|UI)Event/

/**
 * Evidence a script writes to something OUTSIDE the page. No prose reading
 * redeems this, and it is the one body reading that outranks the keyword gate: a
 * test over sentences cannot see a POST.
 *
 * `fetch` by itself is not one of these. The step that draws the three poster
 * images converts its own `data:image/png` URLs into Files with
 * `const res = await fetch(dataUrl)`, which touches nothing outside the browser;
 * refusing it puts the cutoff in front of the images the goal asked for — the
 * mistake round 19 made by reading the verb `fetch` instead of the request.
 */
const JS_REMOTE_EVIDENCE = new RegExp(JS_REMOTE_SOURCE, 'i')

/**
 * A body that only LOOKS at the page: it measures elements and hands the answer
 * back. `get-text` and `attributes` are reads this policy has always run, and a
 * step that asks the DOM the same question in JavaScript is the same kind of step
 * — round 20 stopped at 11/26 on one that only reported each candidate tab's tag,
 * class, size and position, because its DESCRIPTION mentioned 点击 and 发布页.
 *
 * The exemption needs evidence on BOTH sides: the body must show an inspection,
 * and it must show nothing that could write. Without the second half a script
 * could read like a query and end in `site.publish()` — and the one thing a
 * replay must never do is an act the user cannot take back.
 */
const JS_READ_EVIDENCE =
  /querySelector|getElementsBy|getBoundingClientRect|getComputedStyle|\.getClientRects\s*\(|getAttribute\s*\(|\.textContent|\.innerText|\.value|\.href|\.accept|\.files\b|JSON\.stringify|\.slice\s*\(|\.match\s*\(/

/** Assigning to an element, a store, or the DOM — a script that changes state. */
const JS_PAGE_WRITE_EVIDENCE =
  /\.innerHTML\s*=|\.outerHTML\s*=|\.textContent\s*=[^=]|\.innerText\s*=[^=]|\.value\s*=[^=]|\.checked\s*=[^=]|\.files\s*=|\.src\s*=[^=]|\.href\s*=[^=]|(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)|document\.cookie\s*=|indexedDB|\.setAttribute\s*\(|\.removeAttribute\s*\(|\.classList\s*\.\s*(?:add|remove|toggle)|\.append(?:Child)?\s*\(|\.prepend\s*\(|\.remove\s*\(|\.insertBefore\s*\(|\.replaceChildren\s*\(|\.insertAdjacent\w*\s*\(|\.scrollTo\s*\(|\.reload\s*\(/

/** A call whose NAME is an outward act — a site's own handler, not a query. */
const JS_OUTWARD_CALL_EVIDENCE =
  /\.\s*(?:publish|submit|send|commit|confirm|checkout|post)\s*\(|\b(?:publishNote|placeOrder|sendBeacon)\s*\(/

/**
 * Does this body do something a replay cannot take back, whatever its prose says?
 *
 * Two signals outrank the keyword gate precisely because the gate reads sentences
 * and cannot see them: a request that asks a server to change state, and a call
 * into the site's own outward handler. A page-state write is NOT one of them —
 * `localStorage`, an element's `innerHTML`, a canvas — those are the same class of
 * side effect as the `forms` fill this policy lets through: idempotent, confined to
 * the page, and repeatable by definition.
 */
function isOutwardScript(node: WorkflowNode): boolean {
  const code = node.data?.['code']
  if (typeof code !== 'string' || code === '') return false
  return JS_REMOTE_EVIDENCE.test(code) || JS_OUTWARD_CALL_EVIDENCE.test(code)
}

/**
 * Is this the step that commits, for a script node?
 *
 * Four readings, in order: a body that writes to a server commits; a body that
 * only draws or edits is in-page; a body that only presses something in the page
 * is judged by its own words, because a script that `querySelector`s a tab and
 * `.click()`s it is the same preparation an `event-click` node does — and the
 * round-18 draft graph stopped on precisely that one, whose description named the
 * 发布页 it was standing in; and a body that only inspects the page is a read.
 * What it cannot do is earn a pass by silence: a script none of the four describes
 * is refused, the same cautious reading `javascript-code` gets everywhere else.
 */
function isScriptCommit(node: WorkflowNode): boolean {
  const code = node.data?.['code']
  if (typeof code !== 'string' || code === '') return true
  if (JS_REMOTE_EVIDENCE.test(code)) return true
  if (isInPageScript(code)) return false
  if (!JS_LOCAL_ACT_EVIDENCE.test(code)) {
    return !(
      JS_READ_EVIDENCE.test(code) &&
      !JS_PAGE_WRITE_EVIDENCE.test(code) &&
      !JS_OUTWARD_CALL_EVIDENCE.test(code)
    )
  }
  const prose = intentOf(node) || node.label || ''
  if (prose.trim() === '') return true
  // A script is the one block whose prose can grant it a pass: its body already
  // had to prove it only draws or edits, so the prohibition it names («绝不发布»)
  // is read as the decline it is here, and stays a refusal in the default policy.
  return hasUnsafeIntent(prose.replace(NEGATED_COMMIT_VERB, ' '))
}

/**
 * Is this the step that commits — the one a second run cannot take back?
 *
 * The LABEL is scanned whenever the step has no contract prose to read. A `click`
 * node generated without a `__reliability` field has an empty intent, and its
 * entire meaning is the words 「点击「发布」」 on its label; reading only the contract
 * would let the publish through — the one failure mode this policy exists to
 * prevent. A step that DOES declare an intent has already had that sentence
 * classified by the keyword test, so its label — a terse paraphrase that can name
 * the page it happens on («图文发布页保存草稿») — is not second-guessed.
 */
export function isCommitNode(node: WorkflowNode): boolean {
  const blockId = blockIdOf(node)
  // Two body signals are invisible to a test over sentences, so they outrank it.
  if (blockId === 'javascript-code' && isOutwardScript(node)) return true
  const readsLikeACommit = !intentOf(node) && hasUnsafeIntent(node.label ?? '')
  if (!isUnsafeNode(node) && !readsLikeACommit) return false
  // A `forms` block commits only when it SUBMITS; filling a field does not.
  if (blockId === 'forms')
    return String(node.data?.['action'] ?? 'fill') === 'submit' || readsLikeACommit
  // A script commits unless its own body proves it only draws, edits or reads.
  if (blockId === 'javascript-code') return isScriptCommit(node)
  return COMMIT_BLOCK_IDS.has(blockId)
}

/**
 * The cutoff for a caller that has ACCEPTED the side effects of the steps leading
 * up to a commit — a draft, a cart, a form filled and left unsent.
 *
 * {@link trialCutoffNodeId} refuses every unsafe step, which is right for a run
 * nobody asked for and wrong for proving a workflow whose whole job is to write
 * something. This keeps the one refusal that matters: the run goes all the way to
 * the press of the commit control and stops there. A publish is always recorded as
 * a click or a submit with a publish intent, so it stays unreachable; a graph with
 * no commit step at all runs to its end, which is the only way a replay can ever
 * read `full` and certify the workflow.
 */
export function commitCutoffNodeId(workflow: Workflow): string | undefined {
  return executionPath(workflow).find((node) => isCommitNode(node))?.id
}

/** The words that name a draft: the work is kept, not sent. */
const DRAFT_COMMIT_PATTERN = /(草稿|暂存|存稿|draft)/i

/**
 * The verbs that take the work OUT of the composer.
 *
 * Narrower on purpose than the reliability keyword test: that one asks "could
 * this step be unreversible?", and 删除 / 创建 / 登录 qualify. This one asks "is this
 * the press the user kept for themselves?", and deleting a duplicate cover image
 * on the way to a draft is not.
 */
const OUTWARD_COMMIT_PATTERN =
  /(发布|发表|提交|发送|下单|支付|付款|购买|publish|\bpost\b|submit|send|checkout|purchase|place[\s-]?order)/i

/**
 * The verbs that KEEP the work: a draft is written, not merely mentioned.
 *
 * Naming a draft is not the same as saving one — 「在草稿列表里点击删除多余的封面图」
 * is a step that destroys something on the way to a draft, and a policy that only
 * looked for the word 草稿 would both refuse to run it and then credit the run with
 * having saved a draft.
 */
const DRAFT_KEEP_PATTERN = /(保存|存为|另存|暂存|存稿|存草稿|留稿|save|draft)/i

/**
 * Is this commit the step the goal ASKED for — writing a draft — rather than the
 * step it forbids — sending the work out?
 *
 * The prohibition is stripped before the verbs are compared: the ONE sentence that
 * documents a draft save also names the publish it declines, and a keyword scan
 * cannot tell 「点击发布，保存草稿」 from 「保存为草稿，不发布」. What is left after the
 * forbidden verbs go must positively name a draft, name a KEEPING act, and name
 * nothing outward — a step whose prose is too tangled to prove it stays inside the
 * composer is not executed, which is the direction this policy always errs in.
 */
/**
 * The words the pressed element itself carries.
 *
 * A recorded click says what it pressed in the locator, not in a sentence: round
 * 43's terminal step is `event-click | Click the target element` whose `data.label`
 * is 「点击暂存离开按钮保存草稿」 and whose target text is 「暂存离开」. A policy that
 * reads only the intent prose calls that step prose-less — so it cannot see the
 * draft save the graph really ends on, and (worse) cannot see a 「发布」 button if
 * that is what was pressed.
 */
export function elementWordsOf(node: WorkflowNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>
  const parts: string[] = []
  if (typeof data['label'] === 'string') parts.push(data['label'] as string)
  const target = data['target'] as
    | {
        label?: unknown
        primary?: { how?: unknown; value?: unknown }
        fallbacks?: { how?: unknown; value?: unknown }[]
      }
    | undefined
  if (target) {
    for (const spec of [target.primary, ...(target.fallbacks ?? [])]) {
      if (!spec || typeof spec.value !== 'string') continue
      // Only the specs that name a HUMAN string: a css/id/testid value is a
      // locator, not a label, and would let a random `id="draft-2026"` speak.
      if (spec.how !== 'text' && spec.how !== 'role') continue
      parts.push(spec.value)
    }
    if (typeof target.label === 'string') parts.push(target.label)
  }
  const locator = (data['__reliability'] as { locator?: Record<string, unknown> } | undefined)
    ?.locator
  if (locator) {
    for (const key of ['accessibleName', 'label', 'text']) {
      const value = locator[key]
      if (typeof value === 'string') parts.push(value)
    }
  }
  return parts
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(' ')
}

/**
 * The prose a commit policy reads for this step.
 *
 * A declared intent wins: it is a sentence someone wrote about the step. Without
 * one, the node label and the element's own words are ONE statement — the button
 * text is what distinguishes 「点击暂存离开」 from 「点击发布」 when nothing else was
 * recorded, and a policy that ignores it is blind in the direction that matters.
 */
function commitProseOf(node: WorkflowNode): string {
  const declared = intentOf(node)
  if (declared && !isGenericStepProse(declared)) return declared
  // A boilerplate step's sentence is the block template, not a declaration — and
  // round 64 showed it can carry the step's PAYLOAD inside it («Press the <the whole
  // AI note body> key»), which a keyword scan reads as the step's own intent. So
  // only the words the page really shows count here, exactly as the docblock says.
  return [node.label ?? '', elementWordsOf(node)].filter(Boolean).join(' ')
}

/**
 * Is this "intent" only the block's own boilerplate?
 *
 * `{{url}}`-style templates are instantiated into the step's goal contract, so the
 * comparison takes the stem: a recorded click whose intent is «Click the target
 * element (div > div…)» names no button at all, and round 45 read its own 暂存离开
 * click as a missing draft save because the template was taken for a declaration —
 * the re-ask then spent a whole turn looking for a step that was already there.
 */
function isGenericStepProse(text: string): boolean {
  const value = text.trim()
  if (!value) return true
  return Object.values(DEFAULT_GOAL_TEMPLATES).some((template) => {
    const stem = template.replace(/\s*\{\{[^}]*\}\}\s*$/, '').trim()
    if (value === template || value === stem || value.startsWith(`${stem} `)) return true
    // Round 64 stopped a replay at a `press-key` step whose description is
    // «Press the {{keys}} key» — a placeholder in the MIDDLE, instantiated with the
    // whole AI note body as the key. The outward-verb scan then read a sentence
    // INSIDE that content («批量下单») as the step's intent and refused the run.
    // A value that fits the template around its placeholders is still the template
    // speaking, not a declaration: what the block does is the frame, and the
    // argument it carries is data.
    return templateMatchesValue(template, value)
  })
}

/** Does `value` fill this `{{placeholder}}` template without changing its frame? */
function templateMatchesValue(template: string, value: string): boolean {
  if (!/\{\{[^}]*\}\}/.test(template)) return false
  const pattern = template
    .split(/\{\{[^}]*\}\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]+?')
  return new RegExp(`^${pattern}$`).test(value)
}

export function isDraftSaveNode(node: WorkflowNode): boolean {
  const prose = commitProseOf(node)
    .replace(NEGATED_COMMIT_VERB, ' ')
    .replace(PAGE_NAME_ESCAPE, '页')
  if (!DRAFT_COMMIT_PATTERN.test(prose)) return false
  if (!DRAFT_KEEP_PATTERN.test(prose)) return false
  return !OUTWARD_COMMIT_PATTERN.test(prose)
}

/**
 * The refusal the draft opt-in keeps.
 *
 * `allowDraftCommit` is a caller saying the side effects up to and including a
 * DRAFT SAVE are the point of this run. The broad reliability keyword test cannot
 * answer that once a generated step is legible: 「点击「新建图文笔记」」 and 「删除重复的
 * 封面图」 name 新建 / 删除 — genuinely not idempotent, and correctly upgraded by the
 * contract for that reason — yet neither is a press the user kept for themselves,
 * and a graph that stopped on them would prove one step out of twenty-six. What
 * this policy refuses is the act that takes the work OUT: an outward block, a
 * submitting form, a script whose own body reaches a server, a step the contract
 * explicitly declares unsafe, and a step whose words name a publish, a send, an
 * order or a payment.
 */
function isOutwardCommitNode(node: WorkflowNode): boolean {
  const blockId = blockIdOf(node)
  // A script is judged by its body: it is the one block that can prove it only
  // draws, and `isCommitNode` already encodes that ladder.
  if (blockId === 'javascript-code') return isCommitNode(node)
  if (blockId === 'webhook' || blockId === 'feishu-message') return true
  if (blockId === 'forms') return String(node.data?.['action'] ?? 'fill') === 'submit'
  if (!isActuationNode(node)) return false
  const declared = node.data?.['__reliability'] as { idempotency?: unknown } | undefined
  if (declared?.idempotency === 'unsafe') return true
  const prose = commitProseOf(node)
  return OUTWARD_COMMIT_PATTERN.test(
    prose.replace(NEGATED_COMMIT_VERB, ' ').replace(PAGE_NAME_ESCAPE, '页'),
  )
}

/**
 * The cutoff for a caller that granted this workflow its OWN commit — and only a
 * draft-shaped one.
 *
 * `--run-to-draft` / `commitCutoffOnly` proves every step UP TO the press of the
 * commit control; a graph whose last step is 「保存为草稿」 therefore ends `partial`
 * and can never certify the goal, because the one effect the goal asked for never
 * happened. This lets exactly that step run: a commit whose own words name a draft
 * and no outward verb. Every other refusal stands — a publish, a submit, a send, a
 * payment, a webhook, and any commit too vaguely written to prove it stays inside
 * the composer. A run under this flag can write a draft into the user's account, so
 * it is opt-in at every layer between the caller and the engine.
 */
export function draftCommitCutoffNodeId(workflow: Workflow): string | undefined {
  return executionPath(workflow).find((node) => isOutwardCommitNode(node))?.id
}

/**
 * Does the GOAL ask for a draft?
 *
 * Generation can end its graph on a diagnostic probe instead of the step the user
 * named, and then every later number describes a run that wrote nothing: 26/26
 * steps clean, `verified: true`, and no draft in the account. Asked in a narrow
 * voice — a writing verb within one clause of a draft word — so the question «is
 * the terminal action in this graph?» is only posed to a goal that demanded one
 * (「读取草稿箱数量» is not), with the same prohibition-stripping
 * {@link isDraftSaveNode} uses: the sentence that asks for a draft usually names
 * the publish it declines.
 */
const DRAFT_SAVE_ASK =
  /(?:保存|存为|另存|暂存|存稿|生成|新建|创建|撰写|写|save|create)[^。.!！?？;；\n]{0,16}(?:草稿|draft|存稿)|(?:草稿|draft|存稿)[^。.!！?？;；\n]{0,16}(?:保存|save)/i

export function goalAsksForDraftSave(text: string | undefined): boolean {
  if (!text) return false
  const prose = text.replace(NEGATED_COMMIT_VERB, ' ')
  if (!DRAFT_SAVE_ASK.test(prose)) return false
  return !OUTWARD_COMMIT_PATTERN.test(prose)
}

/**
 * The draft-save step the goal demanded, still missing from what has been
 * recorded SO FAR — as one line the recording tool hands back to the model.
 *
 * `terminalStepMissing` in the bridge summary tells the CALLER that a graph
 * cannot finish its task, but by then the session has already ended its turn
 * (workflow mode says 「END YOUR TURN, do not call compose_workflow」), so the one
 * reader who could still add the click never hears it. Rounds 27 and 37 are the
 * same shape: 21 recorded steps ending on 「点击正文编辑区」, and a replay that can
 * only ever be clean-and-empty. This is the same fact, said while the model can
 * still act on it, and it stops firing the moment the step is recorded — a state
 * read, not a rule repeated.
 *
 * The goal is read the way compose reads it: `draft.goalText` is set only when the
 * model passed it on the trigger call, and the trigger head's own `goalText` is
 * what compose falls back to — round 38 proved the difference is not academic, the
 * notice stayed silent all round because the draft field was empty.
 */
export function unfiredDraftSaveNotice(draft: {
  nodes: readonly WorkflowNode[]
  goalText?: string
}): string {
  const head = draft.nodes.find(isTriggerNode)
  const headGoal = typeof head?.data?.['goalText'] === 'string' ? (head.data['goalText'] as string) : ''
  const goalText = draft.goalText?.trim() || headGoal
  if (!goalAsksForDraftSave(goalText)) return ''
  if (draft.nodes.some((node) => isActuationNode(node) && isDraftSaveNode(node))) return ''
  return '目标要求保存草稿，但已记录的步骤里还没有一步真正保存它：请把「暂存离开 / 存草稿」那一次点击继续做完并记录为最后一步，否则回放再干净也没有完成任务。 (The goal asks for a draft and no recorded step saves one yet — finish the 「save draft」 click and record it as the graph\'s last step, or a clean replay still achieves nothing.)'
}

/**
 * Did this run actually fire the graph's draft save?
 *
 * The claim «a draft now sits in the account» is a claim about the user's account,
 * not about what the caller opted into, so it gets answered from the graph: a
 * cutoff run executes every step BEFORE the step it stopped at, and the save counts
 * only if it is one of them. A replay that stopped at step 10 of 26 wrote nothing,
 * however many draft flags the caller waved.
 */
export function draftSaveExecuted(workflow: Workflow, cutoffNodeId?: string | null): boolean {
  const path = executionPath(workflow)
  const stop = cutoffNodeId ? path.findIndex((node) => node.id === cutoffNodeId) : path.length
  if (stop < 0) return false
  return path.slice(0, stop).some((node) => isActuationNode(node) && isDraftSaveNode(node))
}

/**
 * Does this step ACT on the page — press, submit, send, run a script?
 *
 * The counterpart to {@link isCommitNode}: that one asks whether the act is
 * irreversible, this one only asks whether there is an act at all. A draft-shaped
 * READ («读取草稿箱数量») is not a draft being written.
 */
export function isActuationNode(node: WorkflowNode): boolean {
  const blockId = blockIdOf(node)
  if (blockId === 'forms') return String(node.data?.['action'] ?? 'fill') === 'submit'
  return COMMIT_BLOCK_IDS.has(blockId)
}

/**
 * Is there anything worth running before the cutoff?
 *
 * When the graph's FIRST action is the unsafe one, the trial would run zero
 * steps of the actual workflow — it would only open a tab and stop. Skipping is
 * the honest report there; running would spend 45 seconds proving a step the
 * generation session already proved (the anchor) and tell the user nothing.
 *
 * `cutoffInForce` is the cutoff the CALLER actually computed. Passing `null`
 * means "my policy found none" — which is not the same as saying nothing, where
 * the default policy is assumed: a graph whose only unsafe step is a cover upload
 * has no cutoff under the commit policy, and re-deriving the unsafe one here would
 * skip a trial that has twelve steps left to prove.
 */
export function trialHasNothingToProve(workflow: Workflow, cutoffInForce?: string | null): boolean {
  const cutoff = cutoffInForce === undefined ? trialCutoffNodeId(workflow) : cutoffInForce
  if (!cutoff) return false
  return executionPath(workflow)[0]?.id === cutoff
}

/** The engine's failure prefix, when the message carries one. */
export function trialFailureCode(error?: string): string | undefined {
  if (!error) return undefined
  const match = /^([A-Z][A-Z_]{2,})(?:\(([^)]*)\))?/.exec(error.trim())
  if (!match) return undefined
  return match[2] ? `${match[1]}(${match[2]})` : match[1]
}

/**
 * Reduce one trial execution to the record that goes on the workflow.
 *
 * `cutoffNodeId` is passed in rather than re-derived so the caller's view of
 * the graph (the one it actually executed) is what gets recorded.
 */
export function trialRecordOf(
  input: TrialRunInput,
  graph: { cutoffNodeId?: string; totalSteps: number },
): TrialRunRecord {
  const base: TrialRunRecord = {
    outcome: 'passed',
    at: input.at ?? Date.now(),
    full: graph.cutoffNodeId === undefined,
    coveredSteps: input.completedSteps,
    totalSteps: graph.totalSteps,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(graph.cutoffNodeId ? { cutoffNodeId: graph.cutoffNodeId } : {}),
    ...(input.degradedSteps ? { degradedSteps: input.degradedSteps } : {}),
  }
  if (input.timedOut) {
    return { ...base, outcome: 'timeout', reason: 'trial budget exhausted' }
  }
  if (input.cancelledByCaller || input.outcome === 'cancelled') {
    return { ...base, outcome: 'cancelled', reason: 'trial cancelled' }
  }
  if (input.outcome === 'failed') {
    const code = trialFailureCode(input.error)
    return {
      ...base,
      outcome: 'failed',
      ...(input.failedNodeId ? { failedNodeId: input.failedNodeId } : {}),
      ...(code ? { failureCode: code } : {}),
      ...(input.error ? { reason: input.error.slice(0, 300) } : {}),
    }
  }
  // 'ok': a full run is a pass; stopping at the cutoff proves only the prefix.
  return { ...base, outcome: input.stoppedBefore ? 'partial' : 'passed' }
}

/** A trial that never ran, with why. */
export function skippedTrialRecord(reason: string, at = Date.now()): TrialRunRecord {
  return { outcome: 'skipped', at, full: false, coveredSteps: 0, totalSteps: 0, reason }
}

const TRIAL_OUTCOMES: readonly TrialOutcome[] = [
  'passed',
  'partial',
  'failed',
  'cancelled',
  'timeout',
  'skipped',
]

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Rebuild a trial record from stored data, field by field.
 *
 * The record is what the health card reads to decide between "verified" and
 * "unverified", so a stored value that cannot be understood is dropped rather
 * than trusted: an unknown `outcome`, or a missing timestamp, means no record
 * at all (same rule as the settings whitelist in `storage.ts`). Optional
 * numbers keep their own guard so a half-written record cannot claim a step
 * count it did not earn.
 */
export function normalizeTrialRun(raw: unknown): TrialRunRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const outcome = TRIAL_OUTCOMES.find((candidate) => candidate === value.outcome)
  const at = optionalCount(value.at)
  if (!outcome || at === undefined) return undefined
  const durationMs = optionalCount(value.durationMs)
  const coveredSteps = optionalCount(value.coveredSteps)
  const totalSteps = optionalCount(value.totalSteps)
  const degradedSteps = optionalCount(value.degradedSteps)
  const runId = optionalString(value.runId)
  const cutoffNodeId = optionalString(value.cutoffNodeId)
  const failedNodeId = optionalString(value.failedNodeId)
  const failureCode = optionalString(value.failureCode)
  const reason = optionalString(value.reason)
  return {
    outcome,
    at,
    full: value.full === true,
    coveredSteps: coveredSteps ?? 0,
    totalSteps: totalSteps ?? 0,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(cutoffNodeId !== undefined ? { cutoffNodeId } : {}),
    ...(value.draftSaved === true ? { draftSaved: true } : {}),
    ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(degradedSteps !== undefined ? { degradedSteps } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

/**
 * Does the record prove anything about this workflow?
 *
 * Only a clean run of the whole graph does. `partial` is weaker evidence (the
 * steps after the cutoff are still unproven), and `skipped` / `timeout` /
 * `cancelled` are silence — none of them may be presented to the user as
 * "verified", and none of them may be used to certify a goal.
 */
export function trialCertifies(record: TrialRunRecord | false | undefined): boolean {
  return !!record && record.outcome === 'passed'
}

/** Does the record say the graph is broken, as opposed to unproven? */
export function trialFailed(record: TrialRunRecord | false | undefined): boolean {
  return !!record && record.outcome === 'failed'
}

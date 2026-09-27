/**
 * Opt-in real-browser replay smoke — the evidence layer of the "make generated
 * workflows replay on the first try" work. NOT part of `pnpm test` (the root
 * vitest runs in a node environment); run it explicitly:
 *
 *   pnpm --dir server replay-smoke      # needs `npx playwright install chromium`
 *
 * What it does: serves fixture pages whose DOM misbehaves the way real sites
 * do (late render, duplicate rows, a submit that replaces the node, a link that
 * opens a tab), loads the generated-looking graphs in
 * `test/fixtures/replay/*.workflow.json`, and replays them through the shared
 * engine and the SAME in-page kernel (`src/inpage/kernel.ts`) the extension
 * injects, inside real Chromium.
 *
 * What it proves, in two layers:
 *   A. the degradation ladder (`resolvePolicy.ambiguity: 'rank'`) rung by rung
 *      against a real DOM, including the refusal strict mode makes when the
 *      ladder is off — i.e. that the ladder, not leniency, is what saved a step;
 *   B. that the mechanisms generation now writes are load-bearing for replay:
 *      a recorded candidate chain picks the RIGHT row, an element wait survives
 *      a late render, a fallback spec rescues an input whose node was replaced,
 *      and a tab that a click spawned is there for the next step to switch to.
 *      Each is paired with a counterfactual run with that mechanism removed,
 *      because "the run went green" is not evidence on its own.
 *
 * HONEST SCOPE — this is not the extension. The runner has its own executors
 * and driver (`server/src/*`): it never sets `resolvePolicy` on an op, so
 * layer A drives the kernel's resolver directly at op level rather than through
 * a workflow node, and the self-heal write-back (`node.data.__resolution`) plus
 * the strict gates that need background-only hooks (readiness probe, condition
 * evaluation) are out of reach here. Layer B therefore exercises compat-mode
 * resolution through real workflow nodes. The ladder reached through the
 * extension's own executor chain is covered by `tests/kernel-degrade-ladder.spec.ts`
 * (jsdom). What this script still cannot close is a Chromium booted with
 * `--load-extension=dist`, which needs its own environment plumbing.
 *
 * Engine, executors and driver are imported DYNAMICALLY, after the build-flag
 * globals are installed: `src/lib/ocr-support.ts` reads vite's `__OCR__` define,
 * which plain tsx never injects (same reason `scripts/smoke.ts` imports inside
 * `main()`).
 *
 * @module server/scripts/replay-smoke
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  applyDefaultWaits,
  DEFAULT_WAIT_MS,
} from '../../src/background/workflow-engine/debug-session'
import type { WorkflowRunResult } from '../../src/background/workflow-engine/engine'
import type { OpResult, ResolvePolicy, Target, TargetSpec } from '../../src/lib/ops'
import type { Workflow } from '../../src/lib/workflow/types'
import type { BrowserPool } from '../src/browser-pool'
import type { RunnerConfig } from '../src/config'
import type { RunDriver } from '../src/driver'

const FIXTURE_PORT = 8934
const DATA_DIR = mkdtempSync(join(tmpdir(), 'bc-replay-smoke-'))
const ARTIFACTS_DIR = join(DATA_DIR, 'artifacts')
const FIXTURES_DIR = fileURLToPath(new URL('../test/fixtures/replay', import.meta.url))
const FAILURES: string[] = []

/** The tsx-side stand-ins for vite's `define`s, set before any engine import. */
const BUILD_FLAGS: Record<string, unknown> = { __OCR__: false }

interface Modules {
  runWorkflow: typeof import('../../src/background/workflow-engine/engine')['runWorkflow']
  applyDefaultWaits: typeof applyDefaultWaits
  DEFAULT_WAIT_MS: typeof DEFAULT_WAIT_MS
  createExecutors: typeof import('../src/executors')['createExecutors']
  RunDriver: typeof import('../src/driver')['RunDriver']
  BrowserPool: typeof import('../src/browser-pool')['BrowserPool']
  loadConfig: typeof import('../src/config')['loadConfig']
}

let mods: Modules
let config: RunnerConfig
let pool: BrowserPool

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) FAILURES.push(name)
}

const origin = (path: string): string => `http://127.0.0.1:${FIXTURE_PORT}${path}`

// --- Fixture site ---------------------------------------------------------------
//
// Each page is a trap the replay mechanisms have to survive; the workflow
// fixtures under test/fixtures/replay are written against these exact DOMs.

const PAGES: Record<string, string> = {
  // Five identical-looking buttons: the flat selector matches all of them, so
  // only the recorded candidate chain can pick invoice A3. Doubles as the
  // degradation-ladder page.
  '/invoices': `<!doctype html><html><head><title>Invoices</title></head><body>
    <h1>Invoices</h1>
    <table class="inv"><tbody>
      <tr class="row" data-no="A1"><td><button class="pay">Pay</button></td></tr>
      <tr class="row" data-no="A2"><td><button class="pay">Pay</button></td></tr>
      <tr class="row" data-no="A3"><td><button id="pay-btn-3" class="pay" data-testid="pay-invoice-3">Pay</button></td></tr>
      <tr class="row" data-no="A4"><td><button class="pay">Pay</button></td></tr>
      <tr class="row" data-no="A5"><td><button class="pay">Pay</button></td></tr>
    </tbody></table>
    <div id="echo"></div>
    <script>
      document.querySelectorAll('button.pay').forEach((button) => {
        button.addEventListener('click', () => {
          const row = button.closest('tr')
          document.getElementById('echo').textContent = 'paid:' + row.dataset.no
        })
      })
    </script>
  </body></html>`,

  // The form does not exist at load: #note after 1s, #save after 2s. A replay
  // without an element wait fails; one with a wait passes.
  '/slow': `<!doctype html><html><head><title>Slow</title></head><body>
    <h1>Slow form</h1>
    <div id="root"></div>
    <script>
      setTimeout(() => {
        document.getElementById('root').innerHTML = '<input id="note" name="note" value="">'
      }, 1000)
      setTimeout(() => {
        document.getElementById('root').insertAdjacentHTML(
          'beforeend',
          '<button id="save">Save</button><div id="out"></div>',
        )
        document.getElementById('save').addEventListener('click', () => {
          const value = document.getElementById('note').value
          document.getElementById('out').textContent = 'saved:' + value
        })
      }, 2000)
    </script>
  </body></html>`,

  // "Next" rebuilds the card: every node below it is replaced, so the id the
  // recorder saw is gone while the accessible name survives.
  '/drift': `<!doctype html><html><head><title>Drift</title></head><body>
    <h1>Drift</h1>
    <div id="card">
      <input id="amount-old" name="amount" value="">
      <button id="next">Next</button>
    </div>
    <div id="receipt"></div>
    <script>
      document.getElementById('next').addEventListener('click', () => {
        document.getElementById('card').innerHTML =
          '<input id="amount-new" name="amount" value=""><button id="again">Confirm</button>'
      })
      document.getElementById('card').addEventListener('click', (event) => {
        if (event.target && event.target.id === 'again') {
          const value = document.querySelector('input[name="amount"]').value
          document.getElementById('receipt').textContent = 'amount:' + value
        }
      })
    </script>
  </body></html>`,

  '/popup': `<!doctype html><html><head><title>Popup host</title></head><body>
    <h1>Popup host</h1>
    <a id="open" href="/detail" target="_blank">Open detail</a>
  </body></html>`,

  '/detail': `<!doctype html><html><head><title>Invoice detail</title></head><body>
    <h1 id="detail-title">Invoice detail</h1>
  </body></html>`,
}

let fixture: Server

function startFixture(): Promise<void> {
  fixture = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const page = path === undefined ? undefined : PAGES[path]
    if (!page) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(page)
  })
  return new Promise((resolve) => fixture.listen(FIXTURE_PORT, '127.0.0.1', resolve))
}

// --- Workflow fixtures -------------------------------------------------------------

/**
 * The saved graph, with the fixture origin substituted. `__BASE__` is a marker,
 * not a `{{token}}`: a replayed workflow must navigate without needing a
 * variable the user never supplied.
 */
function loadWorkflow(file: string): Workflow {
  const raw = readFileSync(join(FIXTURES_DIR, file), 'utf8')
  return JSON.parse(raw.replace(/__BASE__/g, origin(''))) as Workflow
}

/** Drop the recorded candidate chain, keeping only the flat selector. */
function withoutChain(workflow: Workflow, nodeId: string): Workflow {
  const clone = structuredClone(workflow)
  const node = clone.drawflow.nodes.find((entry) => entry.id === nodeId)
  if (node) delete node.data['target']
  return clone
}

/** Disable the forced element wait, replaying the graph exactly as authored. */
function withoutWaits(workflow: Workflow): Workflow {
  const clone = structuredClone(workflow)
  clone.settings.defaultWaitMs = 0
  return clone
}

/** Send the `switch-tab` step to a tab index that never opens. */
function toMissingTab(workflow: Workflow): Workflow {
  const clone = structuredClone(workflow)
  const node = clone.drawflow.nodes.find((entry) => entry.id === 'switch')
  if (node) node.data['index'] = 99
  return clone
}

// --- Replay ---------------------------------------------------------------------------

/** One replay per call: a fresh context means fresh page timers and tab indices. */
async function withReplay<T>(
  file: string,
  mutate: ((workflow: Workflow) => Workflow) | undefined,
  observe: (result: WorkflowRunResult, driver: RunDriver) => T,
): Promise<T> {
  const session = await pool.acquire({ artifactsDir: ARTIFACTS_DIR })
  const driver = new mods.RunDriver(session)
  try {
    const controller = new AbortController()
    const workflow = mutate ? mutate(loadWorkflow(file)) : loadWorkflow(file)
    const declared = workflow.settings.defaultWaitMs
    const waitMs = typeof declared === 'number' ? declared : mods.DEFAULT_WAIT_MS
    const result = await mods.runWorkflow(mods.applyDefaultWaits(workflow, waitMs), {
      variables: {},
      signal: controller.signal,
      executors: mods.createExecutors({
        driver,
        config,
        artifactsDir: ARTIFACTS_DIR,
        signal: controller.signal,
        provider: null,
      }),
    })
    return observe(result, driver)
  } finally {
    await pool.release(session)
  }
}

async function withPage<T>(path: string, run: (driver: RunDriver) => Promise<T>): Promise<T> {
  const session = await pool.acquire({ artifactsDir: ARTIFACTS_DIR })
  const driver = new mods.RunDriver(session)
  try {
    await driver.newTab(origin(path))
    return await run(driver)
  } finally {
    await pool.release(session)
  }
}

async function pageText(driver: RunDriver, selector: string): Promise<string> {
  const result = await driver.execJs(
    `(() => { const el = document.querySelector(${JSON.stringify(
      selector,
    )}); return el ? (el.textContent ?? '').trim() : '' })()`,
  )
  return result.ok ? String(result.data ?? '') : ''
}

/** Text of the `get-text` block's variable, normalized for comparisons. */
function lastText(result: WorkflowRunResult): string {
  return String(result.variables?.['lastText'] ?? '')
}

const RANK: ResolvePolicy = { mode: 'strict', ambiguity: 'rank' }
const STRICT: ResolvePolicy = { mode: 'strict', ambiguity: 'error' }

const spec = (how: TargetSpec['how'], value: string): TargetSpec => ({ how, value })

const chain = (primary: TargetSpec, ...fallbacks: TargetSpec[]): Target => ({
  primary,
  fallbacks,
})

/** Layer A — the ladder, rung by rung, on the duplicate-rows page. */
async function ladderChecks(): Promise<void> {
  console.log('\n— degradation ladder (op level, real Chromium) —')
  const flat = 'table.inv tbody tr td button.pay'
  await withPage('/invoices', async (driver) => {
    const clean: OpResult = await driver.execOp({
      action: 'click',
      target: chain(spec('css', flat), spec('testid', 'pay-invoice-3')),
      resolvePolicy: RANK,
    })
    check(
      'rung 1: the scored winner acts with no degradation reported',
      clean.ok === true && clean.degrade === undefined && clean.usedSpec === 'testid|pay-invoice-3',
      JSON.stringify({ ok: clean.ok, usedSpec: clean.usedSpec, degrade: clean.degrade }),
    )
    check('rung 1: acted on invoice A3', (await pageText(driver, '#echo')) === 'paid:A3')

    const margin = await driver.execOp({
      action: 'click',
      target: chain(
        spec('css', flat),
        spec('testid', 'pay-invoice-3'),
        spec('id', 'pay-btn-3'),
      ),
      resolvePolicy: RANK,
    })
    const rung2 = margin.degrade
    check(
      'rung 2: a 10-point margin between two winners degrades instead of refusing',
      rung2 !== undefined &&
        rung2.rung === 2 &&
        rung2.to === 'testid|pay-invoice-3' &&
        rung2.from === `css|${flat}` &&
        rung2.matchCount === 5,
      JSON.stringify(rung2),
    )
    check('rung 2: still acted on invoice A3', (await pageText(driver, '#echo')) === 'paid:A3')

    const order = await driver.execOp({
      action: 'click',
      target: chain(spec('css', 'button.pay'), spec('css', 'tr[data-no="A3"] button.pay')),
      resolvePolicy: RANK,
    })
    const rung3 = order.degrade
    check(
      'rung 3: below the score floor it takes the first single-match candidate in recorded order',
      rung3 !== undefined && rung3.rung === 3 && rung3.to === 'css|tr[data-no="A3"] button.pay',
      JSON.stringify(rung3),
    )
    check('rung 3: acted on invoice A3', (await pageText(driver, '#echo')) === 'paid:A3')

    const guess = await driver.execOp({
      action: 'click',
      target: chain(spec('css', 'button.pay'), spec('css', 'table.inv td button.pay')),
      resolvePolicy: RANK,
    })
    const rung4 = guess.degrade
    check(
      'rung 4: with no single-match candidate left it guesses — and says so',
      rung4 !== undefined && rung4.rung === 4 && rung4.matchCount === 5,
      JSON.stringify(rung4),
    )
    check(
      'rung 4: the guess lands on the FIRST row, which is the wrong one',
      (await pageText(driver, '#echo')) === 'paid:A1',
    )

    const refused = await driver.execOp({
      action: 'click',
      target: chain(spec('css', 'button.pay'), spec('css', 'table.inv td button.pay')),
      resolvePolicy: STRICT,
    })
    check(
      'strict without the ladder refuses instead of guessing',
      refused.ok === false &&
        refused.found === true &&
        refused.code === 'LOCATOR_AMBIGUOUS' &&
        refused.matchCount === 5 &&
        (refused.candidates?.length ?? 0) >= 2,
      JSON.stringify({ code: refused.code, matchCount: refused.matchCount }),
    )
  })
}

/** Layer B — whole graphs replayed through the engine, with counterfactuals. */
async function replayChecks(): Promise<void> {
  console.log('\n— generated graphs replayed end to end —')

  const paid = await withReplay('invoice-chain.workflow.json', undefined, (result) => ({
    outcome: result.outcome,
    text: lastText(result),
    error: result.error ?? '',
  }))
  check('candidate chain: replay reaches the last step', paid.outcome === 'ok', paid.error)
  check(
    'candidate chain: the flagged invoice was the one paid',
    paid.text === 'paid:A3',
    paid.text,
  )

  const noChain = await withReplay(
    'invoice-chain.workflow.json',
    (workflow) => withoutChain(workflow, 'pay'),
    (result) => ({ outcome: result.outcome, text: lastText(result) }),
  )
  check(
    'counterfactual: without the chain the flat selector still turns green — on the WRONG row',
    noChain.outcome === 'ok' && noChain.text === 'paid:A1',
    JSON.stringify(noChain),
  )

  const waited = await withReplay('slow-render-form.workflow.json', undefined, (result) => ({
    outcome: result.outcome,
    text: lastText(result),
    error: result.error ?? '',
  }))
  check(
    'element wait: a form that renders late is filled and saved',
    waited.outcome === 'ok' && waited.text === 'saved:hello',
    `${waited.outcome} / ${waited.text} ${waited.error}`,
  )

  const rushed = await withReplay(
    'slow-render-form.workflow.json',
    withoutWaits,
    (result) => ({ outcome: result.outcome, error: result.error ?? '' }),
  )
  check(
    'counterfactual: the same graph without the wait fails on the late field',
    rushed.outcome === 'failed' && /No element matched/i.test(rushed.error),
    `${rushed.outcome} / ${rushed.error}`,
  )

  const drift = await withReplay('dom-replaced.workflow.json', undefined, (result) => ({
    outcome: result.outcome,
    text: lastText(result),
    error: result.error ?? '',
  }))
  check(
    'candidate chain: an input whose node was replaced is filled through the fallback',
    drift.outcome === 'ok' && drift.text === 'amount:42',
    `${drift.outcome} / ${drift.text} ${drift.error}`,
  )

  const stale = await withReplay(
    'dom-replaced.workflow.json',
    (workflow) => withoutChain(workflow, 'fill-after'),
    (result) => ({ outcome: result.outcome, error: result.error ?? '' }),
  )
  check(
    'counterfactual: without the fallback the stale id fails the step',
    stale.outcome === 'failed' && /No element matched/i.test(stale.error),
    `${stale.outcome} / ${stale.error}`,
  )

  const popup = await withReplay('popup-tab.workflow.json', undefined, (result, driver) => ({
    outcome: result.outcome,
    text: lastText(result),
    error: result.error ?? '',
    tabs: driver.listTabs().map((tab) => tab.url.replace(`http://127.0.0.1:${FIXTURE_PORT}`, '')),
    lines: (result.steps ?? []).map((line) => `${line.nodeId}/${line.kind}: ${line.text}`),
  }))
  const popupOk = popup.outcome === 'ok' && popup.text === 'Invoice detail'
  check(
    'new tab: a link that opens a tab is followed, and the next step reads it',
    popupOk,
    // The engine trace only goes on the wire when it is needed: a green run of
    // this scenario is exactly the race that used to pass silently.
    popupOk
      ? `${popup.outcome} / ${popup.text}`
      : `${popup.outcome} / '${popup.text}' ${popup.error} tabs=${JSON.stringify(popup.tabs)}\n    ${popup.lines.join('\n    ')}`,
  )

  const missingTab = await withReplay('popup-tab.workflow.json', toMissingTab, (result) => ({
    outcome: result.outcome,
    error: result.error ?? '',
  }))
  check(
    'counterfactual: a switch to a tab that is not there fails the step, it does not stay green',
    missingTab.outcome === 'failed' && /switch-tab/.test(missingTab.error),
    `${missingTab.outcome} / ${missingTab.error}`,
  )
}

async function main(): Promise<void> {
  // loadConfig() reads the environment, so the pointers go in first: every
  // artifact of this run stays inside a temp directory.
  process.env['BC_DATA_DIR'] = DATA_DIR
  process.env['BC_WORKFLOWS_FILE'] = join(DATA_DIR, 'workflows.json')
  process.env['BC_WORKFLOWS_EXTRA_DIR'] = ''
  process.env['BC_BROWSER_HEADED'] = '0'
  process.env['BC_RUN_TIMEOUT_MS'] = '120000'
  Object.assign(globalThis, BUILD_FLAGS)

  mods = {
    runWorkflow: (await import('../../src/background/workflow-engine/engine')).runWorkflow,
    applyDefaultWaits: (await import('../../src/background/workflow-engine/debug-session'))
      .applyDefaultWaits,
    DEFAULT_WAIT_MS: (await import('../../src/background/workflow-engine/debug-session'))
      .DEFAULT_WAIT_MS,
    createExecutors: (await import('../src/executors')).createExecutors,
    RunDriver: (await import('../src/driver')).RunDriver,
    BrowserPool: (await import('../src/browser-pool')).BrowserPool,
    loadConfig: (await import('../src/config')).loadConfig,
  }
  config = mods.loadConfig()
  pool = new mods.BrowserPool(config)

  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  await startFixture()
  let status = 0
  try {
    status = (await fetch(origin('/invoices'))).status
  } catch {
    status = 0
  }
  check('fixture site up', status === 200, String(status))

  await ladderChecks()
  await replayChecks()

  await pool.close()
  fixture.close()
  rmSync(DATA_DIR, { recursive: true, force: true })

  if (FAILURES.length > 0) {
    console.error(`\nREPLAY SMOKE FAILED: ${FAILURES.join(', ')}`)
    process.exit(1)
  }
  console.log('\nREPLAY SMOKE OK — every green step has a counterfactual behind it')
  process.exit(0)
}

void main().catch((error) => {
  console.error('replay smoke crashed:', error)
  process.exit(1)
})

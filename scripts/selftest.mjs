#!/usr/bin/env node
/**
 * End-to-end self-test for workflow GENERATION: build → reload the extension →
 * generate a graph from a goal → replay the saved graph → verdict + evidence.
 *
 * Why this exists: until now every code change to the generation pipeline had
 * to be checked by a human — `pnpm build`, click reload in chrome://extensions,
 * type the goal into the panel, watch the run, then run it again. That makes the
 * fix loop one-round-per-human-action, which is the slowest possible way to find
 * out that a gate refused a node. This script closes the loop instead: it asks
 * the extension to reload itself (`reload_extension`, gated on a setting that is
 * off by default), drives `generate_workflow` and `repair_workflow` as
 * start/poll pairs, and writes its evidence to a JSON file a reader can act on.
 * `repair_workflow` is the replay plus one thing `verify_workflow` cannot do: a
 * step that FAILS goes to the autonomous repair loop, and the graph is measured
 * again afterwards — so "有不成功就自动修复" is the default behaviour of this
 * script, not a follow-up human action.
 *
 *   node scripts/selftest.mjs                          # full loop, default goal
 *   node scripts/selftest.mjs --goal "<other goal>"    # same loop, other goal
 *   node scripts/selftest.mjs --skip-build             # keep the loaded build
 *   node scripts/selftest.mjs --ack-reload              # only for a build too old to report a stamp
 *   node scripts/selftest.mjs --reload-wait 60         # wait longer for that one click
 *   node scripts/selftest.mjs --skip-repair            # replay only, never repair
 *   node scripts/selftest.mjs --keep-tabs              # leave the pages the run opened on screen
 *   node scripts/selftest.mjs --from verify --workflow <id>   # just replay
 *   node scripts/selftest.mjs --from verify --workflow <id> --input topic=探店
 *                                                             # …with its declared inputs
 *   node scripts/selftest.mjs --reattach <conversationId>     # finish an abort
 *
 * Requirements: the adapter running (`node public/mcp-server.mjs`), the local
 * agent bridge enabled in the extension, and a configured model provider.
 *
 * Reload handling: the extension reports the hash of the sources it loaded, so
 * the script knows whether the browser already runs this checkout and only asks
 * for a reload when it does not. With "Let the local agent reload the extension
 * (developer)" ticked in Settings → Local agent access, that is automatic and no
 * human is involved at all. With the setting off (the default) the script prints
 * "click reload in chrome://extensions" and WAITS for the new build to report
 * itself — one click costs one click, not a re-run and not `--ack-reload`.
 *
 * Exit codes: 0 replay ran clean AND the goal held afterwards · 1 generation
 * verdict failed · 2 replay verdict failed (a step failed, or every step ran and
 * the goal conditions did not hold — a graph of no-op steps is not a success).
 * 3 the harness itself could not run (bridge, build, reload).
 *
 * The goal boundary is the user's, not the script's: the default goal ends at a
 * DRAFT and says so, because generation really operates the page. Point it at a
 * goal that submits and it will submit.
 *
 * `--run-to-draft` answers the question a replay otherwise cannot: a draft workflow
 * spends its whole graph on side effects (upload a cover, type a body, press 保存草稿),
 * and the replay's safety cutoff refuses every step whose recorded intent merely
 * MENTIONS a commit — so without it the run stops at step 4 of 12, writes nothing,
 * and reports `partial` forever. With it, the steps that prepare a commit run; the
 * commit itself (an unsafe click / submit / key / script / webhook) still halts the
 * replay. Off by default, because the default is what protects an unattended run.
 *
 * `--allow-draft-commit` goes one step further and fires THAT last step: the graph's
 * own commit, when its own words name a draft (草稿 / 暂存 / draft) and no outward
 * verb. It writes into the user's account, so it is never implied by anything else —
 * and a publish, a submit, a send or a payment still halts the run.
 */
import process from 'node:process'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  connectBridge,
  pollRun,
  unwrapReply,
  waitForBuild,
  waitForPlugin,
} from './bridge-client.mjs'
import { readBuiltStamp, sourceFingerprintSync, writeBuiltStamp, writeLoadedStamp } from './build-stamp.mjs'

const USAGE =
  'usage: node scripts/selftest.mjs [--goal <text>] [--workflow <id>] [--from build|reload|generate|verify]' +
  ' [--skip-build] [--skip-reload] [--ack-reload] [--skip-repair] [--keep-tabs] [--reattach <conversationId>]' +
  ' [--interval 10] [--timeout 60] [--budget 300] [--reload-wait 30] [--run-to-draft]' +
  ' [--allow-draft-commit] [--input name=value …] [--report <path>]'

/**
 * The default goal is the scenario this pipeline was built for: draw an image
 * with a code node, feed it to an upload control, fill in copy, stop at a draft.
 * It exercises the escape-hatch gate, the data-flow gates, upload, forms and the
 * unsafe-step cutoff in one run.
 */
const DEFAULT_GOAL =
  '在小红书创作服务平台（https://creator.xiaohongshu.com/publish/publish?target=image）生成一篇图文笔记草稿：' +
  '先用代码节点画一张封面图（canvas 绘制标题文字与背景，导出 PNG dataURL 或 File 对象），' +
  '把这张图上传到图文发布的图片上传入口，再填写标题与正文，最后只保存到草稿，绝不点击发布或确认发布。'

const options = {
  goal: process.env.SELFTEST_GOAL ?? DEFAULT_GOAL,
  workflowId: '',
  from: 'build',
  build: true,
  reload: true,
  ackReload: false,
  repair: true,
  closeTabs: true,
  reattach: '',
  intervalMs: 10_000,
  timeoutMs: 60 * 60_000,
  budgetMs: 300_000,
  reloadWaitMs: 30 * 60_000,
  // OFF by default. With it on, the replay runs the steps whose side effect the
  // goal ASKED for — uploading the cover, typing the title and body, saving the
  // draft — and still halts in front of an unsafe click/submit/key. A run without
  // it stops at the first step the intent-keyword classifier calls unsafe, which
  // for a draft workflow means it never writes anything and can only ever report
  // `partial`.
  runToDraft: false,
  // OFF by default, and it is the one flag that WRITES INTO THE USER'S ACCOUNT: the
  // graph's own commit step runs, provided its own words name a draft (草稿 / 暂存 /
  // draft) and no outward verb. A publish, a submit, a send or a payment still stops
  // the run, so this answers the question `--run-to-draft` cannot: whether the draft
  // is actually written.
  allowDraftCommit: false,
  // The values for the inputs the saved workflow DECLARES (its trigger
  // parameters). A generated graph that references {{topic}} is parameterised on
  // purpose, and the panel asks a human for the value when Run is clicked — an
  // unattended replay has nobody to ask, so the caller says it here. Repeat the
  // flag once per parameter.
  inputs: {},
  report: path.join(process.cwd(), 'tmp', 'selftest-report.json'),
}

const argv = process.argv.slice(2)
while (argv.length > 0) {
  const arg = String(argv.shift())
  if (arg === '--goal') options.goal = String(argv.shift())
  else if (arg === '--workflow') options.workflowId = String(argv.shift())
  else if (arg === '--from') options.from = String(argv.shift())
  else if (arg === '--skip-build') options.build = false
  else if (arg === '--skip-reload') options.reload = false
  else if (arg === '--ack-reload') options.ackReload = true
  else if (arg === '--skip-repair') options.repair = false
  else if (arg === '--keep-tabs') options.closeTabs = false
  else if (arg === '--reattach') options.reattach = String(argv.shift())
  else if (arg === '--interval') options.intervalMs = Number(argv.shift()) * 1000
  else if (arg === '--timeout') options.timeoutMs = Number(argv.shift()) * 60_000
  else if (arg === '--budget') options.budgetMs = Number(argv.shift()) * 1000
  else if (arg === '--reload-wait') options.reloadWaitMs = Number(argv.shift()) * 60_000
  else if (arg === '--run-to-draft') options.runToDraft = true
  else if (arg === '--allow-draft-commit') {
    options.allowDraftCommit = true
    // The draft commit is a commit, so the run is already in commit-cutoff mode;
    // requiring both flags would only let a caller ask for one and get silence.
    options.runToDraft = true
  }
  else if (arg === '--input') {
    const pair = String(argv.shift() ?? '')
    const eq = pair.indexOf('=')
    if (eq <= 0) die(3, `--input wants name=value, got ${pair || '(nothing)'}`)
    options.inputs[pair.slice(0, eq)] = pair.slice(eq + 1)
  } else if (arg === '--report') options.report = String(argv.shift())
  else if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  } else die(3, `unknown flag ${arg}`)
}
if (!['build', 'reload', 'generate', 'verify'].includes(options.from))
  die(3, `--from must be build|reload|generate|verify, got ${options.from}`)
if (!Number.isFinite(options.intervalMs) || !Number.isFinite(options.timeoutMs))
  die(3, '--interval, --timeout and --budget take numbers (seconds / minutes)')

const PHASE_ORDER = ['build', 'reload', 'generate', 'verify']
const started = PHASE_ORDER.indexOf(options.from)

const report = {
  startedAt: new Date().toISOString(),
  goal: options.goal,
  phases: {},
  verdict: { pass: false, reason: 'not run' },
}

const log = (...lines) => {
  for (const line of lines) console.log(`[${stamp()}] ${line}`)
}

let conn
async function main() {
  try {
    conn = await connectBridge({ agentName: 'selftest@browser-copilot' })
  } catch (error) {
    die(3, error instanceof Error ? error.message : String(error))
  }

  try {
    let builtThisRun = false
    // --- build ------------------------------------------------------------------
    if (started <= 0 && options.build) {
      log('build: pnpm build')
      const code = await runBuild()
      report.phases.build = { exitCode: code }
      if (code !== 0) die(3, `build failed with exit code ${code}`)
      builtThisRun = true
    } else {
      report.phases.build = { skipped: true }
    }

    // --- reload (pick up the build without a human, or wait for one click) ------
    // A build the browser already runs needs no reload, and asking for one that
    // is refused would stall the loop on a setting toggle. So the extension is
    // ASKED what it is running — it reports the hash of its sources — and a
    // reload is only demanded when that hash is not this checkout's.
    const stamp = sourceFingerprintSync()
    report.buildStamp = stamp
    // `dist/` now compiles from these sources, so a later round that skips the
    // build can still prove a reload would reach this stamp.
    if (builtThisRun) await writeBuiltStamp(stamp)
    // Not gated on `--from`: a replay measured against a worker still running an
    // older build is not evidence about THIS code, and rounds 31–32 were exactly
    // that — `--from verify` skipped the gate, so three shipped fixes were
    // reported as having changed nothing. `--skip-reload` is the opt-out.
    if (options.reload) {
      // Generous on purpose: right after a browser restart the extension's
      // outbound reconnect fires on the adapter's own ~30-second cadence, and a
      // preflight that gives up before that reads as "the plugin is broken".
      const live = await waitForPlugin(conn, { log, timeoutMs: 120_000 })
      if (!live.ok)
        die(
          3,
          'the bridge is not answering after 120s — is the extension loaded with Local agent ' +
            'access enabled? After a browser restart the worker reconnects on its own; if it has ' +
            'been longer than a minute, the service worker is dead and Chrome needs a restart.',
        )
      if (live.build === stamp) {
        await writeLoadedStamp(stamp)
        await writeBuiltStamp(stamp)
        report.phases.reload = {
          skipped: 'already-current',
          stamp,
          advertisedTools: live.toolNames.length,
        }
        log(`  the browser already runs build ${stamp} — nothing to pick up`)
      } else if (options.ackReload) {
        // A human says they reloaded. Take their word for it, but only for a
        // build that cannot say for itself: a loaded build that reports a DIFFERENT
        // stamp than this checkout is a different checkout, and recording it as
        // this one would have the whole run test the wrong code.
        if (live.build && stamp && live.build !== stamp)
          die(
            3,
            `--ack-reload refused: the browser reports build ${live.build}, this checkout hashes to ${stamp}.` +
              ' They are different code — reload to pick up this one, or run from that checkout.',
          )
        await writeLoadedStamp(stamp)
        report.phases.reload = { acknowledged: true, stamp, advertisedTools: live.toolNames.length }
        log(`  recorded build ${stamp} as the one the browser is running`)
      } else {
        // A reload loads `dist/`, not the sources on disk. If this round skipped
        // the build, no reload can ever make the browser report `stamp` — asking
        // for one on a loop would spend the whole wait reloading the same old
        // code, on the user's browser, over and over.
        const built = await readBuiltStamp()
        if (built !== stamp)
          die(
            3,
            `src is ${stamp}, but the build in dist/ compiled ${built || '(unrecorded)'} — ` +
              'a reload only picks up dist/, so this round cannot reach the new code. ' +
              'Drop --skip-build, or use --from build, so the build phase runs first.',
          )
        log(
          `reload: browser runs build ${live.build || '(a build too old to report one)'}, this is ${stamp}`,
        )
        let data
        let refused
        try {
          data = unwrapReply(
            await conn.request({
              type: 'tool',
              tool: 'reload_extension',
              args: { confirm: 'reload' },
            }),
          )
        } catch (error) {
          refused = String(error.message ?? error)
        }
        if (refused) {
          // The gate is off by design, so a human opens it once — and the loop
          // does not care which of the two actions they take. It re-asks for the
          // reload on every slice, so ticking "Let the local agent reload the
          // extension" mid-run unsticks it, and so does clicking reload in
          // chrome://extensions. Either way this run continues by itself.
          const minutes = Math.round(options.reloadWaitMs / 60_000)
          log(
            '  auto-reload refused (the setting is off by default).',
            `  Either tick "Let the local agent reload the extension (developer)" in Settings → Local`,
            '  agent access, or click reload once in chrome://extensions. This run re-asks every 20s',
            `  and picks the build up on its own (up to ${minutes}min) — no re-run needed.`,
          )
          report.phases.reload = { refused, stamp, waitedForHuman: true, waitMinutes: minutes }
          const deadline = Date.now() + options.reloadWaitMs
          let picked = { ok: false, build: '' }
          let slice = 0
          while (Date.now() < deadline && !picked.ok) {
            // Only the first slice narrates: the notice is for the human reading
            // along, not one line every 20 seconds for half an hour.
            picked = await waitForBuild(conn, stamp, {
              log: slice === 0 ? log : () => {},
              timeoutMs: 20_000,
            })
            slice += 1
            if (picked.ok) break
            try {
              await conn.request(
                { type: 'tool', tool: 'reload_extension', args: { confirm: 'reload' } },
                10_000,
              )
            } catch {
              // Still refused — the next slice asks again.
            }
          }
          if (!picked.ok)
            die(
              3,
              picked.build
                ? `the browser still reports build ${picked.build}, not ${stamp} — no reload within ${minutes}min. ${refused}`
                : `no reload within ${minutes}min — the browser still runs a build that reports no stamp. ${refused}`,
            )
          log(`  build ${stamp} is live`)
        } else {
          // The reload is asynchronous and the worker that ANSWERED the request is
          // the one being torn down: a single probe can be served by the build that
          // is about to die. Wait for THIS stamp instead of reading whatever answers
          // first, and say which of the two failures happened.
          const up = await waitForBuild(conn, stamp, { log, timeoutMs: 90_000 })
          if (!up.ok)
            die(
              3,
              up.build
                ? `the bridge is up but reports build ${up.build}, not ${stamp} — the reload did not take effect`
                : 'the bridge never came back after the reload — check the service worker console',
            )
          log(`  extension version ${data.version} is live with the new build`)
          const live = await waitForPlugin(conn, { log, timeoutMs: 15_000 })
          report.phases.reload = {
            ...data,
            stamp,
            bridgeBack: up.ok,
            advertisedTools: live.toolNames.length,
          }
        }
        await writeLoadedStamp(stamp)
      }
    } else {
      report.phases.reload = { skipped: true }
    }

    // --- generate ---------------------------------------------------------------
    let workflowId = options.workflowId
    if (started <= 2 && !options.workflowId) {
      log(`generate: ${options.goal.slice(0, 72)}…`)
      const run = await pollRun(conn, {
        tool: 'generate_workflow',
        ...(options.reattach && options.reattach.startsWith('external-gen:')
          ? { conversationId: options.reattach }
          : {
              startArgs: {
                prompt: options.goal,
                ...(options.closeTabs ? { closeTabsAtEnd: true } : {}),
              },
            }),
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs,
        log,
      })
      const result = run.status?.result ?? {}
      report.phases.generate = { conversationId: run.conversationId, result }
      workflowId = result.workflow?.id ?? ''
      // What this run was for is the SAVED GRAPH, not the model's closing prose.
      // Round 48 composed and saved 12 nodes, then ended its turn right after the last
      // tool call with no answer text — and the old gate threw the whole round away on
      // that `ok:false`, refusing to replay the only artifact it had produced.
      const graphSaved = result.workflow?.saved === true && result.workflow?.nodeCount > 0
      const generationFailed = !graphSaved
      if (generationFailed) {
        report.verdict = {
          pass: false,
          stage: 'generate',
          reason: result.error ?? firstReason(result) ?? 'the graph was not saved',
        }
        log(
          `GENERATION FAILED: ${report.verdict.reason}`,
          ...(result.issues?.length ? [`issues: ${result.issues.join(' | ')}`] : []),
          `reattach with --reattach ${run.conversationId}`,
        )
        process.exitCode = 1
        return
      }
      log(
        `  saved ${result.workflow.name} (${workflowId}) · ${result.workflow.nodeCount} nodes`,
        `  pre-save trial: ${result.workflow.trialRun?.outcome ?? 'none'} · verified=${result.workflow.verified}`,
        ...(result.workflow.saveWarnings?.length
          ? [`  save warnings: ${result.workflow.saveWarnings.join(' | ')}`]
          : []),
        ...(result.ok
          ? []
          : [
              `  note: the turn never wrote a final answer (${String(
                result.error ?? 'unknown',
              ).slice(0, 140)}) — the graph is saved, so the replay runs anyway`,
            ]),
      )
      // The bridge re-asked the model for its missing last step when the first turn
      // ended without one. Named here because it doubles the round's wall time, and
      // because `recorded 0 more` is the evidence that the hole is behavioural.
      if (result.terminalStepContinuation) {
        const c = result.terminalStepContinuation
        log(
          `  terminal-step re-ask: turn ended at ${c.stepsBefore} steps with no draft save,` +
            ` the extra turn took it to ${c.stepsAfter} (ok=${c.ok})`,
          `  re-ask answered: ${String(c.answer ?? '(nothing)').slice(0, 300)}`,
        )
      }
      // The last steps of the graph, each with the words on the element its click
      // targets. Whether a draft save exists is decided from those words, so this
      // line separates the two ways to fail the gate: the words were never
      // recorded (a capture-time hole) or they were recorded and name a different
      // button (the model clicked the wrong thing).
      const graphTail = (result.workflow.nodes ?? []).slice(-4)
      if (graphTail.length > 0) {
        log(
          '  graph tail: ' +
            graphTail
              .map((n) => `${n.blockId}${n.words ? ` «${n.words}»` : ''} · ${String(n.intent ?? '').slice(0, 46)}`)
              .join(' | '),
        )
      }
      // The bridge answers this from the graph, so it is known BEFORE any replay:
      // the goal asks for a draft and no node writes one. Replaying such a graph
      // cannot tell you anything you do not already have — round 22 ran 26/26 clean,
      // reported `verified: true`, and saved nothing — so stop here with the reason
      // instead of spending another twelve minutes proving it.
      if (result.workflow.terminalStepMissing === true) {
        report.verdict = {
          pass: false,
          stage: 'generate',
          reason:
            'the goal asks for a draft and no node in the graph saves one — replay skipped, ' +
            'the graph is missing its terminal action',
          workflowId,
          nodeCount: result.workflow.nodeCount,
        }
        log(`INCOMPLETE GENERATION: ${report.verdict.reason}`)
        process.exitCode = 2
        return
      }
    } else {
      report.phases.generate = { skipped: true, workflowId }
    }

    // --- verify (replay the saved graph, repairing it if a step fails) ----------
    if (started <= 3) {
      if (!workflowId) die(3, 'nothing to replay: no workflow id was produced or given')
      // `repair_workflow` is the replay plus the repair loop; `verify_workflow`
      // only measures. A browser still running a build from before the repair
      // entry answers `Unknown tool`, so the harness falls back rather than
      // reporting a generation defect it never saw.
      const repairable = options.repair && (await hasRepairTool(conn))
      const tool = repairable ? 'repair_workflow' : 'verify_workflow'
      log(
        `${tool}: replaying ${workflowId} with a ${options.budgetMs / 1000}s budget`,
        ...(options.repair && !repairable
          ? [
              '  the loaded build has no repair_workflow — replay only (reload the new build to repair)',
            ]
          : []),
      )
      const run = await pollRun(conn, {
        tool,
        ...(options.reattach &&
        (options.reattach.startsWith('external-verify:') ||
          options.reattach.startsWith('external-repair:'))
          ? { conversationId: options.reattach }
          : {
              startArgs: {
                workflowId,
                budgetMs: options.budgetMs,
                ...(options.closeTabs ? { closeTabsAtEnd: true } : {}),
                ...(options.runToDraft ? { commitCutoffOnly: true } : {}),
                ...(options.allowDraftCommit ? { allowDraftCommit: true } : {}),
                ...(Object.keys(options.inputs).length > 0 ? { inputs: options.inputs } : {}),
              },
            }),
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs,
        log,
      })
      const result = run.status?.result ?? {}
      const trial = result.workflow?.trialRun ?? {}
      const repair = result.repair ?? {}
      report.phases.verify = {
        conversationId: run.conversationId,
        tool,
        // What the replay was actually handed: a verdict on a parameterised graph
        // means nothing without knowing which inputs it ran with.
        ...(Object.keys(options.inputs).length > 0 ? { inputs: options.inputs } : {}),
        result,
      }

      const replayFailed = !result.ok || trial.outcome === 'failed' || trial.outcome === 'timeout'
      // The goal verdict is a separate fact from the coverage verdict, and it is
      // the one the user actually asked about: a graph can run every step without
      // an error and still never save the draft. `undefined` means nothing was
      // judged — no goal contract, or a replay that stopped before the end.
      const goal = result.workflow?.goal
      const goalUnmet = goal !== undefined && goal.certified !== true
      // A cutoff run proves its PREFIX, nothing else. Round 18 reported `pass`
      // for a replay that covered 10 of 26 steps and never reached the save, and
      // printed «RAN THROUGH ITS OWN DRAFT COMMIT» for a run that wrote no draft:
      // both claims come from what the extension actually observed — the record's
      // `draftSaved` is answered from the graph, not from the caller's flag.
      const ranToTheEnd = trial.outcome === 'passed'
      const draftSaved = trial.draftSaved === true
      const stoppedShort = !replayFailed && !ranToTheEnd && !draftSaved
      report.verdict = {
        pass: !replayFailed && !goalUnmet && !stoppedShort,
        stage: replayFailed ? 'verify' : goalUnmet ? 'goal' : stoppedShort ? 'cutoff' : 'ok',
        reason:
          result.error ??
          trial.reason ??
          (stoppedShort
            ? `the replay stopped at step ${trial.coveredSteps ?? '?'}/${trial.totalSteps ?? '?'} at its cutoff (${trial.cutoffNodeId ?? '?'}) and never fired the graph's draft save — nothing was written and the steps after the cutoff are unproven`
            : goalUnmet
              ? goal.unmet?.length
                ? `${goal.reason} Unmet: ${goal.unmet.join(' | ')}.`
                : goal.reason
              : goal === undefined
                ? // The coverage verdict must not read as a goal verdict: a graph with
                  // no goal contract proves its STEPS, and nothing about the task.
                  'the replay ran without failing a step; its goal was not judged (the graph carries no goal contract)'
                : 'the replay ran without failing a step, and its goal held afterwards'),
        outcome: trial.outcome,
        verified: result.workflow?.verified === true,
        /** A full graph, no step failed: the only replay that proves the workflow. */
        proven: trial.outcome === 'passed' && trial.full === true,
        /** Did a draft actually land in the account on this run. */
        draftSaved,
        /** L1/L2/L3 certification of the goal itself, judged on the live page. */
        goalCertified: goal?.certified,
        goalLevel: goal?.level,
        goalReason: goal?.reason,
        /** Which condition rows failed, in their own words. */
        goalUnmet: goal?.unmet,
        /** Set when a row failed on the instant-of-run read and only held on a later read. */
        goalSettledAfterMs: goal?.settledAfterMs,
        /** Which cutoff the replay ran under, so a reader knows what was refused.
         * Named with what the graph actually offered: the caller's flag alone calls
         * round 22 a `draft-commit` run, and the honest fact is that the graph had
         * no draft-save step to commit to. */
        cutoffMode: options.allowDraftCommit
          ? result.workflow?.terminalStepMissing === true
            ? 'draft-commit-absent'
            : 'draft-commit'
          : options.runToDraft
            ? 'commit-only'
            : 'first-unsafe',
        /** True when this run was allowed to write a draft into the user's account. */
        draftCommitAllowed: options.allowDraftCommit === true,
        coveredSteps: trial.coveredSteps,
        totalSteps: trial.totalSteps,
        cutoffNodeId: trial.cutoffNodeId,
        failedNodeId: trial.failedNodeId,
        failureCode: trial.failureCode,
        degradedSteps: trial.degradedSteps,
        repairStatus: repair.status,
        repairAttempts: repair.attempts,
        repairCommitted: repair.committed,
        tabsClosed: result.tabsClosed,
      }
      log(
        `  replay ${trial.outcome ?? 'no record'} · ${trial.coveredSteps ?? '?'}/${trial.totalSteps ?? '?'} steps`,
        `  verified(clean full replay)=${report.verdict.verified} · degraded locators=${trial.degradedSteps ?? 0}`,
        ...(goal
          ? [
              `  goal ${goal.certified ? 'CERTIFIED' : 'NOT CERTIFIED'} (${goal.level}) — ${goal.reason}` +
                (goal.settledAfterMs !== undefined
                  ? ` [a success row only held ${goal.settledAfterMs} ms after the run — the page needed to settle]`
                  : ''),
            ]
          : trial.outcome === 'passed'
            ? [
                '  goal not judged — the graph has no goal contract, so nothing here says the task itself was achieved',
              ]
            : []),
        ...(trial.failureCode
          ? [`  failure: ${trial.failureCode} @ ${trial.failedNodeId ?? '?'}`]
          : []),
        ...(trial.failureCode === 'UNRESOLVED_INPUT'
          ? [
              `  ${trial.reason ?? 'a declared input had no value'} — this replay cannot fix it:` +
                ' if the name is a parameter the workflow DECLARES, rerun with --input name=value;' +
                ' if a step inside the graph was supposed to WRITE it (an ai-agent / canvas node),' +
                ' --input cannot help — the graph is missing its producer.',
            ]
          : []),
        ...(repair.status && repair.status !== 'not-needed'
          ? [
              `  repair: ${repair.status} · ${repair.attempts ?? 0} attempt(s)` +
                `${repair.committed ? ' · wrote a new revision' : ''}` +
                `${repair.reason ? ` · ${repair.reason}` : ''}`,
            ]
          : []),
        ...(result.tabsClosed === undefined
          ? options.closeTabs
            ? [
                '  closeTabsAtEnd was ignored — the loaded build predates it; reload to clean up tabs',
              ]
            : []
          : [`  closed ${result.tabsClosed} tab(s) this run opened`]),
        ...(options.runToDraft && trial.outcome === 'partial' && trial.cutoffNodeId
          ? options.allowDraftCommit
            ? [
                `  the draft opt-in still stopped at ${trial.cutoffNodeId} — that commit is not worded ` +
                  'as a draft save, or the loaded build predates allowDraftCommit (build + reload)',
              ]
            : [
                `  commit cutoff still stopped at ${trial.cutoffNodeId} — that step is an unsafe ` +
                  'click/submit/key, or the loaded build predates commitCutoffOnly (build + reload)',
              ]
          : []),
        ...(replayFailed
          ? ['REPLAY FAILED — evidence is in the report file']
          : goalUnmet
            ? [
                'RAN CLEAN, GOAL NOT CERTIFIED — every step returned without an error, but the goal conditions the workflow carries were not met on the page; read the L3 line above before calling this a success',
              ]
            : stoppedShort
              ? [
                  `STOPPED SHORT OF ITS COMMIT — the run covered ${trial.coveredSteps ?? '?'}/${trial.totalSteps ?? '?'} steps and never fired the graph’s save step, so NO draft was written. This is not a pass: the steps after the cutoff, including the one the goal asked for, are unproven.`,
                ]
              : draftSaved
                ? [
                    'DRAFT WRITTEN — the graph’s own save step executed, so a draft now sits in the account; a publish would still have stopped the run',
                  ]
                : result.workflow?.verified
                  ? ['PASS — the generated graph replays end to end and its goal held']
                  : options.allowDraftCommit
                    ? [
                        'RAN TO THE END OF ITS GRAPH — every step executed; nothing published',
                      ]
                    : options.runToDraft
                      ? [
                          'RAN TO THE COMMIT POINT — steps before it executed for real; the draft is written only if the graph reached its own save step',
                        ]
                      : [
                          'RAN, NOT FULLY PROVEN — the replay stopped at its unsafe-step cutoff (rerun with --run-to-draft to execute the steps before the commit)',
                        ]),
      )
      process.exitCode = replayFailed || goalUnmet || stoppedShort ? 2 : 0
      return
    }

    report.verdict = { pass: false, reason: `stopped after --from ${options.from}` }
    process.exitCode = 3
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    report.verdict = { pass: false, stage: 'harness', reason: message }
    log(`HARNESS ERROR: ${message}`)
    process.exitCode = 3
  } finally {
    conn.close()
    report.finishedAt = new Date().toISOString()
    await writeReport()
    log(
      `report: ${options.report} · verdict ${report.verdict.pass ? 'PASS' : report.verdict.reason}`,
    )
  }
}

await main()

// --- helpers ------------------------------------------------------------------

/** Whether the LOADED build advertises `repair_workflow`. */
async function hasRepairTool(conn) {
  try {
    const reply = await conn.request({ type: 'tools.list' }, 10_000)
    if (!reply?.ok) return false
    return (reply.data?.tools ?? []).some((tool) => tool.function?.name === 'repair_workflow')
  } catch {
    return false
  }
}

/** Run `pnpm build` in this repo, inheriting stdio so the output stays visible. */
function runBuild() {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['build'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** The first human-readable thing a failed generation left behind. */
function firstReason(result) {
  const workflow = result?.workflow
  if (workflow && !workflow.saved) return 'the draft never composed into a saved workflow'
  if (workflow && !(workflow.nodeCount > 0)) return 'the saved graph has no nodes'
  return result?.answer ? String(result.answer).slice(0, 200) : undefined
}

function stamp() {
  return new Date().toISOString().slice(11, 19)
}

function die(code, message) {
  console.error(`selftest: ${message}`)
  report.verdict = { pass: false, stage: 'harness', reason: message }
  process.exitCode = code
  throw new Error(message)
}

async function writeReport() {
  try {
    await mkdir(path.dirname(options.report), { recursive: true })
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error(`selftest: could not write the report — ${error.message}`)
  }
}

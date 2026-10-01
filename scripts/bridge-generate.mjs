#!/usr/bin/env node
/**
 * Drive workflow GENERATION through the extension's local-agent bridge, with no
 * side panel in the loop.
 *
 * The bridge already runs single tool calls and full-auto turns; generation was
 * the one mode reachable only from the Chat mode selector. `generate_workflow`
 * closes that gap, and because a generation turn outlasts the adapter's response
 * timeout it is a start/poll pair — which is exactly what this script does:
 *
 *   node scripts/bridge-generate.mjs --check                # bridge reachable?
 *   node scripts/bridge-generate.mjs "<the user's goal>"    # generate, save, report
 *   node scripts/bridge-generate.mjs --verify <workflowId>  # replay a saved graph
 *   node scripts/bridge-generate.mjs --poll <conversationId> # reattach to a live run
 *
 * It connects as an agent client to the adapter's WS port (the extension dials
 * OUT to that port as the plugin), so the adapter process must be running and the
 * local-agent bridge enabled in the extension settings. Whatever the generated
 * steps do to the page is what a real run does — the write boundary is the user's
 * goal, so a goal that ends at a draft is what this should be pointed at.
 */
import process from 'node:process'
import { connectBridge, unwrapReply } from './bridge-client.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const USAGE =
  'usage: node scripts/bridge-generate.mjs [--check | <goal> | --verify <workflowId> | --poll <conversationId>] [--interval 5] [--timeout 5400] [--budget 300]'

const options = {
  check: false,
  pollId: '',
  verifyId: '',
  intervalMs: 5_000,
  // A real complex goal (read a README, generate copy, draw 3 images, fill a
  // form, save a draft) measured 36min end to end, so the default has to leave
  // room for that — the client gives up long before the run does otherwise, and
  // a run that outlives its client is only recoverable through --poll.
  timeoutMs: 90 * 60_000,
  // Replay budget for --verify, in seconds. 0 leaves the extension's default.
  budgetS: 0,
  goal: '',
}
const argv = process.argv.slice(2)
while (argv.length > 0) {
  const arg = String(argv.shift())
  if (arg === '--check') options.check = true
  else if (arg === '--poll') options.pollId = String(argv.shift())
  else if (arg === '--verify') options.verifyId = String(argv.shift())
  else if (arg === '--interval') options.intervalMs = Number(argv.shift()) * 1000
  else if (arg === '--timeout') options.timeoutMs = Number(argv.shift()) * 1000
  else if (arg === '--budget') options.budgetS = Number(argv.shift())
  else if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  } else if (arg.startsWith('-')) die(`unknown flag ${arg}`)
  else options.goal = options.goal ? `${options.goal} ${arg}` : arg
}

if (!options.check && !options.pollId && !options.verifyId && options.goal === '')
  die('a goal is required')
if (!Number.isFinite(options.intervalMs) || !Number.isFinite(options.timeoutMs))
  die('--interval and --timeout take seconds')

const conn = await connectBridge({ agentName: 'bridge-generate@browser-copilot' })
try {
  if (options.check) {
    const names = unwrap(await conn.request({ type: 'tools.list' })).tools.map(
      (tool) => tool.function.name,
    )
    const missing = ['generate_workflow', 'verify_workflow'].filter((name) => !names.includes(name))
    console.log(
      missing.length === 0
        ? `plugin connected · ${names.length} tools · generate_workflow + verify_workflow advertised`
        : `plugin connected · ${names.length} tools · MISSING ${missing.join(', ')} (extension not reloaded from the new build?)`,
    )
    process.exitCode = missing.length === 0 ? 0 : 1
  } else {
    await run(conn)
  }
} finally {
  conn.close()
}

/**
 * Start (or reattach to) one long run and print its verdict.
 *
 * Generation and verification are the same protocol over two tool names, so the
 * poller is shared: --poll reattaches to a run that is already going, because the
 * run lives in the extension, not in this process, and a client that gave up (or
 * was killed) can pick the same run back up by its conversationId.
 */
async function run(client) {
  const tool =
    options.verifyId || options.pollId.startsWith('external-verify:')
      ? 'verify_workflow'
      : 'generate_workflow'
  const startArgs = options.verifyId
    ? {
        workflowId: options.verifyId,
        ...(options.budgetS > 0 ? { budgetMs: options.budgetS * 1000 } : {}),
      }
    : { prompt: options.goal }
  const started = options.pollId
    ? { conversationId: options.pollId }
    : unwrap(await client.request({ type: 'tool', tool, args: startArgs }))
  if (typeof started?.conversationId !== 'string')
    die(`no conversationId in reply: ${JSON.stringify(started)}`)
  console.log(started.conversationId)

  const deadline = Date.now() + options.timeoutMs
  let reported = -1
  while (Date.now() < deadline) {
    await sleep(options.intervalMs)
    const status = unwrap(
      await client.request({
        type: 'tool',
        tool,
        args: { conversationId: started.conversationId },
      }),
    )
    if (status?.status === 'unknown') die(`the extension no longer knows ${started.conversationId}`)
    if (status?.status === 'running') {
      if (status.nodes !== reported) {
        reported = status.nodes
        console.log(`  ${status.nodes} node(s) · ${Math.round(status.elapsedMs / 1000)}s`)
      } else {
        console.log(`  · ${Math.round(status.elapsedMs / 1000)}s`)
      }
      continue
    }
    console.log(JSON.stringify(status?.result, null, 2))
    process.exitCode = status?.result?.ok ? 0 : 1
    return
  }
  die(
    `no verdict within ${Math.round(options.timeoutMs / 60_000)}min; the run is still going — reattach with --poll ${started.conversationId}`,
  )
}

function unwrap(reply) {
  try {
    return unwrapReply(reply)
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }
}

function die(message) {
  console.error(`bridge-generate: ${message}`)
  process.exit(1)
}

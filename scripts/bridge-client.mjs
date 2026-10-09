/**
 * Shared client for the extension's local-agent bridge.
 *
 * The MV3 service worker dials OUT to the adapter (`public/mcp-server.mjs`,
 * loopback WebSocket), so a script like this one connects as an agent CLIENT and
 * the plugin answers. Both `bridge-generate.mjs` (one run, human-readable) and
 * `selftest.mjs` (build → reload → generate → replay, machine-readable) speak
 * the same protocol, so the protocol lives here once — two copies of a wire
 * format is how a script ends up talking to a build it no longer tests.
 *
 * @module scripts/bridge-client
 */
import process from 'node:process'

/** Adapter port; the extension's `localAgentUrl` must point at the same host. */
export const DEFAULT_BRIDGE_PORT = Number(process.env.BC_BRIDGE_PORT ?? 8765)
/** Per-request timeout. Long runs are start/poll pairs, never awaited here. */
export const REQUEST_TIMEOUT_MS = 30_000

/** A reply the bridge answered with `{ok:false}` — the plugin refused or failed. */
export class BridgeRefusedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeRefusedError'
  }
}

/** Unwrap one reply envelope, throwing {@link BridgeRefusedError} on refusal. */
export function unwrapReply(reply) {
  if (!reply?.ok) throw new BridgeRefusedError(reply?.error ?? 'the bridge refused the call')
  return reply.data
}

/**
 * Open one connection to the adapter.
 *
 * @returns a client with `request(payload, timeoutMs?)` resolving the RAW reply
 *   envelope — refusal is information for a poller, not an error to crash on —
 *   plus `call()` for the cases where a refusal should throw, and `close()`.
 */
export function connectBridge({
  port = DEFAULT_BRIDGE_PORT,
  agentId = process.env.BC_BRIDGE_AGENT_ID ?? `cli-${process.pid}`,
  agentName = process.env.BC_BRIDGE_AGENT_NAME ?? 'cli@browser-copilot',
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const pending = new Map()
    let seq = 0

    const settle = (id, value) => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.res(value)
    }

    ws.addEventListener(
      'open',
      () => {
        resolve({
          request(payload, timeoutMs = requestTimeoutMs) {
            return new Promise((res, rej) => {
              const id = `cli-${++seq}`
              const timer = setTimeout(() => {
                pending.delete(id)
                rej(new Error(`no reply to ${payload.type} (${id}) within ${timeoutMs}ms`))
              }, timeoutMs)
              pending.set(id, { res, rej, timer })
              ws.send(JSON.stringify({ id, agentId, agentName, ...payload }))
            })
          },
          call(payload, timeoutMs) {
            return this.request(payload, timeoutMs).then(unwrapReply)
          },
          close() {
            ws.close()
          },
        })
      },
      { once: true },
    )
    ws.addEventListener('message', (event) => {
      let reply
      try {
        reply = JSON.parse(event.data)
      } catch {
        return
      }
      if (reply?.id) settle(reply.id, reply)
    })
    ws.addEventListener('error', () => {
      reject(
        new Error(
          `cannot reach the adapter on ws://127.0.0.1:${port} — is it running (node public/mcp-server.mjs), and is the local-agent bridge enabled in the extension?`,
        ),
      )
    })
    ws.addEventListener('close', () => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.rej(new Error(`lost the adapter connection on ws://127.0.0.1:${port}`))
      }
      pending.clear()
    })
  })
}

/** Poll a zero-cost probe until the plugin answers, or give up. */
export async function waitForPlugin(
  client,
  { timeoutMs = 150_000, intervalMs = 3_000, log = () => {} } = {},
) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    try {
      const reply = await client.request({ type: 'tools.list' }, 10_000)
      if (reply?.ok) {
        const names = reply.data?.tools?.map((tool) => tool.function.name) ?? []
        log(`  bridge answered after ${attempt} attempt(s); ${names.length} tool(s) advertised`)
        return { ok: true, toolNames: names, build: reply.data?.build ?? '', attempts: attempt }
      }
      log(`  not up yet (${String(reply?.error ?? '').slice(0, 80)})`)
    } catch (error) {
      log(`  not up yet (${error instanceof Error ? error.message : String(error)})`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { ok: false, toolNames: [], build: '', attempts: attempt }
}

/**
 * Wait until the plugin reports it is running BUILD `stamp`.
 *
 * A reload the human triggered is invisible to a script — until the extension
 * reports the hash of the sources it loaded. So instead of dying and asking for a
 * second command, the caller states what it wants and this resolves the moment
 * whoever is at the browser clicks reload. A build older than the stamp is also
 * detected, which is the case `--ack-reload` used to have to take on trust.
 */
export async function waitForBuild(
  client,
  stamp,
  { timeoutMs = 30 * 60_000, intervalMs = 3_000, log = () => {} } = {},
) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  let reported = ''
  let untracked = 0
  while (Date.now() < deadline) {
    try {
      const reply = await client.request({ type: 'tools.list' }, 10_000)
      last = reply?.ok ? (reply.data?.build ?? '') : ''
      if (last === stamp) return { ok: true, build: last }
      if (last === '') {
        // The bridge answers, but says nothing about its build: the loaded
        // extension predates the stamp. Still worth waiting for — the moment it
        // reloads, the stamp appears.
        untracked += 1
        if (untracked === 1)
          log(`  browser is up but reports no build stamp; still waiting for ${stamp}`)
      } else if (last !== reported) {
        reported = last
        log(`  browser runs build ${last}, not ${stamp} — waiting for a reload`)
      }
    } catch {
      last = ''
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { ok: false, build: last, untracked }
}

/**
 * Ask the bridge whether the plugin is still there, and name the cause of a
 * run that stopped answering.
 *
 * "no verdict" and "the extension no longer knows this run" have three very
 * different causes, and telling them apart decides whether a human has to
 * restart a browser: a run still going, a service worker that DIED mid-run
 * (this project has done that by outgrowing a storage key), and a worker that
 * restarted and lost its in-memory run map. Zero-cost to ask — the adapter
 * answers `tools.list` itself — and the answer is the difference between a
 * reattach and a restart.
 */
export async function explainSilence(client, conversationId = '') {
  let probe
  try {
    probe = await client.request({ type: 'tools.list' }, 10_000)
  } catch (error) {
    return `the adapter is unreachable (${error instanceof Error ? error.message : String(error)}) — the bridge process, not the extension, is the broken half`
  }
  if (probe?.ok !== true)
    return (
      'the extension service worker is GONE — it died during the run, so nothing is reattachable. ' +
      'A worker that dies mid-run in this project has historically been outgrown by a storage key ' +
      '(see the [fs-outbox] warn in chrome://extensions → Inspect views). Quit and restart the browser: ' +
      'an unpacked extension is re-read from disk, so the restart installs the current build too.' +
      (String(probe?.error ?? '').includes('未连接')
        ? ''
        : ` It refused with: ${String(probe?.error ?? 'unknown')}`)
    )
  return `the worker answers, but does not know run ${conversationId || '(none)'} — it restarted during the run (build ${probe.data?.build || 'unreported'}); the work it was doing is gone from memory, so re-generate rather than reattach`
}

/**
 * Drive one start/poll pair over the bridge.
 *
 * `generate_workflow`, `verify_workflow` and `repair_workflow` all outlive a
 * single request, so each is a tool that STARTS a run (returning a
 * `conversationId`) and is called again with that id to READ the run. Every real
 * generation or replay ends up here. A run that stops answering is diagnosed by
 * {@link explainSilence} rather than reported as a bare timeout.
 */
export async function pollRun(
  client,
  { tool, startArgs, conversationId, intervalMs = 10_000, timeoutMs, log = () => {} },
) {
  const started = conversationId
    ? { conversationId }
    : unwrapReply(await client.request({ type: 'tool', tool, args: startArgs }))
  if (typeof started?.conversationId !== 'string')
    throw new Error(`no conversationId in reply: ${JSON.stringify(started)}`)
  log(`  ${tool} run ${started.conversationId}`)

  const deadline = Date.now() + timeoutMs
  let reported = -1
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    let status
    try {
      status = unwrapReply(
        await client.request({
          type: 'tool',
          tool,
          args: { conversationId: started.conversationId },
        }),
      )
    } catch (error) {
      // The bridge itself refused the poll — the run has no one left to report to.
      throw new Error(
        `${tool} run ${started.conversationId} went silent: ${await explainSilence(
          client,
          started.conversationId,
        )}`,
        { cause: error },
      )
    }
    if (status?.status === 'unknown')
      throw new Error(
        `the extension no longer knows ${started.conversationId}: ${await explainSilence(client, started.conversationId)}`,
      )
    if (status?.status === 'running') {
      if (status.nodes !== reported) {
        reported = status.nodes
        log(`  ${status.nodes} node(s) · ${Math.round(status.elapsedMs / 1000)}s`)
      }
      continue
    }
    return {
      conversationId: started.conversationId,
      status,
      elapsedMs: Date.now() - (deadline - timeoutMs),
    }
  }
  // One last poll before blaming the timeout: a run that still reports as going
  // is a different problem from a run whose reporter has vanished.
  let final
  try {
    final = unwrapReply(
      await client.request({
        type: 'tool',
        tool,
        args: { conversationId: started.conversationId },
      }),
    )
  } catch {
    final = null
  }
  if (final?.status === 'running')
    throw new Error(
      `no verdict within ${Math.round(timeoutMs / 60_000)}min; ${tool} run ${started.conversationId} is still going (${final.nodes} node(s) at ${Math.round((final.elapsedMs ?? 0) / 1000)}s) — reattach with it`,
    )
  throw new Error(
    `no verdict within ${Math.round(timeoutMs / 60_000)}min; ${await explainSilence(client, started.conversationId)}`,
  )
}

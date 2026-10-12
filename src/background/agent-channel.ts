/**
 * Live turn channels for the agent port.
 *
 * A chat turn outlives the panel that started it: collapsing or minimizing the
 * side panel closes its document, which disconnects the port
 * (`background/panel-minimize` documents that), while the service worker keeps
 * the turn running. If the turn's output stayed a closure over that first port,
 * every later `delta` / `tool.*` / `status` would be posted into a dead port and
 * a reopened panel would sit on a frozen snapshot until the turn ended.
 *
 * So the turn writes to a channel instead, and the channel's `sink` is the
 * currently-watching port — swapped when a panel resumes the conversation. The
 * channel also owns the interactive request resolvers (confirm / ask_user /
 * plan), which must not die with the port either, and a small buffer of the
 * display events emitted since the last transcript change, so a reopened panel
 * can be shown the part of the round it missed.
 *
 * Module scope is disposable on purpose, like the `activeTurns` set it replaces:
 * a worker eviction ends every turn, so an empty registry is the correct state
 * after a restart.
 *
 * Lives in its own module so tests can exercise the routing without importing
 * the service worker entry point, which registers listeners as an import side
 * effect (same rationale as `background/restore`).
 *
 * @module background/agent-channel
 */

import type { AgentServerMessage, TurnTokenUsage } from '../lib/messages'
import type { WireMessage } from '../lib/llm'

/** Posts one message to whichever panel is currently watching a turn. */
export type PanelSink = (message: AgentServerMessage) => void

/**
 * Opaque identity of the connection a sink writes to. A `chrome.runtime.Port`
 * satisfies it; kept structural so this module stays host-agnostic and testable.
 */
export type PanelOwner = object

/** The answer an `ask_user` card resolves with. */
export type AskUserAnswer = { answer: string; cancelled: boolean }
/** The answer a `present_plan` card resolves with. */
export type PlanDecision = { approved: boolean; feedback?: string }

/**
 * A request waiting on the user: its resolver plus the message that rendered
 * the card. Keeping the message means a panel that reconnects mid-turn gets the
 * question it never saw — a card stuck on a closed connection would otherwise
 * hang the turn for the rest of its life.
 */
interface PendingRequest<Value> {
  message: AgentServerMessage
  resolve: (value: Value) => void
}

/** One in-flight chat turn and the panel that is watching it. */
export interface ChatTurnChannel {
  conversationId: string
  /** Cancels the turn; shared with the running-tasks board so both cancel paths agree. */
  controller: AbortController
  /** Where this turn's stream goes right now. Dumb while no panel watches it. */
  sink: PanelSink
  /** The connection `sink` writes to, or `undefined` when no panel is connected. */
  owner: PanelOwner | undefined
  /**
   * The transcript array the turn mutates in place. `undefined` until the turn
   * has loaded it: a resume before that must fall back to the persisted copy
   * instead of replaying nothing.
   */
  transcript: WireMessage[] | undefined
  /** Requests waiting on the user, keyed by request id. */
  confirmations: Map<string, PendingRequest<boolean>>
  askUsers: Map<string, PendingRequest<AskUserAnswer>>
  plans: Map<string, PendingRequest<PlanDecision>>
  /**
   * Display events emitted after the last transcript change, i.e. the part of
   * the current round the transcript does not contain yet. Replayed to a panel
   * that resumes mid-turn, and dropped as soon as the transcript grows (those
   * events are then inside the replayed transcript).
   */
  replay: AgentServerMessage[]
  /** Transcript length `replay` belongs to; the invalidation check for it. */
  replayLength: number
  /** Latest cumulative usage snapshot, so a reopen can restore the token bar. */
  latestUsage: TurnTokenUsage | undefined
}

const channels = new Map<string, ChatTurnChannel>()

/**
 * Display events worth replaying. `phase` is transient (the panel clears it on
 * the first real content), the terminal `done` / `error` need no replay, and
 * requests waiting on the user are replayed from the pending maps instead, so
 * none of those belong in this buffer.
 */
const REPLAYABLE = new Set(['delta', 'tool.start', 'tool.result', 'status'])

/**
 * Ceiling on the replay buffer. A turn can stream an unbounded answer while no
 * panel watches, so the buffer keeps the newest lines and drops the oldest —
 * losing the head of one paragraph beats growing without bound.
 */
const REPLAY_CAP = 400

const dropSink: PanelSink = () => {}

/** Opens a channel for a turn, or returns `undefined` when one already runs. */
export function openTurnChannel(input: {
  conversationId: string
  controller: AbortController
  sink: PanelSink
  owner: PanelOwner
}): ChatTurnChannel | undefined {
  if (channels.has(input.conversationId)) return undefined
  const channel: ChatTurnChannel = {
    conversationId: input.conversationId,
    controller: input.controller,
    sink: input.sink,
    owner: input.owner,
    transcript: undefined,
    confirmations: new Map(),
    askUsers: new Map(),
    plans: new Map(),
    replay: [],
    replayLength: 0,
    latestUsage: undefined,
  }
  channels.set(input.conversationId, channel)
  return channel
}

/** The running turn of this conversation, if any. */
export function channelFor(conversationId: string): ChatTurnChannel | undefined {
  return channels.get(conversationId)
}

/** Ends the turn: nobody is waiting on it any more, so drop its state. */
export function closeTurnChannel(conversationId: string): void {
  const channel = channels.get(conversationId)
  if (!channel) return
  declineInteractions(channel)
  channel.replay.length = 0
  channel.latestUsage = undefined
  channels.delete(conversationId)
}

/** Hands the channel the live transcript array the turn mutates. */
export function attachTranscript(channel: ChatTurnChannel, history: WireMessage[]): void {
  channel.transcript = history
  channel.replay.length = 0
  channel.replayLength = history.length
}

/**
 * Forwards one message to the watching panel and keeps what a mid-turn reopen
 * would otherwise miss. Called for every message the turn produces — including
 * while no panel is connected, which is the whole point of the buffer.
 */
export function emitToPanel(channel: ChatTurnChannel, message: AgentServerMessage): void {
  pruneReplay(channel)
  if (REPLAYABLE.has(message.type)) {
    channel.replay.push(message)
    if (channel.replay.length > REPLAY_CAP) channel.replay.shift()
  } else if (message.type === 'usage') {
    channel.latestUsage = message.usage
  }
  channel.sink(message)
}

/**
 * Points the turn's stream at a new connection and sends it everything the
 * replayed transcript does not contain yet. `resume` always pairs this with a
 * full `restore` first, and that pairing is what makes repeated reconnects
 * idempotent: the panel replaces its whole view, then gets the tail once.
 */
export function handOff(channel: ChatTurnChannel, sink: PanelSink, owner: PanelOwner): void {
  channel.sink = sink
  channel.owner = owner
  pruneReplay(channel)
  for (const message of [...channel.replay]) sink(message)
  // Cards the turn asked for while no panel was connected: the turn is blocked
  // on them, so a reopened panel has to show them or the task never continues.
  for (const message of pendingRequestMessages(channel)) sink(message)
  // Last, so the token breakdown tags the segment the replay just opened.
  if (channel.latestUsage) sink({ type: 'usage', usage: channel.latestUsage })
}

/** The cards this turn is still waiting on the user to answer. */
function pendingRequestMessages(channel: ChatTurnChannel): AgentServerMessage[] {
  const pending: { message: AgentServerMessage }[] = [
    ...channel.confirmations.values(),
    ...channel.askUsers.values(),
    ...channel.plans.values(),
  ]
  return pending.map((entry) => entry.message)
}

/** The channels whose stream currently goes to `owner`. */
export function channelsOfOwner(owner: PanelOwner): ChatTurnChannel[] {
  const owned: ChatTurnChannel[] = []
  for (const channel of channels.values()) {
    if (channel.owner === owner) owned.push(channel)
  }
  return owned
}

/**
 * A panel went away: the turn keeps running (its answer is worth persisting) and
 * streams into the buffer until someone resumes it.
 *
 * Requests already on screen when the panel closed are declined, keeping the
 * documented behaviour that a card never waits on a connection that is gone. A
 * request raised *while* no panel is connected is the other case: nobody ever saw
 * it, so it stays on the channel and the next `resume` shows it, instead of
 * blocking the turn on a card no one can answer.
 */
export function detachOwner(owner: PanelOwner): void {
  for (const channel of channelsOfOwner(owner)) {
    declineInteractions(channel)
    channel.sink = dropSink
    channel.owner = undefined
  }
}

/** Resolves every request waiting on the user as a negative answer. */
export function declineInteractions(channel: ChatTurnChannel): void {
  for (const entry of channel.confirmations.values()) entry.resolve(false)
  channel.confirmations.clear()
  for (const entry of channel.askUsers.values()) entry.resolve({ answer: '', cancelled: true })
  channel.askUsers.clear()
  for (const entry of channel.plans.values()) entry.resolve({ approved: false })
  channel.plans.clear()
}

/**
 * Asks the panel to approve a tool call and waits for the answer. The card is
 * kept on the channel next to its resolver, so the answer may arrive on a
 * different connection than the one that was shown the card, and a panel that
 * connects later can still be asked.
 */
export function requestConfirmation(
  channel: ChatTurnChannel,
  name: string,
  argsPreview: string,
): Promise<boolean> {
  const requestId = newRequestId()
  return new Promise<boolean>((resolve) => {
    const message = { type: 'confirm.request', requestId, name, argsPreview } as const
    channel.confirmations.set(requestId, { message, resolve })
    emitToPanel(channel, message)
  })
}

/** Asks the panel a clarifying question (`ask_user` tool). */
export function requestAskUser(
  channel: ChatTurnChannel,
  question: string,
  options: { label: string; pros: string; cons: string }[],
): Promise<AskUserAnswer> {
  const requestId = newRequestId()
  return new Promise<AskUserAnswer>((resolve) => {
    const message = { type: 'ask_user.request', requestId, question, options } as const
    channel.askUsers.set(requestId, { message, resolve })
    emitToPanel(channel, message)
  })
}

/** Asks the panel to approve a submitted plan (`present_plan` tool). */
export function requestPlan(
  channel: ChatTurnChannel,
  goal: string,
  steps: { title: string; detail?: string }[],
  risks?: string,
  split?: string,
): Promise<PlanDecision> {
  const requestId = newRequestId()
  return new Promise<PlanDecision>((resolve) => {
    const message = {
      type: 'plan.request',
      requestId,
      goal,
      steps,
      ...(risks ? { risks } : {}),
      ...(split ? { split } : {}),
    } as const
    channel.plans.set(requestId, { message, resolve })
    emitToPanel(channel, message)
  })
}

/**
 * Routes the user's answer to whichever turn asked for it, because the answer
 * arrives on whatever port is connected now. Returns whether a pending request
 * matched, so a stray or already-declined answer is observable.
 */
export function answerConfirmation(requestId: string, approved: boolean): boolean {
  return answerPending((channel) => channel.confirmations, requestId, approved)
}

export function answerAskUser(requestId: string, answer: AskUserAnswer): boolean {
  return answerPending((channel) => channel.askUsers, requestId, answer)
}

export function answerPlan(requestId: string, decision: PlanDecision): boolean {
  return answerPending((channel) => channel.plans, requestId, decision)
}

/** Id for a request the panel answers out of band. */
export function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Settles the pending request this id belongs to, if one is still waiting. */
function answerPending<Value>(
  pick: (channel: ChatTurnChannel) => Map<string, PendingRequest<Value>>,
  requestId: string,
  value: Value,
): boolean {
  for (const channel of channels.values()) {
    const map = pick(channel)
    const entry = map.get(requestId)
    if (!entry) continue
    map.delete(requestId)
    entry.resolve(value)
    return true
  }
  return false
}

/**
 * Drops buffered events a transcript change just made redundant. Checked on
 * every emit and again right before a replay, so a reopen landing between a
 * push and the next event does not reshow what `restore` already carries.
 */
function pruneReplay(channel: ChatTurnChannel): void {
  const length = channel.transcript?.length ?? 0
  if (length === channel.replayLength) return
  channel.replay.length = 0
  channel.replayLength = length
}

/** Test helper: clears every channel. */
export function _resetChannelsForTests(): void {
  channels.clear()
}

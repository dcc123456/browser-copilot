import { afterEach, describe, expect, it } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import type { WireMessage } from '../src/lib/llm'
import {
  _resetChannelsForTests,
  answerAskUser,
  answerConfirmation,
  answerPlan,
  attachTranscript,
  channelFor,
  channelsOfOwner,
  closeTurnChannel,
  declineInteractions,
  detachOwner,
  emitToPanel,
  handOff,
  openTurnChannel,
  queueInterjection,
  requestAskUser,
  requestConfirmation,
  requestPlan,
  takeInterjections,
} from '../src/background/agent-channel'

/**
 * The turn channel: the seam that lets a chat turn outlive the panel port that
 * started it. Pins the contract behind "minimize the side panel mid-task, reopen
 * it, still see live progress": the stream is re-attached to the new connection,
 * the lines emitted while no panel watched are replayed exactly once (never
 * duplicating what the transcript snapshot already carries), and a request
 * waiting on the user follows the stream instead of hanging on a dead port.
 */

interface FakePanel {
  readonly messages: AgentServerMessage[]
  readonly sink: (message: AgentServerMessage) => void
}

/** A connection stands for its panel: one object identity per port. */
interface FakeConnection extends FakePanel {
  readonly owner: object
}

let connectionCount = 0

function fakeConnection(): FakeConnection {
  const messages: AgentServerMessage[] = []
  connectionCount += 1
  return {
    messages,
    owner: { id: `port-${connectionCount}` },
    sink: (message) => {
      messages.push(message)
    },
  }
}

function open(conversationId: string, panel: FakeConnection) {
  const channel = openTurnChannel({
    conversationId,
    controller: new AbortController(),
    sink: panel.sink,
    owner: panel.owner,
  })
  if (!channel) throw new Error(`channel already open: ${conversationId}`)
  return channel
}

/** A stored transcript with `turnCount` alternating user/assistant turns. */
function storedTranscript(turnCount: number): WireMessage[] {
  const history: WireMessage[] = []
  for (let index = 0; index < turnCount; index += 1) {
    history.push(
      index % 2
        ? { role: 'assistant', content: `answer ${index}` }
        : { role: 'user', content: `question ${index}` },
    )
  }
  return history
}

function requestIdsOf(panel: FakeConnection, type: AgentServerMessage['type']): string[] {
  return panel.messages
    .filter((message) => message.type === type)
    .map((message) => (message as { requestId: string }).requestId)
}

afterEach(() => {
  _resetChannelsForTests()
})

describe('turn channel · stream ownership', () => {
  it('allows exactly one running turn per conversation', () => {
    const panel = fakeConnection()
    expect(open('c1', panel)).toBeDefined()
    expect(
      openTurnChannel({
        conversationId: 'c1',
        controller: new AbortController(),
        sink: panel.sink,
        owner: panel.owner,
      }),
    ).toBeUndefined()
    // A different conversation is unaffected.
    expect(
      openTurnChannel({
        conversationId: 'c2',
        controller: new AbortController(),
        sink: panel.sink,
        owner: panel.owner,
      }),
    ).toBeDefined()
  })

  it('streams to the connection that resumed the turn, not the one that started it', () => {
    const born = fakeConnection()
    const reopened = fakeConnection()
    const channel = open('c1', born)

    emitToPanel(channel, { type: 'status', text: 'before' })
    expect(born.messages.map((message) => message.type)).toEqual(['status'])

    // The panel collapsed: the turn runs on, the sink goes dumb, lines buffer.
    detachOwner(born.owner)
    emitToPanel(channel, { type: 'delta', text: 'while closed ' })
    expect(born.messages).toHaveLength(1)

    // A new connection resumes it and gets what it missed, then live lines.
    handOff(channel, reopened.sink, reopened.owner)
    emitToPanel(channel, { type: 'delta', text: 'and now' })
    expect(reopened.messages).toEqual([
      // The whole tail of the round the snapshot does not carry yet, including
      // the line streamed before the collapse: a reopened panel is a fresh
      // document and has seen none of it.
      { type: 'status', text: 'before' },
      { type: 'delta', text: 'while closed ' },
      { type: 'delta', text: 'and now' },
    ])
    // The abandoned connection receives nothing further.
    expect(born.messages).toHaveLength(1)
  })

  it('detaches only the turns still owned by the closing connection', () => {
    const closing = fakeConnection()
    const watching = fakeConnection()
    const left = open('c1', closing)
    const handedOver = open('c2', closing)
    handOff(handedOver, watching.sink, watching.owner)

    detachOwner(closing.owner)

    emitToPanel(left, { type: 'status', text: 'into the buffer' })
    expect(watching.messages).toEqual([])
    // The turn another connection took over keeps streaming there.
    emitToPanel(handedOver, { type: 'status', text: 'still live' })
    expect(watching.messages).toEqual([{ type: 'status', text: 'still live' }])
    expect(channelsOfOwner(watching.owner).map((channel) => channel.conversationId)).toEqual(['c2'])
  })
})

describe('turn channel · replay of what a closed panel missed', () => {
  it('drops buffered lines once the transcript carries them', () => {
    const born = fakeConnection()
    const reopened = fakeConnection()
    const history = storedTranscript(1)
    const channel = open('c1', born)
    attachTranscript(channel, history)

    detachOwner(born.owner)
    // One round streams its answer, then completes and pushes it.
    emitToPanel(channel, { type: 'delta', text: 'round one' })
    history.push({ role: 'assistant', content: 'round one' })
    emitToPanel(channel, { type: 'tool.start', name: 'click' })

    handOff(channel, reopened.sink, reopened.owner)
    // Only the tool line of the current round survives: the text is already in
    // the `restore` snapshot the panel replaces its whole view with.
    expect(reopened.messages).toEqual([{ type: 'tool.start', name: 'click' }])
  })

  it('prunes at reopen too, when the transcript grew with nothing emitted after', () => {
    const born = fakeConnection()
    const reopened = fakeConnection()
    const history = storedTranscript(1)
    const channel = open('c1', born)
    attachTranscript(channel, history)

    detachOwner(born.owner)
    emitToPanel(channel, { type: 'delta', text: 'answer' })
    history.push({ role: 'assistant', content: 'answer' })

    handOff(channel, reopened.sink, reopened.owner)
    expect(reopened.messages).toEqual([])
  })

  it('keeps the newest lines when a long round outgrows the buffer', () => {
    const born = fakeConnection()
    const reopened = fakeConnection()
    const channel = open('c1', born)
    detachOwner(born.owner)

    for (let index = 0; index < 450; index += 1) {
      emitToPanel(channel, { type: 'delta', text: `line ${index}` })
    }

    handOff(channel, reopened.sink, reopened.owner)
    expect(reopened.messages).toHaveLength(400)
    expect(reopened.messages[0]).toEqual({ type: 'delta', text: 'line 50' })
    expect(reopened.messages.at(-1)).toEqual({ type: 'delta', text: 'line 449' })
  })

  it('replays the newest usage snapshot after the buffered lines', () => {
    const born = fakeConnection()
    const reopened = fakeConnection()
    const channel = open('c1', born)
    detachOwner(born.owner)
    const usage = {
      inputTokens: 5,
      outputTokens: 7,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 12,
    }

    emitToPanel(channel, { type: 'delta', text: 'partial' })
    emitToPanel(channel, { type: 'usage', usage })
    emitToPanel(channel, { type: 'usage', usage: { ...usage, outputTokens: 15, totalTokens: 20 } })
    // A transient phase and the end of the turn are not replay material.
    emitToPanel(channel, { type: 'phase', phase: 'thinking' })

    handOff(channel, reopened.sink, reopened.owner)
    expect(reopened.messages.map((message) => message.type)).toEqual(['delta', 'usage'])
    const tail = reopened.messages.at(-1)
    expect(tail && tail.type === 'usage' ? tail.usage.totalTokens : 0).toBe(20)
  })

  it('replays the same tail to repeated reconnects, because each one restores first', () => {
    const born = fakeConnection()
    const first = fakeConnection()
    const second = fakeConnection()
    const channel = open('c1', born)
    detachOwner(born.owner)
    emitToPanel(channel, { type: 'tool.start', name: 'click' })

    handOff(channel, first.sink, first.owner)
    handOff(channel, second.sink, second.owner)
    expect(first.messages).toEqual([{ type: 'tool.start', name: 'click' }])
    expect(second.messages).toEqual([{ type: 'tool.start', name: 'click' }])
  })
})

describe('turn channel · requests waiting on the user', () => {
  it('answers a request over the connection that shows the card', async () => {
    const born = fakeConnection()
    const reopened = fakeConnection()
    const channel = open('c1', born)
    detachOwner(born.owner)

    const approved = requestConfirmation(channel, 'click', '{ target: ".go" }')
    handOff(channel, reopened.sink, reopened.owner)
    // The card reaches the panel that reopened the conversation…
    expect(reopened.messages.map((message) => message.type)).toEqual(['confirm.request'])
    const [requestId] = requestIdsOf(reopened, 'confirm.request')
    if (!requestId) throw new Error('no confirm request')

    expect(answerConfirmation(requestId, true)).toBe(true)
    await expect(approved).resolves.toBe(true)
    // A repeat or unknown answer matches nothing.
    expect(answerConfirmation(requestId, true)).toBe(false)
  })

  it('declines a card that was already on screen when the panel closed', async () => {
    const panel = fakeConnection()
    const reopened = fakeConnection()
    const channel = open('c1', panel)
    const approved = requestConfirmation(channel, 'click', '{}')
    const [requestId] = requestIdsOf(panel, 'confirm.request')
    if (!requestId) throw new Error('no confirm request')

    detachOwner(panel.owner)
    await expect(approved).resolves.toBe(false)
    // It must not silently reappear on the next connection: the answer is spent.
    handOff(channel, reopened.sink, reopened.owner)
    expect(reopened.messages).toEqual([])
    expect(answerConfirmation(requestId, true)).toBe(false)
  })

  it('resolves a pending question as cancelled when its panel closes', async () => {
    const panel = fakeConnection()
    const channel = open('c1', panel)
    const asked = requestAskUser(channel, 'which one?', [{ label: 'a', pros: '', cons: '' }])
    detachOwner(panel.owner)
    await expect(asked).resolves.toEqual({ answer: '', cancelled: true })
  })

  it('rejects a pending plan when the turn is cancelled out from under it', async () => {
    const panel = fakeConnection()
    const channel = open('c1', panel)
    const planned = requestPlan(channel, 'post the note', [{ title: 'step 1' }])
    declineInteractions(channel)
    await expect(planned).resolves.toEqual({ approved: false })
  })

  it('routes each answer to the turn that asked for it', async () => {
    const panel = fakeConnection()
    const first = open('c1', panel)
    const second = open('c2', panel)
    const asked = requestAskUser(first, 'pick', [])
    const planned = requestPlan(second, 'goal', [{ title: 's' }], 'risk note')

    const [askId] = requestIdsOf(panel, 'ask_user.request')
    const [planId] = requestIdsOf(panel, 'plan.request')
    if (!askId || !planId) throw new Error('missing requests')

    expect(answerAskUser(askId, { answer: 'this one', cancelled: false })).toBe(true)
    expect(answerPlan(planId, { approved: false, feedback: 'try again' })).toBe(true)
    await expect(asked).resolves.toEqual({ answer: 'this one', cancelled: false })
    await expect(planned).resolves.toEqual({ approved: false, feedback: 'try again' })
  })
})

describe('turn channel · end of turn', () => {
  it('closes the channel, declines leftovers and forgets the conversation', async () => {
    const panel = fakeConnection()
    const channel = open('c1', panel)
    const asked = requestAskUser(channel, 'still there?', [])
    emitToPanel(channel, { type: 'delta', text: 'tail' })

    closeTurnChannel('c1')

    await expect(asked).resolves.toEqual({ answer: '', cancelled: true })
    // A reopen after the turn ends finds nothing to re-attach to.
    expect(channelFor('c1')).toBeUndefined()
    // The panel is told as well: a card it still shows is dead, and leaving it
    // clickable is how a turn ends up waiting on an answer that goes nowhere.
    expect(panel.messages.map((message) => message.type)).toEqual([
      'ask_user.request',
      'delta',
      'interactions.dismissed',
    ])
  })

  it('announces nothing when there was no card to dismiss', () => {
    const panel = fakeConnection()
    const channel = open('c1', panel)
    emitToPanel(channel, { type: 'delta', text: 'tail' })

    closeTurnChannel('c1')

    expect(panel.messages.map((message) => message.type)).toEqual(['delta'])
  })

  it('starts without a transcript so the resume path falls back to storage', () => {
    const panel = fakeConnection()
    const channel = open('c1', panel)
    // The turn has not loaded the conversation yet: a resume must not replay an
    // empty transcript over the persisted one.
    expect(channel.transcript).toBeUndefined()
    emitToPanel(channel, { type: 'phase', phase: 'preparing' })
    expect(channel.replay).toEqual([])
  })
})

describe('turn channel · supplement queue', () => {
  it('takes the notes of the running turn in arrival order, exactly once', () => {
    const panel = fakeConnection()
    const channel = open('c1', panel)

    expect(queueInterjection('c1', { id: 'n1', text: 'use the second account' })).toBe(true)
    expect(queueInterjection('c1', { id: 'n2', text: 'skip the preview' })).toBe(true)

    expect(channel.interjections.map((note) => note.id)).toEqual(['n1', 'n2'])
    expect(takeInterjections(channel).map((note) => note.text)).toEqual([
      'use the second account',
      'skip the preview',
    ])
    // Draining empties it: a note cannot be injected into two requests.
    expect(takeInterjections(channel)).toEqual([])
  })

  it('refuses a note when no turn is running, so the panel sends it for real', () => {
    expect(queueInterjection('gone', { id: 'n1', text: 'hello' })).toBe(false)
  })
})

describe('turn channel · Stop is scoped to one conversation', () => {
  it('aborts the turn of the conversation it names and leaves the other running', async () => {
    const panel = fakeConnection()
    const stopped = open('c1', panel)
    const running = open('c2', panel)
    const stoppedQuestion = requestAskUser(stopped, 'pick one?', [])
    const runningQuestion = requestAskUser(running, 'still there?', [])

    // What `cancel` does for the conversation on screen.
    const target = channelFor('c1')
    expect(target).toBe(stopped)
    target!.controller.abort()
    declineInteractions(target!)

    await expect(stoppedQuestion).resolves.toEqual({ answer: '', cancelled: true })
    expect(stopped.controller.signal.aborted).toBe(true)
    // The stopped turn leaves nothing waiting on the user.
    expect(stopped.askUsers.size).toBe(0)
    // The other conversation keeps asking: its question is still pending, so the
    // panel can answer it and that turn goes on.
    expect(running.controller.signal.aborted).toBe(false)
    expect([...running.askUsers.keys()]).toHaveLength(1)
    const runningAskId = [...running.askUsers.keys()][0]!
    expect(answerAskUser(runningAskId, { answer: 'keep going', cancelled: false })).toBe(true)
    await expect(runningQuestion).resolves.toEqual({ answer: 'keep going', cancelled: false })
  })
})

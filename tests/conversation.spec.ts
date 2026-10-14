import { describe, expect, it } from 'vitest'
import { trimConversation } from '../src/lib/storage'
import type { WireMessage } from '../src/lib/llm'

const user = (text: string): WireMessage => ({ role: 'user', content: text })
const assistant = (text: string): WireMessage => ({ role: 'assistant', content: text })
const toolCall = (id: string): WireMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'read_current_page', arguments: '{}' } }],
})
const toolResult = (id: string): WireMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: '{}',
})

describe('trimConversation', () => {
  it('leaves a short transcript untouched', () => {
    const messages = [user('a'), assistant('b')]
    expect(trimConversation(messages, 10)).toEqual(messages)
  })

  it('returns the same array identity when no trim is needed', () => {
    const messages = [user('a')]
    expect(trimConversation(messages, 10)).toBe(messages)
  })

  it('keeps every user turn when the window shrinks', () => {
    // User turns are the transcript's spine: they are what the panel renders as
    // message history, so a shrink may only remove assistant/tool turns.
    const messages = [
      user('1'),
      assistant('2'),
      user('3'),
      assistant('4'),
      user('5'),
      assistant('6'),
    ]
    expect(trimConversation(messages, 4)).toEqual([user('1'), user('3'), user('5'), assistant('6')])
  })

  it('spends the rest of the limit on the newest non-user turns', () => {
    const messages = [user('1'), assistant('2'), user('3'), assistant('4')]
    expect(trimConversation(messages, 3)).toEqual([user('1'), user('3'), assistant('4')])
  })

  it('drops a tool round whole rather than stranding its result', () => {
    // Half a round is a request providers reject: an assistant `tool_calls` turn
    // without its result, or a result whose turn is gone.
    const messages = [
      user('q'),
      toolCall('c1'),
      toolResult('c1'),
      toolResult('c2'),
      toolResult('c3'),
      assistant('done'),
    ]
    const trimmed = trimConversation(messages, 2)
    expect(trimmed).toEqual([user('q'), assistant('done')])
    expect(trimmed.every((message) => message.role !== 'tool')).toBe(true)
  })

  it('keeps a round that does not fit the remaining room instead of cutting it', () => {
    const messages = [user('1'), toolCall('c1'), toolResult('c1'), toolResult('c2')]
    expect(trimConversation(messages, 2)).toEqual(messages)
  })

  it('never starts the window on an orphaned tool result', () => {
    // Cutting to the last turns would strand the tool result without its
    // tool_calls turn, which providers reject with a 400.
    const messages = [user('q'), toolCall('c1'), toolResult('c1'), assistant('done')]
    const trimmed = trimConversation(messages, 2)
    expect(trimmed[0]!.role).not.toBe('tool')
    expect(trimmed).toEqual([user('q'), assistant('done')])
  })

  it('handles a transcript that is entirely tool results', () => {
    const messages = [toolResult('a'), toolResult('b')]
    expect(trimConversation(messages, 1)).toEqual([])
  })

  it('handles an empty transcript', () => {
    expect(trimConversation([], 5)).toEqual([])
  })
})

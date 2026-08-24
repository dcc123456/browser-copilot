import { describe, expect, it } from 'vitest'
import { isCommand } from '../src/background/feishu-bot'

describe('isCommand', () => {
  it('recognises review-PR intents in both languages', () => {
    expect(isCommand('帮我统计github中有多少pr需要我review')).toBe(true)
    expect(isCommand('how many PRs need my review')).toBe(true)
    expect(isCommand('review pr')).toBe(true)
  })

  it('recognises generic task-run and status intents', () => {
    expect(isCommand('run task 日报')).toBe(true)
    expect(isCommand('执行任务')).toBe(true)
    expect(isCommand('status')).toBe(true)
    expect(isCommand('状态')).toBe(true)
  })

  it('ignores unrelated chatter', () => {
    expect(isCommand('今天天气怎么样')).toBe(false)
    expect(isCommand('hello there')).toBe(false)
    expect(isCommand('')).toBe(false)
  })
})

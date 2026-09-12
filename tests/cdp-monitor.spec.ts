import { describe, it, expect } from 'vitest'
import {
  summarizePerfNetwork,
  type ConsoleEntry,
  type RequestEntry,
} from '../src/background/cdp-monitor'

const err = (text: string): ConsoleEntry => ({ level: 'error', text, at: 0 })
const warn = (text: string): ConsoleEntry => ({ level: 'warning', text, at: 0 })
const req = (url: string, status?: number, failed = false): RequestEntry => ({
  url,
  method: 'GET',
  ...(status !== undefined ? { status } : {}),
  failed,
  at: 0,
})

describe('summarizePerfNetwork (M2-16)', () => {
  it('reports a healthy page when nothing was captured', () => {
    const s = summarizePerfNetwork([], [])
    expect(s.consoleErrors).toBe(0)
    expect(s.consoleWarnings).toBe(0)
    expect(s.networkFailures).toBe(0)
    expect(s.httpErrors).toBe(0)
    expect(s.text).toContain('均正常')
  })

  it('counts console errors and warnings', () => {
    const s = summarizePerfNetwork([err('boom'), err('bang'), warn('deprecated')], [])
    expect(s.consoleErrors).toBe(2)
    expect(s.consoleWarnings).toBe(1)
    expect(s.text).toContain('2 个控制台错误')
    expect(s.text).toContain('1 个控制台警告')
  })

  it('separates hard network failures from completed HTTP errors', () => {
    const s = summarizePerfNetwork([], [req('a', undefined, true), req('b', 404), req('c', 500)])
    expect(s.networkFailures).toBe(1)
    expect(s.httpErrors).toBe(2)
    expect(s.text).toContain('1 个网络请求失败')
    expect(s.text).toContain('2 个 HTTP 错误(404×1、500×1)')
  })

  it('combines console + network into one line', () => {
    const s = summarizePerfNetwork([err('x')], [req('y', 403)])
    expect(s.text).toContain('1 个控制台错误')
    expect(s.text).toContain('1 个 HTTP 错误(403×1)')
  })
})

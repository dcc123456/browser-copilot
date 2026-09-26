import { describe, expect, it } from 'vitest'
import { inputLimitFromError } from '../src/background/agent'
describe('reactive compaction parses the provider limit', () => {
  it('reads the DashScope 400 input-length bound', () => {
    const message =
      '阿里云百炼 DashScope request failed (400 ): data: {"error":{"code":"invalid_parameter_error","message":"Range of input length should be [1, 983616]"}}'
    expect(inputLimitFromError(message)).toBe(983616)
  })
  it('reads OpenAI-style maximum context length errors', () => {
    expect(inputLimitFromError('maximum context length is 128000 tokens')).toBe(128000)
  })
  it('returns undefined for unrelated errors', () => {
    expect(inputLimitFromError('invalid api key')).toBeUndefined()
  })
})
/**
 * A `{{token}}` substituted into a `javascript-code` block must not break the
 * program it lands in.
 *
 * Interpolation is TEXTUAL: the generated body is `const text = '{{noteContent}}'`
 * and the engine pastes the value between the quotes. So an apostrophe in
 * AI-written copy (`it'll`), a backtick, a `${` or a newline closed the literal
 * mid-sentence and the step died before running one character of its script —
 * `javascript-code: Unexpected identifier 'll'`, in round 6 of the
 * generate→replay harness. During GENERATION the token is still a literal
 * placeholder, so the same node passes its trial run and only fails at replay.
 *
 * The escape is opt-in per parameter: a selector or a form value with an
 * apostrophe must stay verbatim, or the fix would move the bug instead of
 * removing it.
 */
import { describe, expect, it } from 'vitest'
import { escapeForJsLiteral, interpolateParams } from '../src/lib/workflow/interpolate'

/** Run an interpolated `code` param the way the executor's local fallback does. */
function runCode(code: string, returned: string): unknown {
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\nreturn ${returned};`)()
}

describe('escapeForJsLiteral', () => {
  it('neutralises everything that can end a string literal', () => {
    expect(escapeForJsLiteral("it's a ‘test’")).toBe("it\\'s a ‘test’")
    expect(escapeForJsLiteral('a\nb')).toBe('a\\nb')
    expect(escapeForJsLiteral('a\u2028b')).toBe('a\\u2028b')
    expect(escapeForJsLiteral('a\u2029b')).toBe('a\\u2029b')
    expect(escapeForJsLiteral('back`tick ${x}')).toBe('back\\`tick \\${x}')
    expect(escapeForJsLiteral('back\\slash')).toBe('back\\\\slash')
  })

  it('leaves values that cannot break a literal untouched', () => {
    expect(escapeForJsLiteral('42')).toBe('42')
    expect(escapeForJsLiteral('普通标题 content')).toBe('普通标题 content')
  })
})

describe('interpolateParams in a javascript-code body', () => {
  const hostile = "它's 一个「测试」\n第二行 `code` ${notInterp} 结尾"

  it('produces code that still parses and carries the value through', () => {
    const params = interpolateParams(
      { code: "const text = '{{noteContent}}';" },
      { noteContent: hostile },
    )
    const code = String(params['code'])

    expect(code).not.toContain("{{noteContent}}")
    expect(() => runCode(code, 'text')).not.toThrow()
    expect(runCode(code, 'text')).toBe(hostile)
  })

  it('escapes every token inside the body, not just the first', () => {
    const params = interpolateParams(
      { code: "const a = '{{title}}';\nconst b = 'x{{title}}y';" },
      { title: "it'll" },
    )
    const code = String(params['code'])

    expect(runCode(code, 'a')).toBe("it'll")
    expect(runCode(code, 'b')).toBe("xit'lly")
  })

  it('is inert for a value with nothing to escape, so an unquoted token is unchanged', () => {
    const params = interpolateParams({ code: 'const n = {{count}};' }, { count: 12 })
    expect(String(params['code'])).toBe('const n = 12;')
  })

  it('does not touch any other parameter — a selector or a form value stays verbatim', () => {
    const params = interpolateParams(
      { value: 'say {{word}}', selector: "{{cls}}'s a" },
      { word: "it'll", cls: "div.o'b" },
    )
    expect(String(params['value'])).toBe("say it'll")
    expect(String(params['selector'])).toBe("div.o'b's a")
  })

  it('still reports a token no variable answered for', () => {
    const params = interpolateParams({ code: "const t = '{{missing}}';" }, {})
    expect(params['__bcUnresolvedInterp']).toEqual(['missing'])
  })
})

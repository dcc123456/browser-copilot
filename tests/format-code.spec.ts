/**
 * Runtime formatter contract for the javascript-code block editor. Formatting
 * must match `.prettierrc.json` (single quotes, no semicolons, 2-space indent)
 * and must never silently rewrite workflow-specific syntax: automa* helpers,
 * top-level await and `{{variables}}` inside strings.
 */
import { describe, expect, it } from 'vitest'
import { formatJavaScriptCode } from '../src/lib/format-code'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'

describe('format button i18n contract', () => {
  it('has localized copy for the format button in both locales', () => {
    for (const key of [
      'formatCode',
      'formatCodeHint',
      'formatCodeFailed',
      'codeFormatted',
    ] as const) {
      expect(EDITOR_STRINGS.en[key], `en missing ${key}`).toBeTruthy()
      expect(EDITOR_STRINGS.zh[key], `zh missing ${key}`).toBeTruthy()
    }
    expect(EDITOR_STRINGS.zh.formatCode).toBe('格式化')
  })
})

describe('formatJavaScriptCode', () => {
  it('applies the project style to messy code', async () => {
    const out = await formatJavaScriptCode(
      'const x={a:1,b:"two"};\nfunction f(){if(x.a){return  "yes"}else{return "no"}}',
    )
    expect(out).toBe(
      [
        "const x = { a: 1, b: 'two' }",
        'function f() {',
        '  if (x.a) {',
        "    return 'yes'",
        '  } else {',
        "    return 'no'",
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('is idempotent', async () => {
    const source = 'const a = {x:1,y:[1,2,3]}\nconsole.log(  a )'
    const once = await formatJavaScriptCode(source)
    const twice = await formatJavaScriptCode(once)
    expect(twice).toBe(once)
  })

  it('preserves top-level await, automa helpers and {{variable}} strings', async () => {
    const source = [
      'const r = await fetch("/x")',
      'automaSetVariable("v", r.ok)',
      'const s = "{{myVar}}"',
      'console.log( s , r.ok )',
      'automaNextBlock()',
    ].join('\n')
    const out = await formatJavaScriptCode(source)
    expect(out).toContain("const r = await fetch('/x')")
    expect(out).toContain("automaSetVariable('v', r.ok)")
    expect(out).toContain("'{{myVar}}'")
    expect(out).toContain('automaNextBlock()')
    // Still valid JavaScript after formatting (no syntax error).
    await expect(formatJavaScriptCode(out)).resolves.toBe(out)
  })

  it('rejects a syntax error so callers keep the original code', async () => {
    await expect(formatJavaScriptCode('const = ;;;')).rejects.toThrow()
  })

  it('accepts empty input without throwing', async () => {
    expect(await formatJavaScriptCode('')).toBe('')
  })
})

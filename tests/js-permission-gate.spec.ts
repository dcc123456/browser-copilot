import { describe, expect, it } from 'vitest'
import {
  evaluateCapabilityGap,
  evaluateJsPermission,
} from '../src/lib/workflow/capability-gap'

describe('evaluateJsPermission (unified javascript-code gate)', () => {
  const fullGap = {
    missingCapability: 'generate a canvas PNG via toDataURL',
    triedOperators: ['get-text', 'forms', 'event-click'],
    whyInsufficient: 'No declarative operator can draw on a canvas or produce a binary image.',
    expectedResult: 'A data URL string is produced.',
  }

  it('accepts a complete capabilityGap object', () => {
    const result = evaluateJsPermission({
      stepIntent: 'sign the payload with the page internal SDK',
      args: { code: 'automaNextBlock()', capabilityGap: fullGap },
    })
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.justification).toContain('canvas PNG')
      expect(result.justification).toContain('get-text')
    }
  })

  it('accepts a justification without a capabilityGap', () => {
    const result = evaluateJsPermission({
      stepIntent: 'call the page internal SDK to sign a payload',
      args: {
        code: 'automaNextBlock()',
        justification:
          'The signing value needs the page SDK: get-text reads text only, forms fills fields, webhook would call our own server rather than the page API.',
      },
    })
    expect(result.allowed).toBe(true)
  })

  it('refuses a call carrying neither', () => {
    const result = evaluateJsPermission({
      stepIntent: 'call the page internal SDK to sign a payload',
      args: { code: 'automaNextBlock()' },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.error).toContain('capabilityGap')
      expect(result.error).toContain('justification')
    }
  })

  it.each([
    ['missingCapability', { missingCapability: '' }],
    ['triedOperators', { triedOperators: [] }],
    ['whyInsufficient', { whyInsufficient: '' }],
    ['expectedResult', { expectedResult: '' }],
  ])('refuses a partial capabilityGap (%s)', (_field, patch) => {
    const result = evaluateJsPermission({
      stepIntent: 'sign the payload with the page internal SDK',
      args: {
        code: 'automaNextBlock()',
        capabilityGap: { ...fullGap, ...patch },
      },
    })
    expect(result.allowed).toBe(false)
  })

  it('refuses regardless of gap when a native operator covers the intent', () => {
    const result = evaluateJsPermission({
      stepIntent: 'click the submit button',
      args: { code: 'automaNextBlock()', capabilityGap: fullGap },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.nativeBlockIds).toContain('event-click')
  })

  it('still supports evaluateCapabilityGap for the four-field contract', () => {
    const decision = evaluateCapabilityGap({
      stepIntent: 'read encrypted payload inside a closed widget',
      gap: fullGap,
    })
    expect(decision.allowed).toBe(true)
  })
})

describe('sanctioned capability gaps (image / canvas artifacts)', () => {
  const noArguments = { code: "automaNextBlock()" }

  it.each([
    '生成图片并上传到附件控件',
    '用 canvas 绘制图表二维码',
    'generate a chart image and hand it to upload-file',
    '导出海报 dataURL',
    '生成一张小红书封面图',
    '输出图片二进制数据',
    '把变量里的图片链接画到画布上',
  ])('allows %s with neither justification nor capabilityGap', (stepIntent) => {
    const result = evaluateJsPermission({ stepIntent, args: noArguments })
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      // The reason still lands on the node — the user reads why a script exists.
      expect(result.justification).toContain('image-artifact')
      expect(result.justification).toContain('sanctioned capability gap')
    }
  })

  it.each([
    ['a page capture is take-screenshot, not a gap', '截图保存页面并生成图片'],
    ['captcha stays a human gate', '生成验证码图片并识别'],
    ['reading an image is a read, not a production', '读取图片地址'],
    ['no artifact named at all', '生成随机订单号'],
    ['画 inside 计划 is not drawing', '按计划整理附件清单'],
  ])('does not sanction %s', (_label, stepIntent) => {
    const result = evaluateJsPermission({ stepIntent, args: noArguments })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.error).toContain('LAST RESORT')
  })

  it('still refuses a native intent that merely shares words with a gap', () => {
    const result = evaluateJsPermission({
      stepIntent: '点击按钮',
      args: noArguments,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.nativeBlockIds).toContain('event-click')
  })
})

describe('the script body is evidence of an image artifact', () => {
  const drawingCode =
    'const c = document.createElement("canvas"); const ctx = c.getContext("2d");' +
    'ctx.fillText(title, 10, 10); automaNextBlock({ url: c.toDataURL("image/png") })'

  it('sanctions a click-worded description whose script draws an image', () => {
    const result = evaluateJsPermission({
      stepIntent: '点击图片上传入口',
      args: { code: drawingCode },
    })
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.justification).toContain('image-artifact')
  })

  it('still refuses a click-worded description whose script only acts on the page', () => {
    const result = evaluateJsPermission({
      stepIntent: '点击上传图片按钮',
      args: { code: "document.querySelector('.upload').click(); automaNextBlock()" },
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.nativeBlockIds).toContain('event-click')
  })

  it('still vetoes an excluded intent whose script draws an image', () => {
    const result = evaluateJsPermission({
      stepIntent: '生成验证码图片并识别',
      args: { code: drawingCode },
    })
    expect(result.allowed).toBe(false)
  })
})

describe('native intent keywords are word-bounded', () => {
  const noArguments = { code: 'automaNextBlock()' }

  // Unbounded `if`, `tap` and `attribute` used to refuse these as
  // condition/click/attribute intents — the substring, not the intent.
  it.each([
    'notify the user about the result',
    'verify the signature field',
    'adapt the payload to the API',
    'modify the caption text',
  ])('%s is not read as a native operator intent', (stepIntent) => {
    const result = evaluateJsPermission({ stepIntent, args: noArguments })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.error).toContain('LAST RESORT')
      expect(result.nativeBlockIds ?? []).toEqual([])
    }
  })

  it('still recognizes a real native intent in English', () => {
    const result = evaluateJsPermission({ stepIntent: 'fill the coupon form', args: noArguments })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.nativeBlockIds).toContain('forms')
  })
})

/**
 * `get-secret` is for values that must stay secret — and the model has to be told.
 *
 * The reported bug (specs/2026-10-16-get-secret-plain-input-design.md): a generated login
 * workflow fetched the USERNAME through `get-secret`. Nothing about that node is malformed —
 * the credential id resolves, the node runs, the fill works — so no structural check can see
 * it. The two defences are the text the model reads and one liveness warning; both are pinned
 * here so a later edit cannot quietly drop the scope sentence.
 */
import { describe, expect, it } from 'vitest'
import { OPERATOR_GUIDE } from '../src/lib/workflow/operator-guide'
import { operatorToolFromEntry } from '../src/lib/workflow/operator-tools'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import { BLOCK_DESCRIPTIONS_ZH } from '../src/workflow-editor/block-i18n'

describe('get-secret scope: what the model and the user are told', () => {
  const tool = operatorToolFromEntry(BLOCK_BY_ID.get('get-secret')!)

  it('keeps the scope rule inside the tool-description clamp', () => {
    // The catalog sentence is truncated to 160 characters before it becomes a tool
    // description, so a scope rule written at the END would be cut off — the model
    // would keep seeing a pure capability sentence.
    expect(tool.function.description).toContain('must stay secret')
    expect(tool.function.description).toContain('trigger parameter')
  })

  it('states the trade, the sensitive set and the login recipe in the guide', () => {
    expect(OPERATOR_GUIDE).toContain('## 凭证：只有必须保密的值才走 get-secret')
    expect(OPERATOR_GUIDE).toContain('只对密码 / token / 验证码 / API key 用它')
    expect(OPERATOR_GUIDE).toContain('用户名、邮箱、搜索词、URL 这类不敏感输入直接写 value')
    expect(OPERATOR_GUIDE).toContain('只有密码用 get-secret')
    // The chat-typed-credential rule kept its own sentence in the same section:
    // two credential rules, one place, no duplicate paragraph.
    expect(OPERATOR_GUIDE).toContain('生成引擎把它收成触发器里的密文输入')
  })

  it('mirrors the same scope in the editor palette (zh)', () => {
    expect(BLOCK_DESCRIPTIONS_ZH['get-secret']).toContain('只用于绝不能写进工作流的敏感值')
    expect(BLOCK_DESCRIPTIONS_ZH['get-secret']).toContain('触发器参数')
  })
})

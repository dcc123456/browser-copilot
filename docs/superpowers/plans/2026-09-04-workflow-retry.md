# 工作流失败重试（循环语义补齐）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐工作流引擎的循环语义——循环块迭代结束后继续走 "end" 分支、`loop-breakpoint` 块真正跳出循环——使"整组步骤失败重试（如登录 + 验证码，最多 5 次）"用现有块即可搭建。

**Architecture:** 全部改动集中在纯函数引擎层 `engine.ts`（循环出口解析 + 断点哨兵捕获）与 `executors.ts`（断点块执行器抛哨兵）。哨兵类放独立模块 `loop-breakpoint.ts`，避免 engine↔executors 循环依赖。编辑器无需改动（循环块已有 loop/end 双出口，断点块 `disableEdit:true`）。

**Tech Stack:** TypeScript、Vitest（测试）、pnpm。设计文档：`docs/superpowers/specs/2026-09-04-workflow-retry-design.md`。

**分支策略:** 直接在当前分支（main）实施，与仓库现有习惯一致；每个 Task 结束提交一次。

**验证命令约定:** 单文件测试用 `pnpm exec vitest run <file>`；全量用 `pnpm run test`（CI 形态，跑完退出）与 `pnpm run typecheck`。

---

## 文件结构

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `src/background/workflow-engine/loop-breakpoint.ts` | `LoopBreakpointError` 哨兵类（引擎与执行器共用，避免循环依赖） |
| 修改 | `src/background/workflow-engine/engine.ts` | 循环块出口解析（body/end 按句柄语义）、`runLoop` 收尾走 end、断点捕获（`runLoopBody`）、顶层 benign 兜底、runNode 放行哨兵 |
| 修改 | `src/background/workflow-engine/executors.ts` | `'loop-breakpoint'` 从 `noop` 换成抛哨兵的真执行器 |
| 修改 | `tests/workflow-phase4.spec.ts` | 新增两个 describe：end 分支（参数化 4 种循环块 + 0 次迭代 + 连线顺序回归）、loop-breakpoint（5 个用例） |
| 修改 | `README.md` / `README.zh-CN.md` | Workflows 章节新增"失败重试"小节（单块重试 vs 整组重试 + 登录示例图） |

不改动：编辑器（`BlockNode.tsx` 已渲染 loop/end 双出口；`loop-breakpoint` 目录项 `disableEdit: true` 无表单）、其余全部执行器。

---

### Task 1: 循环块迭代结束后走 "end" 分支

**Files:**
- Modify: `src/background/workflow-engine/engine.ts:374-379`（runNode 循环块分发）、`engine.ts:501-580`（runLoop 四个分支）
- Test: `tests/workflow-phase4.spec.ts`（文件末尾追加 describe）

- [ ] **Step 1: 写失败测试**

在 `tests/workflow-phase4.spec.ts` 文件末尾（现有最后一个 `describe` 之后）追加：

```ts
describe('workflow loops — after-loop "end" branch', () => {
  const CASES: Array<{ blockId: string; data: Record<string, unknown>; vars?: Record<string, unknown> }> = [
    { blockId: 'loop-data', data: { data: '[1,2]' } },
    { blockId: 'repeat-task', data: { count: 2 } },
    { blockId: 'while-loop', data: { code: 'vars.n < 2' }, vars: { n: 0 } },
    { blockId: 'loop-elements', data: { count: 2 } },
  ]

  it.each(CASES)('$blockId runs the end branch once after iterations finish', async ({ blockId, data, vars }) => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', blockId, data),
        node('body', 'body'),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'body', `${blockId}-output-1`),
        edge('body', 'loop'),
        edge('loop', 'after', `${blockId}-output-2`),
      ],
    )
    const result = await runWorkflow(wf, {
      variables: { ...(vars ?? {}) },
      executors: {
        ...EXECUTORS,
        body: async (_d, ctx) => {
          seen.push('body')
          if (blockId === 'while-loop') {
            ctx.variables['n'] = Number(ctx.variables['n'] ?? 0) + 1
          }
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['body', 'body', 'after'])
  })

  it('while-loop with an immediately-false condition goes straight to the end branch', async () => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'while-loop', { code: 'false' }),
        node('body', 'body'),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'body', 'while-loop-output-1'),
        edge('body', 'loop'),
        edge('loop', 'after', 'while-loop-output-2'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        body: async () => {
          seen.push('body')
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['after'])
  })

  it('resolves body/end by handle semantics even when the end edge was connected first', async () => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'repeat-task', { count: 2 }),
        node('body', 'body'),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'after', 'repeat-task-output-2'),
        edge('loop', 'body', 'repeat-task-output-1'),
        edge('body', 'loop'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        body: async () => {
          seen.push('body')
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['body', 'body', 'after'])
  })
})
```

说明：`node`/`edge`/`makeWorkflow` 是该 spec 文件第 60-88 行已有的模块级辅助函数，直接复用。句柄命名 `${blockId}-output-1/-output-2` 与编辑器保存格式一致（引擎据此映射 `outputs['loop']`/`outputs['end']`）。

- [ ] **Step 2: 运行测试确认失败**

```
pnpm exec vitest run tests/workflow-phase4.spec.ts
```

预期：新增用例全部 FAIL——参数化用例收到 `['body', 'body']`（缺 `'after'`）；0 次迭代用例收到 `[]`；连线顺序用例收到 `['after', 'after']`。原有用例全部 PASS。

- [ ] **Step 3: 实现 engine.ts 修改**

3a. `engine.ts:374-379`，把循环块分发：

```ts
    // Loop and sub-workflow blocks are handled by the engine itself, not by an
    // executor in the registry, so sub-runs and loop bodies recurse here too.
    if (LOOP_BLOCK_IDS.has(blockId)) {
      completedNodeIds.push(nodeId)
      return runLoop(current, params, defaultNext)
    }
```

替换为：

```ts
    // Loop and sub-workflow blocks are handled by the engine itself, not by an
    // executor in the registry, so sub-runs and loop bodies recurse here too.
    // Body entry / after-loop exit resolve by handle semantics, not edge
    // order: `loop` (output-1) starts the body, `end` (output-2) runs once
    // after the loop finishes. A bare unlabeled edge still works as the body
    // (legacy / programmatic graphs), but only when no end edge exists.
    if (LOOP_BLOCK_IDS.has(blockId)) {
      completedNodeIds.push(nodeId)
      const endId = outputs['end'] ?? outputs['output-2'] ?? null
      const bodyStart = outputs['loop'] ?? outputs['output-1'] ?? (endId === null ? defaultNext : null)
      return runLoop(current, params, bodyStart, endId)
    }
```

3b. `engine.ts:501-506`，`runLoop` 签名加 `endId` 参数：

```ts
  async function runLoop(
    loopNode: WorkflowNode,
    params: Record<string, unknown>,
    startId: string | null,
  ): Promise<string | null> {
```

替换为：

```ts
  async function runLoop(
    loopNode: WorkflowNode,
    params: Record<string, unknown>,
    startId: string | null,
    endId: string | null,
  ): Promise<string | null> {
```

3c. `runLoop` 内四个分支的收尾：把每个分支的 `if (startId === null) return null` 改为 `if (startId === null) return endId`，把分支末尾的 `return null` 改为 `return endId`。四个分支共 8 处，逐处替换：

- `loop-data` 分支（约 517-526 行）：`emit('status', loopNode.id, `开始循环，共 ${items.length} 项`)` 之后的 `if (startId === null) return null` → `if (startId === null) return endId`；该分支最后的 `return null` → `return endId`。
- `repeat-task` 分支（约 529-539 行）：`if (startId === null) return null` → `if (startId === null) return endId`；分支最后的 `return null` → `return endId`。
- `while-loop` 分支（约 541-560 行）：`if (startId === null) return null` → `if (startId === null) return endId`；该分支 while 循环之后的 `return null` → `return endId`。注意分支内 `if (++iterations > MAX_WHILE_ITERATIONS)` 的超限失败路径 `return null` **保持不变**。
- `loop-elements` 分支（约 562-579 行）：`if (startId === null) return null` → `if (startId === null) return endId`；分支最后的 `return null` → `return endId`。

迭代中途失败路径（各分支的 `if (outcome !== 'ok') return null`）**全部保持不变**。

- [ ] **Step 4: 运行测试确认通过**

```
pnpm exec vitest run tests/workflow-phase4.spec.ts tests/workflow-engine.spec.ts
```

预期：全部 PASS（含既有 loop-data / repeat-task / while-loop / loop-elements 用例——它们用无句柄单边连线，`endId === null` 分支保持原行为）。

- [ ] **Step 5: 提交**

```bash
git add src/background/workflow-engine/engine.ts tests/workflow-phase4.spec.ts
git commit -m "feat(workflow): 循环块迭代结束后继续执行 end 分支"
```

---

### Task 2: 实现 loop-breakpoint（提前跳出循环）

**Files:**
- Create: `src/background/workflow-engine/loop-breakpoint.ts`
- Modify: `src/background/workflow-engine/executors.ts:1821` 附近（新执行器）、`executors.ts:1915`（注册表）
- Modify: `src/background/workflow-engine/engine.ts`（runNode catch 放行、`runLoopBody` 助手、四个分支调用点、顶层 catch）
- Test: `tests/workflow-phase4.spec.ts`（文件末尾追加 describe）

- [ ] **Step 1: 写失败测试**

在 `tests/workflow-phase4.spec.ts` 文件末尾追加：

```ts
describe('workflow loops — loop-breakpoint', () => {
  /** Single loop + body `a` → breakpoint → end branch `after`. */
  const singleLoopGraph = (bpData: Record<string, unknown> = {}) =>
    makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'repeat-task', { count: 5 }),
        node('a', 'a'),
        node('bp', 'loop-breakpoint', bpData),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'a', 'repeat-task-output-1'),
        edge('a', 'bp'),
        edge('loop', 'after', 'repeat-task-output-2'),
      ],
    )

  const pushTo = (seen: string[], label: string) => async () => {
    seen.push(label)
    return null
  }

  it('breaks the loop early and continues from the end branch', async () => {
    const seen: string[] = []
    const result = await runWorkflow(singleLoopGraph(), {
      executors: {
        ...EXECUTORS,
        a: pushTo(seen, 'a'),
        after: pushTo(seen, 'after'),
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['a', 'after'])
  })

  it('is not swallowed by its own onError retry policy', async () => {
    const seen: string[] = []
    const steps: string[] = []
    const result = await runWorkflow(
      singleLoopGraph({
        onError: { enable: true, toDo: 'retry', retryTimes: 3, retryInterval: 0 },
      }),
      {
        onStep: (_k, _id, text) => steps.push(text),
        executors: {
          ...EXECUTORS,
          a: pushTo(seen, 'a'),
          after: pushTo(seen, 'after'),
        },
      },
    )
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['a', 'after'])
    expect(steps.some((s) => s.includes('Retrying'))).toBe(false)
  })

  it('breaks only the innermost loop by default; the outer loop continues', async () => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('outer', 'repeat-task', { count: 2 }),
        node('inner', 'repeat-task', { count: 2 }),
        node('a', 'a'),
        node('bp', 'loop-breakpoint'),
        node('b', 'b'),
        node('after', 'after'),
      ],
      [
        edge('t', 'outer'),
        edge('outer', 'inner', 'repeat-task-output-1'),
        edge('inner', 'a', 'repeat-task-output-1'),
        edge('a', 'bp'),
        edge('inner', 'b', 'repeat-task-output-2'),
        edge('b', 'outer'),
        edge('outer', 'after', 'repeat-task-output-2'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        a: async () => {
          seen.push('a')
          return null
        },
        b: async () => {
          seen.push('b')
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['a', 'b', 'a', 'b', 'after'])
  })

  it('breaks the outer loop when the breakpoint carries a matching loopId', async () => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('outer', 'repeat-task', { count: 2 }),
        node('inner', 'repeat-task', { count: 2 }),
        node('a', 'a'),
        node('bp', 'loop-breakpoint', { loopId: 'outer' }),
        node('b', 'b'),
        node('after', 'after'),
      ],
      [
        edge('t', 'outer'),
        edge('outer', 'inner', 'repeat-task-output-1'),
        edge('inner', 'a', 'repeat-task-output-1'),
        edge('a', 'bp'),
        edge('inner', 'b', 'repeat-task-output-2'),
        edge('b', 'outer'),
        edge('outer', 'after', 'repeat-task-output-2'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        a: async () => {
          seen.push('a')
          return null
        },
        b: async () => {
          seen.push('b')
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['a', 'after'])
  })

  it('outside any loop it is benign: run ends ok with an info note', async () => {
    const seen: string[] = []
    const steps: Array<{ kind: string; text: string }> = []
    const wf = makeWorkflow(
      [node('t', 'manual'), node('bp', 'loop-breakpoint'), node('after', 'after')],
      [edge('t', 'bp'), edge('bp', 'after')],
    )
    const result = await runWorkflow(wf, {
      onStep: (kind, _id, text) => steps.push({ kind, text }),
      executors: {
        ...EXECUTORS,
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(seen).toEqual([])
    expect(steps.some((s) => s.kind === 'info' && s.text.includes('不在循环内'))).toBe(true)
  })
})
```

说明：`singleLoopGraph` 复用文件里已有的 `makeWorkflow`/`node`/`edge` 辅助函数；`pushTo` 只是让 trace 断言更简洁。嵌套循环与循环外用例各自内联建图，不依赖该助手。

- [ ] **Step 2: 运行测试确认失败**

```
pnpm exec vitest run tests/workflow-phase4.spec.ts
```

预期：新增 5 个用例 FAIL——提前跳出用例收到 `['a','a','a','a','a']`（noop 断点不跳出、after 永远不走）；onError 用例同样失败；嵌套用例收到 `['a','a','a','a']` 之类；loopId 用例失败；循环外 benign 用例收到 `['after']`（noop 继续往后走）且没有 info 日志。Task 1 的用例仍 PASS。

- [ ] **Step 3: 实现哨兵模块 + 执行器**

3a. 新建 `src/background/workflow-engine/loop-breakpoint.ts`（完整文件）：

```ts
/**
 * Sentinel error thrown by the `loop-breakpoint` block to unwind out of the
 * enclosing loop body. The engine catches it at the owning loop and resumes
 * from that loop's "end" branch. Kept in its own module so `engine.ts` and
 * `executors.ts` can both import it without a circular dependency.
 *
 * @module background/workflow-engine/loop-breakpoint
 */

export class LoopBreakpointError extends Error {
  /** Target loop's `loopId`; unset means "break the innermost enclosing loop". */
  loopId?: string

  constructor(loopId?: string) {
    super('loop-breakpoint')
    this.name = 'LoopBreakpointError'
    if (loopId !== undefined) this.loopId = loopId
  }
}
```

3b. `executors.ts` 顶部 import 区加入：

```ts
import { LoopBreakpointError } from './loop-breakpoint'
```

3c. `executors.ts:1821-1825`（`eventClick`/`hoverElement` 定义之后）插入执行器：

```ts
/**
 * Automa `loop-breakpoint` block: unwinds out of the enclosing loop by
 * throwing the sentinel the engine catches at the owning loop (which resumes
 * from that loop's "end" branch). A non-empty `loopId` targets a specific
 * outer loop; without one the innermost enclosing loop breaks. runNode
 * rethrows the sentinel before any onError handling, so this block is never
 * retried, fallback-routed or failed.
 */
const loopBreakpointExec: BlockExecutor = async (data) => {
  const raw = data['loopId']
  const loopId = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  throw new LoopBreakpointError(loopId)
}
```

3d. `executors.ts:1915`，注册表条目 `'loop-breakpoint': noop,` 替换为：

```ts
  'loop-breakpoint': loopBreakpointExec,
```

- [ ] **Step 4: 实现引擎捕获（engine.ts）**

4a. `engine.ts` import 区加入：

```ts
import { LoopBreakpointError } from './loop-breakpoint'
```

4b. `runNode` 的执行器重试循环 catch（`engine.ts:423-425`）：

```ts
      } catch (e) {
        lastError = e
        if (isAbort(e)) break
```

替换为：

```ts
      } catch (e) {
        lastError = e
        if (isAbort(e)) break
        // A loop-breakpoint unwinds past per-block onError handling: the
        // enclosing loop catches it, not the retry/fallback machinery.
        if (e instanceof LoopBreakpointError) throw e
```

4c. `runSegment` 函数（`engine.ts:482-491`）之后新增助手：

```ts
  /**
   * Runs one loop-body segment, translating a `LoopBreakpointError` from the
   * body into a `'break'` signal when THIS loop owns it (no loopId = the
   * innermost loop; a loopId must match the loop node's values/data `loopId`
   * or the node id), rethrowing otherwise so an outer loop can claim it.
   */
  async function runLoopBody(
    loopNode: WorkflowNode,
    startId: string,
  ): Promise<'ok' | 'break' | 'failed'> {
    try {
      await runSegment(startId, loopNode.id)
    } catch (e) {
      if (e instanceof LoopBreakpointError) {
        const wanted = e.loopId ?? ''
        const owners = [paramsOf(loopNode)['loopId'], loopNode.data?.['loopId'], loopNode.id].map(
          (v) => (v === undefined || v === null ? '' : String(v)),
        )
        if (wanted === '' || owners.includes(wanted)) return 'break'
      }
      throw e
    }
    return outcome === 'ok' ? 'ok' : 'failed'
  }
```

4d. 四个循环分支的循环体调用点，把

```ts
        await runSegment(startId, loopNode.id)
        if (outcome !== 'ok') return null
```

逐处替换为：

```ts
        const seg = await runLoopBody(loopNode, startId)
        if (seg === 'failed') return null
        if (seg === 'break') return endId
```

（`loop-data`、`repeat-task`、`while-loop`、`loop-elements` 各一处；`while-loop` 分支中该替换在 `if (++iterations > MAX_WHILE_ITERATIONS)` 之前，超限判断保持不变。）

4e. `runCore` 顶层 catch（`engine.ts:620-631`）：

```ts
  } catch (e) {
    // Top-of-loop abort check (or an unexpected engine error) surfaced here.
    const text = message(e)
    emit('error', currentNodeId, text)
    if (isAbort(e)) {
      outcome = 'cancelled'
      summary = CANCELLED_SUMMARY
    } else {
      outcome = 'failed'
      error = text
    }
  }
```

替换为：

```ts
  } catch (e) {
    if (e instanceof LoopBreakpointError) {
      // A loop-breakpoint fired outside any loop (or its loopId matched
      // nothing): benign — stop the chain here and keep the run 'ok'.
      emit('info', currentNodeId, 'loop-breakpoint: 不在循环内，已忽略')
    } else {
      // Top-of-loop abort check (or an unexpected engine error) surfaced here.
      const text = message(e)
      emit('error', currentNodeId, text)
      if (isAbort(e)) {
        outcome = 'cancelled'
        summary = CANCELLED_SUMMARY
      } else {
        outcome = 'failed'
        error = text
      }
    }
  }
```

- [ ] **Step 5: 运行测试确认通过**

```
pnpm exec vitest run tests/workflow-phase4.spec.ts tests/workflow-engine.spec.ts tests/automa-executors.spec.ts
```

预期：全部 PASS（`automa-executors.spec.ts` 只断言 `loop-breakpoint` 注册的是函数，替换后仍成立）。

- [ ] **Step 6: 提交**

```bash
git add src/background/workflow-engine/loop-breakpoint.ts src/background/workflow-engine/engine.ts src/background/workflow-engine/executors.ts tests/workflow-phase4.spec.ts
git commit -m "feat(workflow): 实现 loop-breakpoint 提前跳出循环"
```

---

### Task 3: README 文档（失败重试小节）

**Files:**
- Modify: `README.md:329`（**Watching runs.** 段落之后、**Portability.** 之前插入）
- Modify: `README.zh-CN.md:263`（**查看运行。** 段落之后、**导入导出。** 之前插入）

- [ ] **Step 1: README.md 插入小节**

在 `**Watching runs.**` 段落（"…a failed run deep-links straight to its log."）与 `**Portability.**` 段落之间插入：

```markdown
**Failure retry.** Two levels:

- **Single block.** Every block's *On error* settings can retry itself N times
  with an interval, or route to its `fallback` handle. For one flaky click.
- **A group of steps.** Put the group inside a **Repeat task** block and detect
  the failure with an **Element exists** check — e.g. a login that re-enters
  the captcha on failure, up to 5 attempts:

  ```
  Repeat task (5)
   ├─ loop → click "refresh captcha" → OCR the captcha image (→ lastOcrText)
   │          → fill the captcha input with {{lastOcrText}} → click "sign in"
   │          → wait 2s → Element exists (error-message selector)
   │                         ├─ exists (failed)  → wire back to the Repeat task
   │                         │                     block = next retry
   │                         └─ not exists (ok)  → Set variable loginOk=true
   │                                              → Loop breakpoint
   └─ end  → Conditions (loginOk exists?) ─ true  → logged-in steps…
                                          └─ false → all 5 attempts failed
  ```

  The body is whatever hangs off the **loop** handle; wiring the last body
  block back to the loop block ends an iteration. **Loop breakpoint** breaks
  out early; execution resumes at the **end** handle — which also runs after
  all iterations finish, so tell the two endings apart with a variable plus
  **Conditions** (as above), e.g. notify or fail the run when login never
  succeeded. (A hand-drawn cycle of blocks counted by **Increase variable**
  and gated by **Conditions** also works, but the loop shape above is easier
  to read and maintain.)
```

- [ ] **Step 2: README.zh-CN.md 插入小节**

在 `**查看运行。**` 段落与 `**导入导出。**` 段落之间插入：

```markdown
**失败重试。** 两个层级：

- **单个块。** 每个块的「出错时」设置可以让它自己重试 N 次（含间隔），或改走
  `fallback` 分支。适合偶尔失灵的一次点击。
- **一组步骤。** 把整组步骤放进**重复执行**块里，用**元素存在**判断是否失败
  ——比如登录时验证码输错就刷新重来、最多尝试 5 次：

  ```
  重复执行 (5)
   ├─ loop → 点「刷新验证码」→ OCR 识别验证码图片（→ lastOcrText）
   │          → 验证码输入框填 {{lastOcrText}} → 点「登录」→ 等待 2 秒
   │          → 元素存在（错误提示选择器）
   │                         ├─ 存在（失败）  → 连回「重复执行」块 = 下一次重试
   │                         └─ 不存在（成功）→ 设置变量 loginOk=true
   │                                            → 循环断点
   └─ end  → 条件（loginOk 是否存在）─ 成立 → 登录后的后续步骤…
                                     └ 不成立 → 5 次均失败的处理
  ```

  循环体是挂在 **loop** 出口上的那串块；把体内最后一个块连回循环块即结束一次
  迭代。**循环断点**用于提前跳出；执行会从循环块的 **end** 出口继续——该出口
  在循环自然跑完后同样会走到，所以用变量 + **条件**块区分两种结局（如上），
  例如始终登录失败时发通知或让运行判失败。（替代做法：手工把块连成环、用
  「增加变量」+「条件」做重试计数——也能跑，但没有上面的循环结构清晰。）
```

- [ ] **Step 3: 提交**

```bash
git add README.md README.zh-CN.md
git commit -m "docs(readme): 工作流失败重试说明（整组重试 + 登录验证码示例）"
```

---

### Task 4: 全量验证

**Files:** 无新增修改（只验证）。

- [ ] **Step 1: 类型检查**

```
pnpm run typecheck
```

预期：无错误退出（exit 0）。

- [ ] **Step 2: 全量测试**

```
pnpm run test
```

预期：全部测试套件 PASS，无失败用例。

- [ ] **Step 3: 收尾确认**

`git log --oneline -3` 应看到 Task 1-3 的三次提交；工作区除用户原有 WIP 外无本次改动的遗留文件。

---

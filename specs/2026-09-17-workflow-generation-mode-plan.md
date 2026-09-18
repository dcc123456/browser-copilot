# 工作流生成模式（Workflow Generation Mode）实施计划

日期：2026-09-17
状态：**全部 10 个阶段（Phase 0–9）已完成并验证**

> 本文件是仓库内的落地记录。批准时的完整方案（含逐阶段实施步骤）原稿在会话工作区
> `~/.workbuddy-ai/plans/`，不在仓库内；此处的阶段划分与原稿一致，
> 并补充了**实施中发现的偏差**与自审记录。

约定：每阶段结束保持 `pnpm typecheck` + `pnpm test` 绿；提交信息英文 Conventional Commits。

## 阶段与落地状态

| 阶段    | 主题                               | 状态 | 主要产物                                                                                                   |
| ------- | ---------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| Phase 0 | 无行为变化的准备（纯搬迁）         | 完成 | `lib/workflow/target-to-selector.ts`、`resolveRecordedLocator`、`appendOperatorNode`、`trigger-options.ts` |
| Phase 1 | 连边与触发器正确性（尚不执行页面） | 完成 | handle 规范化、`pendingBranch`、trigger 头节点、判空口径改"非 trigger 节点数"                              |
| Phase 2 | 草稿持久化                         | 完成 | `lib/workflow/draft-storage.ts`（L2）、`draftStore` 降级为 L1 写穿缓存                                     |
| Phase 3 | **执行桥（本功能核心）**           | 完成 | `background/workflow-engine/operator-exec.ts`、`background/operator-tool-run.ts`                           |
| Phase 4 | 安全闸门                           | 完成 | 模式切换危险确认覆盖 workflow、`lib/workflow/secret-guard.ts`、审计脱敏 + 原始动作映射                     |
| Phase 5 | 工具面分层                         | 完成 | 动作面 24 个每轮广告 / 编排面 30 个按需 `load_tools`、`operators_author` 组                                |
| Phase 6 | 触发器选择器 + 运行前校验          | 完成 | `trigger-patch.ts`、`validateWorkflowForRun`、9 类可用触发器                                               |
| Phase 7 | 循环折叠（含引擎能力补齐）         | 完成 | `interpolate.ts`、`loopElementSelector` 注入、`loop-collapse.ts`、`collapse-probe.ts`                      |
| Phase 8 | element-change 触发器实现          | 完成 | MutationObserver 注入 + 注册表刷新 + 重入闸门                                                              |
| Phase 9 | 收尾                               | 完成 | `OPERATOR_META` 分类改单一来源、删死代码、符号重命名                                                       |

### Phase 3 执行桥的落地形态

`runOperatorToolWithExecution` 三层：`resolveRecordedLocator(args)`
（`ref` → `snapshotTargets`，否则 `args.target`，否则 `args.selector`）→
`executeOperatorNode(blockId, data)`（**与工作流回放共用 `EXECUTORS[blockId]`**）→
`appendOperatorNode`。执行失败**不写节点**，错误回灌模型。

分支表达用**哨兵输出**：`SENTINEL_OUTPUTS` / `SENTINEL_TO_BRANCH` 把
`true|false` / `exists|notExists` / `loop|end` 归一化为 `output-1|output-2`，
再由 `pendingBranch` 消费到下一条入边——修复了原实现"模型传 `next` 时一条边都不发"的缺陷。

### Phase 5 工具面分层

| 层                                    | 数量 | 广告策略                                             |
| ------------------------------------- | ---- | ---------------------------------------------------- |
| 动作面 `WORKFLOW_ACTION_OPERATOR_IDS` | 24   | 每轮全量广告                                         |
| 编排面 `WORKFLOW_AUTHOR_OPERATOR_IDS` | 30   | `load_tools({groups:['operators_author']})` 按需载入 |
| 读工具 `WORKFLOW_READ_TOOLS`          | 3    | 每轮（`ref` 定位依赖 `snapshot_page`）               |

分层依据是**频率而非能力**：编排面全部可达，且误调会自动载入该组。
`compose_workflow` 不广告（面板驱动保存），保留 dispatch；
并修掉了系统提示（"do NOT call compose_workflow"）与 `modeWorkflowHint`
（"最后调用 compose_workflow 即可落盘"）之间的矛盾。

## 与计划的偏差（实施中修正）

1. **`deriveContainer` → `deriveLoopSelector`（接口语义修正）**
   计划把探测接口定义为"求一个能精确匹配 N 个元素的**容器**选择器"。
   实测引擎迭代的 `selector` **就是被迭代的元素本身**，不是容器；照计划实现会得到一个
   只跑一轮的循环。改名并重定义为"精确匹配这批元素、且顺序一致的选择器"。

2. **参数插值必须在 `runNode` 集中做**
   计划只说"补插值能力"。实测根因是 `sel(data)` / `targetFrom(data)` **从不插值**，
   所以 `{{loopElementSelector}}` 会原样留在选择器里。改 60 个执行器风险太大，
   改为在 `runNode` 里插值一次（同时 `interpolateParams` 保证**无变化时返回原对象引用**，
   否则嵌套 `target`/`onError` 的恒等契约失效）。

3. **`EMPTY_INTERP_KEY` 原是一句"文档谎言"**
   `executors.ts` 里声明了它并注释"引擎会设置、`forms` 会读"，但两边都没做。
   若让引擎真的开始设置它，会**静默破坏** `forms` 的"空引用不清空表单"保护，
   因此把它做成真的（落在 `lib/workflow/interpolate.ts`）并让 `forms` 真正读它。

4. **`OPERATOR_META` 与 `operatorExecClass` 双向不一致 20 处**
   计划 Phase 9 只要求"按 `operatorExecClass` 决定 `act`/`data`"。实测两侧
   **双向**不一致：`proxy`/`browser-event`/`save-local` 被误报警告，
   `conditions`/`clipboard`/`delay` 真执行却没警告。改为分类单一来源并加测试锁住。

5. **"扩充到 66 个算子"的准确口径**
   66 是**目录项**数（`BLOCK_CATALOG` 62 + `CUSTOM_BLOCKS` 4）。实际暴露为
   **54 个算子工具**（cloud-only 与无编辑表单的占位块不暴露）；
   其中 37 个 `execute`、17 个 `record-only`。

6. **`detectRepeatRuns` 曾把不同控件误判为同一段**
   `nodeShape` 起初把 `type` 也跳过，导致 `forms` 的 text-field 与 select 被视为同签名。
   已把 `type` 纳入签名。

7. **探测候选不足（写测试时暴露）**
   原算法只能生成"共同祖先的**直接子元素**"候选，因此 `.rows > div > input`
   （每行 input 的 id 都不同）这种常见结构**永远折不了**。补了候选 4：
   各元素到共同祖先的**剥壳相对路径**。仍走同一套身份 + 顺序校验。

8. **追加收尾：注入函数自包含性守卫**
   计划未包含。Phase 7 新增了两个注入函数，而这条约束
   （`executeScript` 只序列化函数源码）此前只靠注释与自觉。
   新增 `scripts/verify-injected-functions.mjs` + `tests/injected-functions.spec.ts`，
   首轮查出 **3 个真缺陷**（详见设计文档 3.7）。

## 验证

| 项目                                                   | 结果                                              |
| ------------------------------------------------------ | ------------------------------------------------- |
| `tsc --noEmit` + `tsc --noEmit -p tsconfig.tests.json` | 0 错误                                            |
| `eslint src tests scripts`                             | 干净                                              |
| `pnpm test`                                            | **137 文件 / 1675 用例全绿**                      |
| `pnpm verify:injected`                                 | 15 个注入函数 / 17 个调用点全部自包含             |
| `vite build`                                           | 通过；并从 `dist/assets` 抽出注入函数重跑行为检查 |

## 自审记录

- **"记录即事实"由构造保证**，不是靠两处代码同步：执行与回放共用 `EXECUTORS[blockId]`。
  这是本次最重要的结构决定——否则草稿会说做了 A、实际做了 B，且漂移是静默的。
- **变化段折叠一律"先验证、后改写"**：探测失败就只提示。测试里**拒绝用例多于成功用例**
  （剥壳后过宽、顺序与文档顺序不符、同一元素重复、标签不一致、旁有同款兄弟元素）。
  一个迭代错元素的循环比不折叠的图更糟。
- **触发器双份状态**是本功能最容易出错的地方（`saveWorkflow` 不调 `triggerFromNodes`），
  已在设计文档里单列一节，并在 `trigger-patch` 测试里断言两处同步。
- **`validateWorkflow` 没有接进 `saveWorkflow`**，否则会拒掉存量工作流；
  新的 `validateWorkflowForRun` 只接 `workflows.run`，不放进 `executeWorkflow`
  （那会挡住定时/触发器/上下文菜单这些本已合法的运行路径）。
- **测试用例数不是质量证据**：`collapse-probe` 的 25 个用例首轮一次全绿，
  我据此做了定点变异（禁用候选 4 → 恰好 4 个失败；禁用 `matches` 的身份比对 →
  恰好 1 个失败），确认测试真的承重。
- **静态守卫自己也会失效**：`verify-injected-functions.mjs` 起初只比较字符偏移、
  不比较文件，于是跨文件引用**全部漏报**——而跨文件引用正是它存在的理由。
  是变异测试发现的（第一次变异时它照样报 OK）。已加同文件判断。

## 遗留（未处理，供后续决定）

1. **`src/background/workflow-engine/page-inspect.ts` 是死代码**（约 230 行）：
   无任何文件 import，也不在构建产物里。其内部的 3 个常量引用问题已顺手修好，
   但模块本身是否删除未决定。
2. **`src/background/driver.ts` 与 `src/background/operator-tool-handler.ts`
   在 HEAD 就各有一处 prettier 未格式化**（如 `if (scope && …)` 想合并成一行）。
   不要整体 `prettier --write` 这两个文件，会带上无关改动。
3. **`pnpm lint`（`eslint .`）会扫到 gitignore 掉的 `tmp/`**，其中有约 3200 个
   既有错误（与本次改动无关）。核对自己的改动用 `eslint src tests scripts`。
4. **`spec-mode` skill 是一个未填写的模板**（`~/.workbuddy-ai/skills/spec-mode/SKILL.md`
   的 description 仍是 `[TODO: …]`，正文全是占位说明）。本次的 spec 产物是补写的，
   该 skill 本身需要被填实或删除。
5. **计划中风险 8（element-change 的 tab 作用域策略）** 未在本文件固化结论，
   实现按 `tabId`/`windowId` 传递；若后续要跨标签页监听需重新定义策略。

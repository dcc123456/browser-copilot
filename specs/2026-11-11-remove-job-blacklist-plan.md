# 移除岗位黑名单配置

日期：2026-11-11 · 主题：按用户明确要求「删除配置中的岗位黑名单配置，这个项目不需要」

## 1. 结论

彻底移除该功能：设置项、UI 区、存储字段、两处归一化、运行时变量注入、i18n 文案、专用测试与所有测试 fixture 中的字段。用户已明确授权删除该功能及其实现文件（含 `src/lib/job-blacklist.ts` 与两个专用 spec）；删除清单在本文件逐项列明。

旧存储里残留的 `jobBlacklist` 键**不会导致报错**：`normalizeStoredSettings` 是白名单式显式构造，未知键被静默忽略；下一次任意 `settings.set` 会基于归一化结果合并写回，顺带把残留键清掉。因此**不 bump `SCHEMA_VERSION`**（bump 会额外触发 built-in 播种等无关副作用），也不需要迁移代码。

## 2. 全量引用盘点（已全仓库检索，排除 node_modules/dist/tmp/releases）

命中 14 个文件 = 源码 7 + 测试 7。`server/`、`scripts/`、`docs/`、`website/`、`release-notes/`、`src/lib/workflow/`、`README.md`、`README.zh-CN.md`、`CHANGELOG.md` 与根级 md **均无命中**。

| 文件                                             | 作用                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/job-blacklist.ts`                       | 核心：`JobBlacklist`、`EMPTY_JOB_BLACKLIST`、`normalizeBlacklistEntries`、`parseJobBlacklistLines`、`normalizeJobBlacklist`（整文件删） |
| `src/lib/types.ts`                               | `Settings.jobBlacklist` 字段 + type import                                                                                              |
| `src/lib/storage.ts`                             | import、`DEFAULT_SETTINGS` 默认值、`normalizeStoredSettings` 归一化                                                                     |
| `src/lib/providers.ts`                           | import、`normalizeSettingsPayload` 返回类型字段 + 归一化                                                                                |
| `src/lib/i18n.ts`                                | 10 个 `settingsJobBlacklist*` key × 3 处                                                                                                |
| `src/sidepanel/SettingsTab.tsx`                  | import、`BLACKLIST_FIELD` 常量、2 个 draft state、`saveJobBlacklist`、JSX 块 `:968-1034`                                                |
| `src/background/workflow-engine/run-workflow.ts` | 把设置注入为 `variables.jobBlacklist` 的唯一注入点 `:822-843` + 仅为它服务的 `getSettings` import                                       |
| `tests/job-blacklist.spec.ts`                    | 专用单测（整文件删）                                                                                                                    |
| `tests/workflow-run-job-blacklist.spec.ts`       | 注入行为测试（整文件删）                                                                                                                |
| `tests/providers.spec.ts`                        | 2 处 `toEqual` 期望对象里的字段                                                                                                         |
| `tests/local-agent-client.spec.ts`               | `settings(): Settings` 工厂字段                                                                                                         |
| `tests/settings-provider-models-ui.spec.tsx`     | fixture 字段                                                                                                                            |
| `tests/settings-thinking-ui.spec.tsx`            | fixture 字段                                                                                                                            |
| `tests/dynamic-data-flow.spec.ts`                | 一处提到 `jobBlacklist` 的过时注释                                                                                                      |

唯一文档命中 `specs/2026-10-15-notification-feishu-and-goal-free-design.md:41` 是「目标契约不要引入黑名单机制」的无关设计表述，**保留**。

## 3. 选型与证据（§7）

不涉及外部能力、新库或新 API，无需外部取证。关键决策的证据来自本机源码：

- `storage.ts:198-300 normalizeStoredSettings` 逐字段白名单构造 → 删掉一行后旧键被忽略，读取安全。
- `storage.ts:471-487 setSettings` 基于 `getSettings()` 结果合并 → 下次写入自然清除残留键。
- `run-workflow.ts:20` 的 `getSettings` import 仅被 `:829` 注入点使用 → 删注入块必须连 import 一起删，否则 `noUnusedLocals` 报错。
- `SettingsTab.tsx` 的 `Switch` import 在 `:831/:933/:941/:1220/:1491` 等 5 处仍在使用 → **不能删**。
- `EMPTY_JOB_BLACKLIST` / `normalizeBlacklistEntries` 仅在模块自身与其 spec 内出现 → 随文件一起消失，无外部依赖。
- 无任何构建配置显式登记该模块或这两个 spec → 删整文件无需改 `vite.config.ts` / `tsconfig*.json` / `package.json`。

被否决的候选：

| 候选                                    | 否决理由                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| 只删设置面板 UI，保留底层模块与设置字段 | 留下未调用的导出与死分支，违反 §5.4；用户说的是「这个项目不需要」，不是「先隐藏入口」。      |
| bump `SCHEMA_VERSION` 到 10 做迁移      | 无必要（见 §1），且 `ensureSchema` 会连带触发 built-in 技能/代理播种，属于超出需求的副作用。 |
| 保留 `jobBlacklist` 字段但恒为空        | 类型与运行时仍带着无用概念，违反 §5.4「发现无用代码及时删除」。                              |
| 把运行时注入改成空对象常量              | 工作流变量里仍会出现一个无意义的 `jobBlacklist`，与「项目不需要」相悖。                      |

## 4. 最小安全删除清单

1. 删 `src/lib/job-blacklist.ts`、`tests/job-blacklist.spec.ts`、`tests/workflow-run-job-blacklist.spec.ts`。
2. `src/lib/types.ts`：删 `:7` type import、`:271-278` JSDoc + 字段。
3. `src/lib/storage.ts`：删 `:31` import、`:134` 默认值、`:298` 归一化行。
4. `src/lib/providers.ts`：删 `:23` import、`:633` 返回类型字段、`:737` 返回对象字段。
5. `src/lib/i18n.ts`：删 `:1347-1357`（interface）、`:3082-3095`（en）、`:4772-4784`（zh-CN）。
6. `src/sidepanel/SettingsTab.tsx`：删 `:6` import、`:43-45` 常量、`:268-269` 两个 useState、`:735-739` saveJobBlacklist、`:968-1034` JSX 块。
7. `src/background/workflow-engine/run-workflow.ts`：删 `:822-843` 注入块、`:20` `getSettings` import。
8. `tests/providers.spec.ts` 删 2 行、`tests/local-agent-client.spec.ts` 删 1 行、两个 `settings-*-ui.spec.tsx` 各删 1 行、`tests/dynamic-data-flow.spec.ts` 改写过时注释。
9. 文档 / README / CHANGELOG / website / release-notes：**无需改动**。

## 5. 验收

- ① `pnpm typecheck`（含 tsconfig.tests.json）、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全绿。特别注意：任何显式 `: Settings` / `as Settings` 的对象字面量残留该键会触发 TS2353，任何 `toEqual` 期望对象残留会导致断言失败——清单已覆盖全部 5 处 fixture。
- ② 未改 Runner 侧，不适用。
- ③ 改动涉及 `src/background/workflow-engine/run-workflow.ts`：按收尾自检 ③，该规则针对 `workflow-engine/**` 的成功率基准（`pnpm bench:debug`）适用于 AI 接管/调试成功率的逻辑改动；本次只是删除一段变量注入，不触碰 `ai-takeover.ts` 与调试判定路径，故不改基准，但会在交付说明中标注这一判断。
- ⑤ 浏览器实证：BLOCKED（本环境未加载 unpacked extension）；给出人工步骤确认设置页不再出现该配置、工作流仍能正常运行。
- ⑥⑦ 删完后 `Grep jobBlacklist|JobBlacklist|headhunterPositions|excludeHeadhunters` 在 `src/` 与 `tests/` 应归零；无未调用导出、无注释掉的代码块。
- ⑧ 本次只删 UI 不新增 UI，无新文案。
- ⑨ 无 `tmp/` 产物入暂存区。
- ⑩ 不涉及 tag，README 无需更新（该配置从未写进 README，且本次是删除内部配置项；按 §4 在提交说明里注明「README 无需更新」及原因）。
- ⑪⑫ 英文 Conventional Commit、单独提交推送 `main`、交付说明含人工测试步骤。

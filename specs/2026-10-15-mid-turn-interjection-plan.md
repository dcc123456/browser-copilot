# 回合内补充说明与卡片叠弹 · plan

日期 / Date: 2026-10-15
设计 / Design: `specs/2026-10-15-mid-turn-interjection-design.md`

## 切片（与最终落地一致 · as shipped）

| #   | 步骤                                | 落点                                                                                                                                                                                                                            | 验收                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 通道加每回合补充队列                | `src/background/agent-channel.ts`：`Interjection { id, text }`、`channel.interjections`、`queueInterjection`/`takeInterjections`                                                                                                | `tests/agent-channel.spec.ts`：无活回合 → `queueInterjection` 返回 false 且不建通道；`takeInterjections` 保序、一次取空、二次为空                                                                                                                                             |
| 2   | 协议新消息                          | `src/lib/messages.ts`：client `chat.interject{noteId}`；server `chat.interject.ack{noteId,queued}`、`chat.interjection.applied{noteIds}`、`interactions.dismissed`；顺手删掉死代码 `EMPTY_TURN_USAGE`/`addTurnUsage`            | `pnpm typecheck`（封闭联合，机检）；`chat.interjection.applied` 刻意**不进** `REPLAYABLE`（理由见设计 §3.1）                                                                                                                                                                  |
| 3   | worker 入队 + 轮边界注入 + 残留不丢 | `src/background/index.ts`（`chat.interject` → `queueInterjection` → ack；deps 接 `takeInterjections`）+ `src/background/agent.ts`（`applySupplements:5065`，消费点 `:5111` 与 `:5296`）+ `src/lib/llm.ts:98` `wrapInterjection` | `tests/agent-interjection.spec.ts`：便签以 `role:'user'` 出现在下一次请求的 messages 里（`displayContent` 原话、`content` 带信封）；echo 只发一次并带全部 `noteIds`；最终答复处仍有未读 → **同一回合** `continue`（请求数 +1，不开新通道）；无 `takeInterjections` 时行为不变 |
| 4   | en + zh-CN 文案                     | `src/lib/i18n.ts` 封闭 `Messages`：`chatInterject`、`chatInterjectPlaceholder`、`chatInterjectionApplied`、`chatInterjectionUnapplied`、`chatInterjectionQueued`、`workflowGenerationStopped`                                   | `pnpm typecheck`（只注册一侧会编译失败）                                                                                                                                                                                                                                      |
| 5   | 面板输入区：运行中可发补充          | `src/sidepanel/ChatTab.tsx`：`startTurn`（从 `send` 抽出，返回是否投递）、`interject:2951`、`submitComposer:2966`、按钮 `busy ? chatInterject : chatSend`、`Entry.interjection:177`                                             | `tests/workflow-generation-dialog-fix.spec.tsx`：`busy` 时回车发 `chat.interject` 而**不是**第二条 `chat`、草稿清空、`busy` 不复位；ack `queued:false` → 只发一次普通回合且 user 气泡只有一份                                                                                 |
| 6   | 便签不静默丢弃                      | `ChatTab.tsx`：`notesRef` 候选集、`chat.interjection.applied` 撤标记（`:2361`）、`restore` 用 `restoredUserTexts` 对账（`:2231`）、`reclaimUnappliedNotes:2103` 在 `done`/`error` 退回草稿并标 `unapplied`                      | 组件测试：被读到的便签不再退回；未读到的文本回到输入框、气泡标"未生效（任务已停止）"                                                                                                                                                                                          |
| 7   | 卡片不叠：单张队首 + 回合边界撤卡   | `agent-channel.ts` `declineInteractions` 补发 `interactions.dismissed`（仅有待答时）；`ChatTab.tsx` `cardSeqRef`/`headPendingCard:301`/`clearPendingCards:2089`，`done:2425`、`error:2454`、停止 `:4414`                        | 组件测试：同时到达两张 `ask_user.request` 只渲染队首（最旧）；收到 `interactions.dismissed` 后卡片归零；后台在无待答时不发该消息                                                                                                                                              |
| 8   | 进度弹层：终态与职责                | `src/sidepanel/components/WorkflowGenerationDialog.tsx`：`'STOPPED'` 状态 + `titleForState`；动作日志 `<details>` 不再默认展开                                                                                                  | 组件测试：停止后弹层进入 `STOPPED`（`warn` 口径）；保存卡片仍一张只弹一次（`modalOpenedForRef`，`ChatTab.tsx:1933`）                                                                                                                                                          |
| 9   | 回归与门禁                          | `tests/**`                                                                                                                                                                                                                      | `pnpm typecheck`、`pnpm test`（360 files / 4127 tests）、`pnpm lint`、`pnpm format:check`、`pnpm build`                                                                                                                                                                       |

## 顺序依赖

1 → 2 →（3、4）→（5、6、7 依赖 2/4）→ 8 → 9。原计划第 3 步里"残留由 `index.ts` 再跑一轮"的写法被否掉：残留续跑落在 `runAgentTurn` 内部（同通道、同 usage 累加器），`index.ts` 只做入队与 ack。原计划第 8 步（保存卡片不与活回合叠层）经核对无需改动——offer 只发生在 `done`，且 `modalOpenedForRef` 已经保证一张卡片只弹一次。

## 门禁（收尾自检对应）

- ① 扩展侧：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`，改动触及 UI → 额外 `pnpm build`。
- ② Runner 侧：不涉及（`server/**` 无头、无面板，补充说明是面板交互），故不跑 `pnpm server:typecheck`/`server:test`；若实现中意外触碰共享逻辑则补跑。
- ③ 不涉及 `src/lib/workflow/ai-takeover.ts` 与 `src/background/workflow-engine/**` → 不跑 `pnpm bench:debug`。
- ④ 不新增 `executeScript({func})` 内联函数体 → 不跑 `pnpm verify:injected`。
- ⑤ 真实浏览器（关键项）：side panel 是扩展页，不可被 CDP 脚本驱动（项目既有结论），**本次标 BLOCKED**，不得用单测绿冒充"能用"。手工验证要覆盖：运行中发补充 → 后续工具调用按补充调整 → 停止按钮仍可用作 → 最终保存卡片只弹一次 → 运行中不再出现第二张、第三张待答卡片。
- ⑥ 复用检查：注入走 `history` 原地 push（与 `compactHistory` 同一先例），队列挂 `ChatTurnChannel`，不新建第三套回合状态容器；卡片排队用面板侧纯函数 `headPendingCard`，不再造第三份待答状态。
- ⑦ 无死代码（顺手删除 `messages.ts` 里未被调用的 usage 合并助手）；新增文案全部走 key。
- ⑩ 提交英文 Conventional Commits；本次不打 tag。

## 不在本次范围

设计文档 §5 的两条遗留（`promptedRef` 静默抑制、`answerPending` 的 false 被忽略）——同一个"回合边界状态"主题，但先让用户不再走停止路径，再单独收口。§6 的 ack/`done` 窄竞态为已接受项，同样留到那次收口。

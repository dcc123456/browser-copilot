# 工作流复制

裁定来源：用户诉求「我需要工作流支持复制」。

## 1. 范围裁定

「复制工作流」读作**复制一条已保存的工作流，得到一条独立的新记录**——即管理列表里的一行
动作，而不是编辑器画布上的节点复制/粘贴。理由：

- 存储层已经有这个能力（`src/lib/workflow/storage.ts` 的 `duplicateWorkflow`），且已有单测，
  缺的只是**没有任何 UI 走它**（全仓仅 `storage.ts` 与 `tests/workflow-storage.spec.ts` 引用）。
  复用它正好符合 §5.1「先搜同能力实现」。
- 编辑器画布的节点复制/粘贴是另一件事（React Flow 侧的能力，且不在本次诉求的字面范围内），
  不在这里偷做。

不做：改名对话框（新名字自动生成 `"<原名> (copy)"`；用户随后可在编辑器里改名）、批量复制、
跨设备同步。改动止于「一个 Duplicate 按钮 + 一条 worker 命令」。

## 2. 写入路径：面板不能直接调 `duplicateWorkflow`

`tests/panel-no-direct-writes.spec.ts` 明确禁止面板 import 内容写入函数：那条锁队列
（`lib/key-lock.ts`）只在 service worker 这一个 JS 上下文里，直接写会绕过 worker 的
read-modify-write 串行化与 outbox/replay 纪律——历史上工作流消失就是这么来的。所以：

```
WorkflowsTab (panel)  --sendCommand-->  background  --duplicateWorkflow--> storage
```

- `src/lib/messages.ts`：新增命令 `{ type: 'workflows.duplicate'; id: string }`，响应
  `{ type: 'workflows.duplicate'; workflow?: Workflow }`（照 `workflows.get` 的形状：拿回
  新记录，面板用它显示成功横幅里的新名字）。
- `src/background/index.ts`：handler 调 `duplicateWorkflow(command.id)`，然后
  `await rescheduleAllWorkflowTriggers()`。**这一行不能省**：副本会连同 trigger 配置一起
  继承，不重排 alarm 的话副本的定时触发不会生效。`workflows.save` / `workflows.delete`
  都是这个形状。
- 源 id 不存在时 `duplicateWorkflow` 返回 `undefined`，handler 仍返回 `workflow: undefined`；
  面板据此报一条失败横幅，而不是静悄悄地什么都不做。

## 3. 副本必须重置 revision 与 revisionHistory

`duplicateWorkflow` 原本深拷贝整条记录，因此副本会带着**源工作流的 `revision` 和
`revisionHistory`**——也就是副本会声称自己是「revision 7，上次由 AI 修复」。这是假溯源：
副本是全新记录，从没被编辑过，也没被任何修复会话碰过。

因此复制时显式丢掉这两个字段（`Workflow` 上都是 optional，丢掉后
`currentRevisionOf` 按 0 处理）。UI 显示上，副本就是一个「还没保存过」的干净记录。

其余字段整条复制：`drawflow`（节点/连线）、`settings`、`trigger`、inputs。**不复制任何
运行态**——`lastRun` 之类不在 `Workflow` 类型里（运行记录在 `tasks.runs`），副本自然没有
「上次运行」。

## 4. 隐私红线

`get-secret` 节点持久化的只有凭证**引用**（`label · fieldKey`），从来没有凭证值，所以复制
不会把任何密钥带进新记录——这也是为什么复制不需要任何额外的脱敏处理。新记录里仍然是引用。

## 5. 验收

- `tests/workflow-storage.spec.ts`：副本的 `revision` / `revisionHistory` 被重置（源带
  revision 7 + 历史时，副本两者皆空），其余字段仍在、id 不同。
- `tests/workflows-tab-duplicate.spec.tsx`（新增，沿用 `workflows-tab-resume` 的真实组件
  harness）：点 Duplicate 发 `workflows.duplicate`；成功后横幅报出副本名字且列表刷新；
  worker 答 `workflow: undefined` 时报失败横幅，不假装成功。
- 机检：`pnpm typecheck`、`TZ=UTC pnpm test`、`pnpm lint`（只对 `git ls-files`）、
  `pnpm format:check`、`pnpm build`。
- 浏览器证据：面板这条路径是「点击 → 命令 → 存储 → 列表刷新」的纯接线，逻辑由上述组件测试
  与存储测试覆盖；扩展页不可脚本化（见记忆「Extension pages are not scriptable」），
  真机点击证据标记为待人工确认。

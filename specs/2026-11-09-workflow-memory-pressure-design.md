# 运行日志的内存压力：根因与收敛

日期：2026-11-09
状态：已实现

## 1. 现象与取证

用户报告扩展“经常崩溃”。本机 Crashpad 目录中 102 个 minidump：85 个异常码
`0xE0000008`（OOM），其中 16 个来自扩展进程（13 个 OOM、3 个断点）。
minidump 的第二个异常参数 `0xA2F9FD000` = `43,748,675,584`，与本机 Windows
commit limit（40.7 GiB）完全相等；崩溃时已提交约 38.4 GiB，仅剩约 2.3 GiB。
Windows `Resource-Exhaustion-Detector`（事件 2004）的时间点与扩展崩溃逐分钟吻合。

这是**全机 commit 耗尽**，扩展渲染进程只是最先被压垮的进程之一。渲染进程的 OOM
无法由 JS 捕获（`ErrorBoundary` 只拦 React 渲染错误），所以插件侧能做的不是“接住
崩溃”，而是**不再把内存推向极限**。

## 2. 插件侧加重因素

按贡献排序：

1. **每个 block 保留整包变量**。`recordSnapshot` 把调试模式下执行完每个 block 后的
   完整变量表存进 `RunningTask.snapshots`，并同时挂到对应 `tool` step 上。截图 /
   生成图片以 base64 data URL 形式存在变量里，单张可达数 MB。
2. **同一份数据发两遍**。`workflows.running` 同时返回 `snapshots` 与 `steps[].vars`；
   editor 的调试轮询每 800 ms、日志面板每 1200 ms 各拉一次，每次都把两份 data URL
   结构化克隆到扩展页面。
3. **完成后仍保留**。`finishRun` 把 `snapshots` 一起搬进最近 30 条 `FinishedTask`，
   即使日志详情只需要最近几次运行。
4. **无上限的步骤列表与文本**。循环任务可以产生成千上万条 step；单条 step 文本可以
   是整页 HTML 或超长错误栈。

## 3. 修复

- **删掉 `snapshots` 数组**。变量只挂在 block 的 `tool` step 上（`RunStep.vars`），
  板子的响应、`RunningTaskView`、日志视图都只走这一份数据。`recordSnapshot` 不再
  接收 `label`，因为它本来只用于构造已删除的数组元素。
- **变量包统一收敛**（`boundedVariables`，复用 `shedBulkDataUrls` /
  `capPersistedStrings` / `jsonBytes`）：
  - 先丢弃 ≥8 KB 的 data URL（保留 `[data URL dropped: N chars]` 标记）；
  - 超长字符串保留前缀 + `(N chars, truncated)` 标记（`capPersistedStrings`
    新增可选的 `reason` 参数，默认仍是 `not persisted`，不影响存储侧调用）；
  - 单包超过 32 KB 时，从超预算的变量开始替换为 `[value omitted from the run log: N chars]`；
    变量名超过 200 个时只保留前 200 个并附 `__omittedVariables` 计数。
- **步骤列表有界**：`MAX_RUN_STEPS = 500`，超出后丢弃最旧的一行；`addStep` 的文本
  按 8 KB 截断，`cancelRun` 也走同一个追加函数。
- **完成态只保留最近 3 条运行的变量**（`KEEP_FINISHED_VAR_RUNS`）；更早的 finished
  run 保留完整 trace 但删除 `step.vars`。持久化的运行日志本来就不存变量
  （`task-store.asRun` 只保留 text/nodeId/label），所以重启后行为一致。
- **摘要与错误文本**按 8 KB 截断后再进入 finished 板。
- **调试暂停的 Data 视图**改为从 `active.steps` 里反向查找该 node 的 `vars`；
  暂停时 `recordSnapshot` 已经挂在进入该 block 的 `tool` step 上，语义不变。

## 4. 被否决的方案

- **完全不记录变量**：日志详情里的变量检查器是既有功能，直接删除是功能退化；
  本次只做有界化。
- **变量改为按需拉取（新命令）**：需要新增一条跨上下文消息与应用层状态，超出本次
  “降低常驻内存”的目标，且板子仍在轮询 steps，收益有限。
- **把 `snapshots` 持久化到存储**：存储侧按 key 整写，大 data URL 会挤掉整个键的
  持久性；现有 `task-store` 已经刻意不存变量。
- **修改引擎的 `onSnapshot` 克隆约定**：引擎在回调前做 `JSON.parse(JSON.stringify())`，
  是一次性峰值；本次针对的是“常驻并反复克隆”的保留，动引擎契约的影响面更大。

## 5. 测试

- `tests/running-tasks.spec.ts`：data URL 被替换、超长字符串被截断、超大变量被省略、
  step 文本截断与 500 条上限、finished run 只有最新 3 条保留变量、summary/error 截断。
- `tests/run-detail-inspector-reset.spec.tsx`：fixture 改为把变量挂在 `tool` step 上，
  验证检查器仍可打开、关闭重开后回到 trace。

## 6. 边界

- 全机 commit 耗尽不是插件单独能解决的；本次只是显著降低扩展自身的常驻与轮询克隆量。
  真正需要的是 Windows 页面文件 / 其他进程的内存收敛（见诊断结论）。
- 步骤上限会丢掉超长运行的最早日志；对失败诊断而言末尾更重要，且 trace 仍按 block
  分组展示。
- 浏览器实证（加载 unpacked extension、debug 模式跑一个含图片的工作流）需手工验证；
  本次以单元测试与类型/构建门禁为准。

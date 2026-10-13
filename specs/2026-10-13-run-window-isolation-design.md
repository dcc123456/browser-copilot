# 定时任务并行执行的窗口隔离 · Run-window isolation for concurrent scheduled tasks — design

日期 / Date: 2026-10-13
涉及模块 / Areas: `background`（scheduler / task-runner / window-policy / automation-scope / driver / running-tasks）、`sidepanel`（Tasks 看板、Settings）、`lib`（types / i18n）、`workflow-engine`（`new-window` 块）

## 1. 需求原文 · Requested behaviour

dcc 报告：多个定时任务在同一时刻触发时**必然互相干扰**——它们控制的是同一个浏览器，
"两个页面不能同时打开"，两个 run 会在同一个页面上逐步互相踩。

裁定（AskUserQuestion，2026-10-13，已定，不再讨论）：

| 项           | 决定                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| 撞车策略     | 运行前发现 board 上已有正在运行的任务 → **新建一个浏览器窗口**跑新任务，跑完自动关闭该窗口 |
| 并发语义     | **并行执行**，不排队、不跳过（仅在超过上限之后才排队）                                     |
| 可见性       | **用户要感知"多窗口并行执行"**                                                             |
| 独占窗口上限 | 默认 **3**，设置项 `maxConcurrentRunWindows` 可调 1..6                                     |
| 超上限       | FIFO 排队，最长 9 分钟后**大声失败**，不静默跳过                                           |
| 新窗口焦点   | `focused: false` + 级联错位（每个窗口标题栏可见），**不抢用户焦点**                        |

期望结果：9:00 同时触发 3 个任务 → 3 个独立窗口各自跑完各自关闭，Tasks 看板 3 行带窗口徽章、可点击聚焦。

## 2. 现状取证 · Evidence about the current code

以下均由代码位置支撑（改动前的行为），不是推测。

- `src/background/scheduler.ts:108` `onAlarm()` 对每个到点的 alarm 直接
  `void handleScheduledRun(taskId)`：没有互斥、没有队列、也没有"已有 run 在跑"的判断。
  两个 alarm 落在同一分钟 = 两个 `runTask()` 并发。
- `src/background/window-policy.ts:153-155` `resolveUnattendedScope()` 的默认策略是
  `settings.unattendedWindowPolicy ?? 'latest'`——它只回答"哪个插件窗口最新"，
  **完全不读 running-tasks board**。因此同时触发的每个 run 都会解析到同一个窗口。
- `src/background/driver.ts:139-160` 的 tab 槽位（`pinnedTabs` / `cachedAutomationTabs`）
  按 `scope?.windowId` 分键。同一个 window scope 下的两个并发 run **共享同一个 automation tab**，
  于是双方在同一个页面上点击、打字。这是"语义互相踩"的物理来源。
- 已有的两层保护都只保证"不损坏"，不保证"不串台"：
  `src/background/driver.ts:820-858` 的 CDP 队列按 tabId 串行化 debugger 命令；
  `src/lib/key-lock.ts:30-42` 保证记录不会丢。两者都放任两个 run 交替操作同一个页面。
- local-agent bridge（`src/background/automation-scope.ts` 的 N:N 窗口绑定）已经证明
  **跨窗口并行在本扩展里是成立的**路径；同窗口内并行不成立（后台 tab 会被节流，且只有一个前台页）。

结论：冲突是结构性的，唯一无损的解法是给冲突的 run 各分配一个窗口。

## 3. 选型与证据 · Options considered（§7.1）

### 3.1 候选与否决理由

| 候选                                       | 结论     | 否决理由                                                                                                                                  |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A. 全量串行（一个全局 run 锁，后到的排队） | **否决** | 与 dcc 裁定"并行执行"直接冲突；9:00 三个任务要排到 9:15，定时任务的价值就是准点。                                                         |
| B. 冲突即跳过（`skipped`，等下一次触发）   | **否决** | 静默丢工作。`once` 型任务被跳过后就再也没有第二次机会（`scheduler.ts:123` 在触发前已经把它收走了）。                                      |
| C. 抢同一个窗口、靠 CDP 队列串行化动作     | **否决** | 只是把串台变成"交替串台"：A 的 click 落在 B 刚导航完的页面上。队列按 tabId 键，同窗口同 tab 就还在一条队列里。                            |
| D. **独占窗口并行（选中）**                | **采用** | board 空闲时零改动（继续共享插件窗口）；board 忙时新 run 自建窗口、跑完自关。跨窗口并行已有 local-agent bridge 作为可行性先例。           |
| D+. 每个 run 都独占窗口                    | **否决** | 绝大多数时刻 board 是空的，白白付一次窗口创建/关闭与页面加载的代价，还会让用户的桌面上频繁冒出一个窗口再消失。Tier 1 沿用旧行为成本为零。 |

超上限（D 的第三个 tier）为什么选 FIFO 排队而不是继续开窗：每个独占窗口都是一个真实的 Chrome
进程组，无上限并行会把用户机器拖死；`server/src/run-service.ts:174/203` 的 Runner 侧已经是
"并发位 + enqueue"的同一套语义，扩展侧对齐它比另造一套口径好。

等待预算取 9 分钟（`window-policy.ts:216 RUN_WINDOW_MAX_WAIT_MS`）而不是任意值：
`src/background/keepalive.ts:36 MAX_HOLD_MS = 10 * 60 * 1000`——一个活得比 keepalive 还久的 waiter，
正好会变成 running-tasks 文档里警告过的那种僵尸 run，剩 1 分钟给 run 自己落成 failed。

### 3.2 Chrome API 一手来源（§7.2：读 `.d.ts`，不转述文档）

本机 `@types/chrome@0.0.312`：

- `chrome.windows.create` 的参数在 `chrome.windows.CreateData`
  （本机 `node_modules/@types/chrome@0.0.312/index.d.ts:13480-13530`）：
  `url?: string | string[]`、`left` / `top` / `width` / `height`（"不指定就自然偏移于最后聚焦的窗口"）、
  `focused?: boolean`（原文："If true, opens an active window. If false, opens an inactive window."，
  Chrome 12 起）。**"后台错开、不抢焦点"是一等参数，不需要任何 hack。**
- 同处的 `state?: windowStateEnum`（Chrome 44 起）带一条硬约束：`'minimized' | 'maximized' |
'fullscreen'` **不能与 `left`/`top`/`width`/`height` 同时使用**。这解释了 §4 里最小化那一行为什么
  只能单独建窗，也定下 §5.2 的口径：run 窗口只走 `normal` + 几何参数，永远不最小化。
- `chrome.windows.remove(windowId)` / `get(windowId)` / `onRemoved` 均存在；`remove` 对已被用户
  手动关掉的窗口会 reject，因此 `closeRunWindow` 必须 `.catch()`（已实现）。
- `chrome.storage.session`：随浏览器会话存活、**跨 service-worker 重启存活**、随浏览器退出清空，
  正是"独占窗口注册表"需要的生命周期——孤儿窗口只可能来自 worker 被回收，而不是浏览器退出。
- 权限：**无需新增任何权限**。`chrome.windows` 不在 manifest 权限模型里（本机
  `manifest.config.ts:64-86` 的现有清单已含 `storage`/`tabs`/`debugger`，`chrome.storage.session`
  由既有的 `storage` 权限覆盖）。
- CDP 兜底手段存在且命名正确：`Emulation.setFocusEmulationEnabled`，见本机
  `node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/types/protocol.d.ts`
  （以及 `lib/server/chromium/crPage.js:418` 的真实调用）。**尚未接入**，取决于 §4 的实测结论。

## 4. 节流实测 · The throttling spike — **结论无效，问题 BLOCKED**

spike 在 `tmp/run-window-throttle/`（`spike.mjs` + `report.json` + `spike2.log`，按 §7.3 不入库）。
矩阵是 5 个窗口：可见未聚焦 / 被完全遮挡 / 遮挡 + `setFocusEmulationEnabled` / 最小化 / 聚焦参照，
每个窗口测 rAF 频率、`setTimeout(16)` 实际节奏、`document.hidden` / `visibilityState` / `hasFocus()`，
外加功能性检查（未聚焦窗口内 click、CDP 打字、读回 input.value、截图）。

原始数字（`report.json` t+20s，Playwright 驱动真实 Chrome）：

| 窗口              | raf  | timers | visibility | hidden | hasFocus | click+type | 截图            |
| ----------------- | ---- | ------ | ---------- | ------ | -------- | ---------- | --------------- |
| visibleUnfocused  | 2558 | 1275   | `visible`  | false  | **true** | ok         | 8077 B          |
| occluded          | 2568 | 1278   | `visible`  | false  | **true** | ok         | 7200 B          |
| occluded+FocusEmu | 2552 | 1270   | `visible`  | false  | **true** | ok         | 7654 B          |
| minimized         | 2527 | 1246   | `visible`  | false  | **true** | ok         | **ERR 8s 超时** |
| focusedRef        | 3411 | 1697   | `visible`  | false  | true     | ok         | 7678 B          |

**这组数字不能用来回答"后台窗口会不会被节流"**，两条硬证据：

1. 五个窗口同时报 `hasFocus() === true`、最小化的窗口报 `visibilityState === 'visible'`——真实 Chrome
   不可能这样。也就是说被测环境根本没有把窗口标记为 hidden/occluded，节流条件从未成立。
2. 原因可定位到 harness 本身：Playwright 自带一组关闭节流的首选项，见本机
   `playwright-core/lib/server/chromium/chromiumSwitches.js` ——
   `--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、
   `--disable-renderer-backgrounding`。这正是本实验要观察的三个机制，被启动参数全量关掉了；
   另外每个页面都挂着 CDP 会话（driver 本身也走 CDP），这同样会保持帧供应。

所以 §3.2 的决策树里"哪个分支成立"**仍未定**，本轮不假装它是绿的。已知的只有一条可靠的副产品：
**最小化窗口的截图会超时**（表中唯一 ERR），因此独占窗口绝不能最小化
（`createRunWindow` 只用 `normal` + `focused:false`，且从不 `state:'minimized'`）。

待 dcc 在场时用真实扩展做的复测步骤（不依赖 Playwright 的默认参数）已写进 §8。
预案不变：若真实 Chrome 下未聚焦窗口确实被节流，就在 `driver.ts` 的 `withCdpSession`
（`driver.ts:820-858`）里对 `isRunOwnedWindow(scope.windowId)` 的 tab 首次 attach 时补一条
`Emulation.setFocusEmulationEnabled`；若这条也无效，停下来重新表态，不自行改成抢焦点。

## 5. 设计 · Design

### 5.1 三层漏斗（策略归 `window-policy.ts`）

```
leaseRunWindow(selfRunId, signal, onWait) → { windowId?, dedicated, tier? }
```

- **Tier 1 board 空闲** → `{ windowId: <共享插件窗口>, dedicated: false }`。今天的行为，字节级零变化，
  不产生任何窗口开销。
- **Tier 2 board 忙** → 抢一个级联 slot（tier 0..cap-1）→ `createRunWindow(runId, tier)` →
  `{ windowId, dedicated: true, tier }`。
- **Tier 3 slot 占满** → FIFO 队列（`window-policy.ts:257-304`，语义镜像
  `server/src/run-service.ts:203-215` 的 `enqueue`），可被 run 自己的 abort signal 取消
  （`RunWindowUnavailableError('cancelled')`），9 分钟超时 →
  `RunWindowUnavailableError('capped')` → 大声失败。
- busy 判定（`window-policy.ts:327-330`）：board 上存在另一个 run，且它记录的窗口就是共享窗口，
  **或者它压根还没记录窗口**（聊天回合 / 尚未定窗口的 run）——后一种按最坏情况处理，主动让开。
  这条同时修掉了"定时任务踩用户正在聊天的窗口"。
- Chrome 拒绝建窗（`windowId === undefined`）时退回共享窗口，而不是让整个 run 因一个窗口而失败。
- `retain()` 在 await lease **之前**（`task-runner.ts` 沿用既有顺序），所以两个同时触发的 alarm
  **双方都能看见对方**、各拿一个窗口，而不是先到的那个把后到的判成空闲。

**用户手势发起的 run 永远不进这个漏斗**：面板 Run 按钮、快捷键（`index.ts:235` 区段）、右键菜单、
visit-web、编辑器运行都自带显式 `scopeWindowId`，行为与改动前一致。

### 5.2 窗口生命周期归 `automation-scope.ts`（注册表，不是策略）

- `createRunWindow(runId, tier)`：`chrome.windows.create({ focused: false, left: 80+tier*56,
top: 60+tier*44, width: 1280, height: 860 })`（`RUN_WINDOW_TILE`，`automation-scope.ts:252`）。
  **不带 url**：为一个首块可能是 `wait` 的 run 付一次页面加载不值；首个动作经既有
  `updateActiveTabUrl`（`driver.ts:1355`，已支持 scope）自然导航。
- `closeRunWindow(windowId)`（`automation-scope.ts:322`）：**先查所有权**，没有记录就直接 return——
  既幂等，也不可能误关一个不属于 run 的窗口（这条是测试逼出来的：`remove` 曾被调用了两次）。
  然后 `releaseWindowAutomationState` → `chrome.windows.remove().catch()` → 更新镜像。
- 注册表 `runOwnedWindows: Map<number, {runId, closed}>` + 写穿 `chrome.storage.session` 的
  `bc:runOwnedWindows`（`automation-scope.ts:245`）。session storage 的生命周期恰好覆盖
  "worker 被回收但窗口还在"。
- 孤儿回收 `reclaimOrphanRunWindows(isLiveRun)`（`automation-scope.ts:343`）：镜像里的 `runId`
  不在活的 board 上、而窗口还 `windows.get` 得到 → 关掉。入口两个：worker 唤醒
  （`index.ts:735 recallRunWindowsOnWake()`）与 `leaseRunWindow` 首次进入时的一次性 sweep
  （alarm 唤醒不会触发 `onStartup`，正是孤儿出现的时刻）。
- 独占窗口**绝不**注册进 panel / minimized 注册表，因此对 `isPluginWindow`、`latestPluginWindowId`、
  `listNormalWindows` 的插件过滤、`shouldTriggerVisitWeb` 全部不可见。这是刻意的：用户的
  "最新插件窗口"不应该因为一个后台 run 的临时窗口而漂移。

### 5.3 driver 的两处必修（`src/background/driver.ts`）

1. `releaseWindowAutomationState(windowId)`（`driver.ts:126`）：删掉该窗口的 `pinnedTabs` 槽位与
   `cachedAutomationTabs` 槽位。`pinnedTabs` 原本**只有 5 分钟 TTL 会清**，任何按窗口建的临时容器
   都会在 run 结束后留一根脏指针；由 `index.ts:734 setRunWindowPruner(...)` 注入，避免
   automation-scope 反向依赖 driver。
2. `resolveAutomationTabUncached` 的泄漏修复：作用域窗口已不存在时，原代码会退回全局链
   （`getLastFocused` / `windows.getAll` / 全局 `tabs.query`）——run 的专属窗口被自动关闭后，
   后续动作会**静默打进用户自己的窗口**。现在 `isRunOwnedWindow(scope.windowId)` 且窗口没了就直接
   `return undefined`（报"无可操作页面"）；非独占窗口保留既有降级，`tests/driver-scope.spec.ts`
   的旧契约继续绿。

### 5.4 用户怎么感知（纯增量，不改执行行为）

- `running-tasks.ts:81-83 / 118-121` 给 `RunningTask` / `FinishedTask` 加
  `windowId?` 与 `runWindowKind?: 'shared' | 'dedicated'`，`setRunWindow(runId, windowId, kind)`
  （`:263`，照 `setRunWorkflow` 的模式）在 lease 当场记录，`finishRun`（`:319-320`）复制到 finished。
- `index.ts:1016-1064` 的两个 board 投影各带这两个字段；新命令 `tasks.focusWindow { runId }`
  （`index.ts:1427`）→ `chrome.windows.update(windowId, { focused: true })`，窗口已关时返回
  `{ ok: false, closed: true }`。
- `RunningBoard.tsx`：`windowId` 存在时渲染一枚徽章按钮（沿用现有 `run-tag` 惯用类 +
  `bg-transparent hover:bg-hover` 语义 token，无 hex，§2），点击派发 `tasks.focusWindow`，
  失败弹 `taskRunWindowGone` 的 toast。
- i18n（§3，封闭 `Messages` 两侧同时给）：`taskRunWindow` / `taskRunWindowDedicated` /
  `taskRunWindowFocus` / `taskRunWindowGone` / `taskRunQueued` / `taskRunWindowCapReached` /
  `taskRunCancelledWhileQueued` / `settingsMaxRunWindows` / `settingsMaxRunWindowsHelp`。
- Settings 的"无人值守窗口策略"卡片里加 `maxConcurrentRunWindows` 数字输入
  （`SettingsTab.tsx:1613/1628`），钳制走 `src/lib/types.ts` 的 `RUN_WINDOW_LIMITS`
  （default 3 / min 1 / max 6）与 `normalizeRunWindowLimit`，`window-policy` 读
  `settings.maxConcurrentRunWindows` 原值。

### 5.5 顺手修掉同源的缺陷（`new-window` 工作流块，§5.6 双侧落）

`new-window` 块原来的契约是假的：executor 调 `driver.newWindow(url)` 把返回的窗口丢掉，也不回指
`ctx.scope`，于是"后续块在新窗口里操作"根本不成立。

- 扩展侧：引擎现在持有 run 级可变 `runScope`（`engine.ts:660`），每个块的 ctx 由它重建，
  ctx 上多一个 `setScope` 钩子（`executors.ts:159`，与既有 `setTab` 同构）；`newWindowExec`
  拿到窗口 id 后同时 re-point 窗口与该窗口的活动 tab，AI 接管请求与子工作流也都跟着
  `runScope` 走。
- Runner 侧：headless 的"窗口"就是 page，`driver.newTab()` 会把新 page 设为 active，
  镜像动作是 `ctx.tabId` + `ctx.setTab`（`server/src/executors.ts:1413`），两侧各有测试。
- **已知残留**：专属 run 窗口里的 `new-window` 块自己开的窗口不属于 lease 注册表，
  run 结束只回收 lease 的那个窗口。留待后续，不在这一次偷偷扩大生命周期范围。

### 5.6 Runner 侧无需镜像（§5.6 的显式声明）

`server/src/**` 没有窗口/scope 概念：每个 run 已经是独占的 Playwright context，天然隔离，
不存在"两个 run 抢同一个页面"这一类问题。所以 §5.1–§5.3 的漏斗与生命周期**在 Runner 侧没有对应物**，
写在这里是为了避免 §5.6 被误读成"漏了一半"。两侧必须同步的是 §5.5 的 `new-window` 块契约与共享内核
（`src/inpage/kernel.ts` 未改动）。

## 6. 测试 · Tests written

| 文件                                              | 覆盖                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tests/automation-scope.spec.ts`（扩展）          | 注册/镜像/`onRemoved` 保留条目/幂等关闭/不关非自有窗口/孤儿回收谓词（6 例）                                                     |
| `tests/run-window-lease.spec.ts`（新）            | 空闲→共享、忙→独占、同刻两个 alarm 双方独占、排队可取消、达上限超时、插件全关仍独占、建窗失败退回共享（13 例）                  |
| `tests/task-runner-run-window.spec.ts`（新）      | 两个并发 run 拿到不同 `scopeWindowId`、抛错/取消各关一次窗口、孤立 run 仍走 `resolveUnattendedScope`、workflow 分支透传（7 例） |
| `tests/running-board-window-badge.spec.tsx`（新） | 徽章两种文案、点击派发 `tasks.focusWindow`、窗口已关的 toast（4 例）                                                            |
| `tests/driver-scope.spec.ts`（扩展）              | owned-gone 不回落全局链；`releaseWindowAutomationState` 只删自己槽位（2 例）                                                    |
| `tests/running-tasks.spec.ts`（扩展）             | `setRunWindow` 落到 running 与 finished                                                                                         |
| `tests/providers.spec.ts`（扩展）                 | `maxConcurrentRunWindows` 默认值与钳制、快照修复                                                                                |
| `tests/workflow-task-run.spec.ts`（扩展）         | mock 补齐新导出，原有 workflow 任务用例不回归                                                                                   |
| `tests/new-window-scope.spec.ts`（新）            | `new-window` 块 re-point 窗口与 tab、查询限定在新窗口、未接线时仍自更新（3 例）                                                 |
| `tests/workflow-engine.spec.ts`（扩展）           | 块改过窗口后，后续块与接管都跟着走                                                                                              |
| `server/test/executors.test.ts`（扩展）           | Runner 侧 `new-window` 把 run 指到新 page，下一步落在该 page                                                                    |

## 7. 门禁 · Gates

`pnpm typecheck` · `pnpm test` · `pnpm lint` · `pnpm format:check` · `pnpm build` ·
`pnpm server:typecheck` · `pnpm server:test`。本改动不涉及 `executeScript({func})` 内联函数体，
`pnpm verify:injected` 无需重跑（改动文件里的 `func:` 都是既有具名函数）。

## 8. 待办证据 · Evidence still missing（§⑤，不许用绿灯冒充）

1. **节流矩阵的真实 Chrome 复测**（§4）：在装了 unpacked extension 的 Chrome 里开两个
   `focused:false` 窗口，其中一个被用户窗口完全遮挡，直接在 SW 控制台测 rAF/定时器节奏；
   只有这个环境才没有被 Playwright 的启动参数污染。结论决定 §3.2 的 CDP 兜底要不要接。
2. **两个任务同时触发的端到端**：建两个 `interval: 1 分钟` 的任务（各自 open-url + 约 90 秒动作），
   断言并截图：两个专属窗口各自独立完成、内容互不串；级联错位可见；跑完两个窗口都消失；
   面板两行都带"专属窗口"徽章且点击可聚焦；SW 控制台记录 `pinnedTabs.size` run 前后归位。
3. `pnpm selftest`（build → reload → generate → replay）确认常规链路没被打坏。

以上三项在提交时仍未取得，收尾自检 ⑤ 标 **BLOCKED**。原因不是"没想到怎么做"，而是三条具体阻碍：

- 这些结论必须来自装了本次构建的真实 Chrome 会话，单元测试与代打窗口的 Playwright 都无法替代，
  而现有的 Playwright 实测因 harness 自带反节流参数而无效（§4）。
- 本 worktree 同时有另一个会话的未提交改动（`src/lib/llm.ts` 等）。`pnpm build` 是整树构建，
  把这样的 dist 加载进浏览器后，观察到的行为无法归因到本次改动，失败也无法判定是谁造成的。
- 第 2 项会在 dcc 日常使用的浏览器里真开出后台窗口、并按任务调用 provider 计费。dcc 不在场时
  不打扰他的浏览器，也不花他的额度。

dcc 在场时按 §8.1/§8.2 的步骤补测；补测结论若与 §4 的预案分支不同，回来改这份文档。

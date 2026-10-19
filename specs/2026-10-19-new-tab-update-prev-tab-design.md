# 新建标签页算子：更新之前打开的标签

裁定来源：用户诉求「新建标签页算子的『更新之前打开的标签』功能——更新之前由新建标签块创建的
标签，而不是创建一个新标签。没有实现，帮我实现」。

## 1. 现状：这是一个已经做完一半的功能

`updatePrevTab` 在仓库里**已经有了除执行以外的一切**：

- `catalog.ts` 的 `new-tab.data.updatePrevTab: false`；
- `EditNewTab.tsx` 的复选框（label `Update previously opened tab`）；
- `workflow-editor/i18n.ts` 的中英文案（`更新之前打开的标签页` / 提示语）。

缺的只有执行：`newTabExec` 从头到尾没读过这个字段，直接 `driverNewTab(url, ctx.scope)` 每次
新建一个标签。正因为它不被任何执行器读取，`operator-tools.ts` 的
`SCHEMA_OMIT['new-tab']` 把它从模型 schema 里摘掉了——那条规则的原话是「广告一个静默失效的
开关，等于让工作流承诺它并没有的行为」。

本次就是把执行器补上，不动表单、不动文案。

## 2. 「之前打开的标签」指哪一个

按 Automa 的原语义，这个记忆是**由 `new-tab` 块自己维护的一个标签 id**，不是「当前标签页」：

- 每个 `new-tab` 块执行完（无论是新建还是复用），把结果标签 id 写回记忆；
- 下一个 `new-tab` 块若勾了 `updatePrevTab` 且记忆里有还活着的标签，就复用它，否则新建。

区分这两点很实际：`new-tab(A) → 若干步 → new-tab(B) → new-tab(updatePrevTab)` 复用的是 **B**，
不是 A；而 `ctx.tabId` 会被 `switch-tab` / `link` 等块改来改去，拿它当记忆会在跳走之后回不来。

循环体内的用法（列表页逐个进详情，用完一个标签而不是开 N 个）依赖的就是这一点：循环复用同一个
`runCore` 闭包，所以每轮迭代看到的都是上一轮写回的那个 id。

## 3. 记忆放在哪：run 级盒子，不放 variables

引擎**每个块重建一次 ctx**（`engine.ts` 注释：「engines do not persist across blocks beyond
`variables`」），所以记忆必须是 run 拥有的一个可变对象，由 `runCore` 分配一次、每个 ctx 共享
同一个引用：

```ts
tabMemory?: { prevNewTabId?: number }
```

考虑过、否决的替代方案：塞一个保留键进 `ctx.variables`。`variables` 确实是唯一天然跨块的共享
对象，改动最小，但它是**用户可见**的——会出现在调试快照、变量列表、`{{...}}` 插值命名空间里，
一个 `__prevNewTabId` 数字对用户毫无意义，还可能在子工作流之间意外串味。引擎对非用户态的
run 级数据一律用闭包变量 + ctx 注入（`targetTabId`、`runScope`、`stepLines` 都是这个形状），
这里跟随同一个模式（§5.3 扩展现有接口，不新建平行机制）。

子工作流（`execute-workflow` → 递归 `runCore`）拿到**新的**盒子，与 Automa 按 workflow id
分桶的 `replayState` 一致：父流程的标签不该被子流程的「复用上一个标签」认领。

## 4. 复用的三种边界

- **标签已经没了**（用户手动关掉、页面 `window.close()`、随窗口销毁）→ **回退成新建**，
  绝不报错。这一步要的本来就是「有一个可操作的标签」，为「标签被关了」而失败整条工作流没有道理。
- **URL 留空** → 只把这个标签切回前台，**不导航**。地址是 `about:blank` 时强行写一遍等于白白
  重新加载一次（与 `reload-tab` 那次裁定同源：一次导航就是导航，不做多余加载）。
- **URL 非 http(s)** → 与新建路径同一套校验（`collapseDoubledScheme` + `isInjectablePage`），
  放进 driver 层，和 `newTab` 保持同一个位置。

`active` 保持和今天新建路径**完全一致**的行为（`driverNewTab` 硬编码 `active: true`，复用路径
同样置前）。表单上那个「Set as active tab」复选框今天也不被执行器读取，属于另一处未接线，
本次不顺手实现——一次只补一个诉求（§5.5）。

## 5. 不进模型 schema（本次不改）

`updatePrevTab` 继续留在 `SCHEMA_OMIT['new-tab']` 里，理由：

- `new-tab` 现在只广告 `url` 与 `waitTabLoaded`，`userAgent` / `active` / `tabZoom` /
  `inGroup` / `customUserAgent` 同样不广告；只把这一个摘出来是打破既有取舍；
- 复用与否取决于「前面有没有开过标签、该不该复用」，这是模型在单轮工具调用里看不到的 run 级
  上下文，广告出去容易换来「第一个 new-tab 就勾复用」——那一刻记忆是空的，行为退化成新建，
  白付一个 schema；
- 每轮常驻预算只剩 65 字符（`tests/agent-payload-size.spec.ts`，round-1 实测 59 835 / 上限
  59 900），加一个带描述的参数必然要再抬一次预算。

执行器落地后若要开放，只需从 `SCHEMA_OMIT` 删掉该键并补一条 `SCHEMA_OVERRIDES` 描述，预算按
该文件头部的流程**显式**上调。

## 6. Runner 侧镜像（§5.6 硬性契约）

好消息是 Runner **复用同一个纯引擎**（`server/src/run-service.ts` 直接 import
`src/background/workflow-engine/engine` 的 `runWorkflow`），所以 §3 的盒子只需在引擎里分配一次，
两个宿主自动都有。要各自落地的只有驱动与执行器：

- `src/background/driver.ts`：新增 `reuseTab(tabId, url?)`，`chrome.tabs.get` 探活 → 活着就
  `chrome.tabs.update(id, { active: true, url? })`，没了返回 `null`；
- `server/src/driver.ts`：同名 `reuseTab`，用现成的 `pageById(tabId)` + `isClosed()` 探活，
  活着则 `page.goto(url)` 并把 `this.active` 指过去，没了返回 `null`；
- 两侧 `newTabExec` 读同一个 `updatePrevTab` 字段、同一套回退与写回逻辑、同一条结果文案。

两侧各有一条测试。

## 7. 验收

- `tests/workflow-executors.spec.ts`：勾了 `updatePrevTab` 且记忆里有活标签 → 调
  `tabs.update` 而**不**调 `tabs.create`；标签已关 → 回退新建；新建过的标签 id 被写回记忆；
  URL 留空 → 复用但不导航。
- `server/test/executors.test.ts`：Runner 镜像的同一组断言。
- 机检：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build`、
  `pnpm server:typecheck`、`pnpm server:test`。
- 改动触及 `src/background/workflow-engine/**`，按收尾自检 ③ 附 `pnpm bench:debug` 的
  before/after。
- 浏览器证据：`pnpm selftest` 或加载 unpacked 后手工跑一条「列表页逐个进详情、复用同一个标签」
  的工作流，写明步骤与观察到的现象；拿不到就标 BLOCKED。

## 8. 浏览器实测证据（2026-10-19）

Runner 侧用真实 Chromium 端到端跑通，证据由 `tab-url(scope: all)` 从 driver 的
活动页面列表读回——不是块自己声称"我复用了"，而是浏览器的标签实况。脚本
`tmp/evidence-tab-reuse.ts`（一次性探针，按 §7.3 留在 tmp/，结论进本节），
结果 `tmp/evidence-tab-reuse.json`。三条工作流各跑一遍，本地 fixture 站点同时记录
每次文档请求：

| 工作流                                   | 步骤回显                                        | 浏览器活动标签       | fixture 收到的文档请求 |
| ---------------------------------------- | ----------------------------------------------- | -------------------- | ---------------------- |
| 各开一个（`updatePrevTab: false`，对照） | `已打开 …/a (tab #2)`、`已打开 …/b (tab #3)`    | `共 3 个标签页`      | `/a`、`/b` 各一次      |
| 复用（`updatePrevTab: true`）            | `已打开 …/a (tab #2)`、`已复用 …/b (tab #2)`    | `共 2 个标签页`      | `/a`、`/b` 各一次      |
| 刷到指定地址（`reload-tab` 带 url）      | `已打开 …/a (tab #2)`、`已刷新当前标签页 → …/b` | `tab-url` 回读 `…/b` | `/a`、`/b` 各一次      |

对照与复用两行的差别就是这次要实现的行为：第二个块的 tab id 仍是 **#2**，活动页面
总数 3 → 2，说明回到原标签而不是再开一个。三行的 fixture 请求都只有 `/a`、`/b`
各一次，说明没有"goto 之后又 reload"的双次加载。

**扩展宿主（chrome.tabs）仍未取到证据，标 BLOCKED**：本地 Agent bridge 通
（`tools.list` 有应答），但 CLI 连接报"还没有分配浏览器窗口"，需要人在插件面板
的"本地 Agent 接入"里把该连接分配给一个窗口；并且浏览器当前加载的 build
（`99a3a425ef8426e1`）比 `dist/` 旧，还要一次 reload 才带上这次改动。两步都需要
人手，脚本无法代劳。已确认 `dist/` 里确实带了新代码（`已复用标签页`、
`prevNewTabId`、`已刷新当前标签页 → ` 三条都在后台 bundle 中）。引擎是两侧共用的
同一份纯实现，上表已经证伪/证实了引擎侧的记忆传递；未证的就剩
`chrome.tabs.get/update` 这层薄封装，由 mock 测试覆盖。

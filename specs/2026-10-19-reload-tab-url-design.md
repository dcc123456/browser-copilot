# 刷新标签页算子：可选 URL

裁定来源：用户诉求「工作流的刷新标签页算子增加一个可选的 url 输入属性；当用户填写了这个 url
就将当前标签页的 url 替换成这个 url 并重新加载」。

## 1. 范围裁定

`reload-tab` 今天是一个**无设置**算子：catalog 条目带 `disableEdit: true`，编辑器只渲染
一句提示（`EditReloadTab` 里的 "This block reloads the active tab."），执行器无条件
`chrome.tabs.reload(tab.id)`。

本次给它加一个**可选** `url`：

- 留空 → 行为完全不变，仍然是「原地刷新当前标签页」；
- 填了 → 把当前标签页导航到该 URL 并等加载完成。

不做：多标签页批量刷新、正则匹配 URL、`waitTabLoaded` 之类的附加开关、缓存绕过
（`chrome.tabs.reload` 的 `bypassCache`）。诉求只说「替换 url 并重新加载」，一个输入框就够。

## 2. 一个必须知道的连带后果：reload-tab 会进入 LLM 算子集

算子集是**派生**的，不是单独维护的清单：

- `operator-tools.ts` / `operator-categories.ts`：`!entry.disableEdit || EDIT_LESS_OPERATOR_IDS.has(id)`
- `tool-catalog.ts` 的 `OPERATOR_META`：`!entry.cloud && !entry.disableEdit`

仓库里**没有**「有编辑表单但不给模型用」这个概念——`disableEdit` 是唯一的排除开关。所以要让
用户在画布上填这个 URL，就必须去掉 `disableEdit`，代价是 `reload-tab` 变成 `wf_op_reload-tab`，
进入 `browser` 分类（按需加载，不进每轮常驻 core），并出现在设置页的算子工具清单里。

判定：**接受**。理由

- 这个能力对生成端同样有用（"刷新到某个 URL" 本来只能用 `new-tab` 表达，而 `new-tab` 会新开标签页）；
- 执行器真实存在（`operator-exec-bridge.spec.ts` 要求 `execute` 类算子必须有 executor），落地即生效；
- 另造一套「可编辑但不给模型」的开关是新增基础设施，为一个块付这个代价不划算（§5.5）。

`reload-tab` 早已在 `reliability.ts` 的 `SAFE_BLOCK_IDS`（幂等导航）与 `readiness.ts` 的
`navigation-settled` 映射里，两处都自动覆盖「带 URL 刷新」这一新形态，无需改动。

## 3. 导航语义：一次导航，不是「跳转 + 再刷新一次」

诉求字面是「替换 url 并重新加载」。实现上只做**一次导航**：`chrome.tabs.update(tabId, { url })`
本身就是「把地址换成这个并加载」。再补一次 `chrome.tabs.reload` 会让页面加载两遍，对有副作用的
页面（埋点、幂等失效、下单页）是真实风险，所以不做。

复用既有能力（§5.1）：`open-url` 执行器已经有一整套「校验 → 更新 → 等加载」的逻辑，
`lib/pages.ts` 的 `collapseDoubledScheme` / `isInjectablePage` 也是同一套规则。抽出一个
`navigateRunTab(url, ctx)` 供两个执行器共用，避免第二份实现（§5.2）。

URL 里的 `{{变量}}` 由引擎在进执行器前统一插值（`engine.ts` 的 `interpolateParams`），
执行器内不再重复插值——与 `open-url` 保持一致。

## 4. 数据参数：url 是业务数据

`data-params.ts` 里 `new-tab` / `new-window` / `switch-tab` / `close-tab` 的 `url` 都被登记为
data param——生成期写下的字面 URL 是「死数据」，重放只会复现那一次。`reload-tab` 如今同样能带
一个 URL，必须登记为 `[{ key: 'url' }]`，否则录出来的节点会把生成期地址冻死。

## 5. Runner 侧镜像（§5.6 硬性契约）

`reload-tab` 的驱动行为必须两侧同时落地：

- `src/background/workflow-engine/executors.ts`：`chrome.tabs.update` + `waitForTabLoaded`；
- `server/src/driver.ts`：`reloadTab(url?)` 带 URL 时 `page.goto`，否则 `page.reload`；
- `server/src/executors.ts`：读同一个 `url` 字段并 `interpolate`。

两侧各有一条测试。

## 6. 文案

编辑器表单文案走 `workflow-editor/i18n.ts` 的 `BLOCK_FORM_STRINGS_ZH`（`bt()` 以英文原文为
key）。标签复用已有的 `'URL (optional)'`（已译），只新增一条说明「留空=原地刷新，填了=先跳到
该 URL」的提示。`block-i18n.ts` 的中文描述同步改成提到 URL。

## 7. 验收

- `tests/reload-tab-url.spec.tsx`（新增）：表单把 URL 写进 `data.url`；空值不写。
- `tests/workflow-executors.spec.ts`：空 URL → 只调 `tabs.reload`；有 URL → 调
  `tabs.update(id, { url })` 且**不**再 `tabs.reload`；非 http(s) 地址抛错。
- `server/test/executors.test.ts`：Runner 镜像的同一组断言。
- 机检：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、
  `pnpm server:typecheck`、`pnpm server:test`。
- 浏览器证据：`pnpm selftest` / 手工加载 unpacked 后跑一条「刷新到指定 URL」的工作流。
  本次改动触及 `src/background/workflow-engine/**`，按收尾自检 ③ 需附 `pnpm bench:debug`
  的 before/after。

## 8. 浏览器实测证据（2026-10-19）

真实 Chromium 端到端（探针 `tmp/evidence-tab-reuse.ts`，结果
`tmp/evidence-tab-reuse.json`，与 new-tab 复用共用一次取证）：
`new-tab(…/a)` → `reload-tab(url=…/b)` → `tab-url(active-tab)` 的三步工作流跑通，
回显 `已刷新当前标签页 → http://127.0.0.1:8942/b`，随后 `tab-url` 从浏览器读回的
活动地址就是 `…/b`；全程 tab id 始终是 **#2**（没有多开标签），fixture 站点只收到
`/a`、`/b` **各一次**文档请求——这否掉了"先 goto 再 reload"的双次加载写法。

扩展宿主的 `chrome.tabs.update({url})` 分支仍标 BLOCKED，原因与取证步骤同
`specs/2026-10-19-new-tab-update-prev-tab-design.md` §8（bridge 连接需人工分配窗口

- 一次扩展 reload）。

表单侧另有 `tests/reload-tab-url.spec.tsx`（6 例）：URL 写回 `data.url`、清空写回
`''`（执行器据此走原地刷新）、没有 `url` 键的旧节点打开时字段为空，以及
`URL (optional)` 标签与"两种模式"提示在 en / zh 两侧都取得到中文——
`EDITOR_STRINGS`/`BLOCK_FORM_STRINGS` 没有封闭类型兜底，这条只能由测试锁住。

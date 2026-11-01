# 只读模式工具裁剪 + 半自动风险确认 · Design & Plan

日期：2026-11-01
状态：已实现（代码 + 单测 + 真浏览器探针全绿）

## 0. 用户需求

1. 「对话的只读模式下 所有的写操作工具都不加载到提示词中 减少 token 消耗」
2. 「半自动模式下 不是所有操作都要确认 只有有风险的操作才需要确认 比如点击付款 填密码等操作需要确认，
   读页面、滚动页面这种动作就不需要确认」

用户通过确认框裁决了三个边界：

- 无法识别目标（既没有快照 ref，也没有可用的可读标识）→ **确认**（保守）。
- 风险范围 → **资金 + 凭据 + 破坏 + 发送**（另含 `run_javascript`、`create_skill`、
  `create_scheduled_task`）。
- 半自动下的读页面 → **完全不确认**（即使页面不是用户手动 attach 的）。

## 1. 只读模式：写工具根本不下发

### 现状（已存在，本次补漏）

`advertiseTools` 早已在 `readonly` 下过滤掉 `ACTION_TOOLS` 中的非观察工具
（`agent.ts` 的 `toolsForMode` / `advertiseTools`）。真正的问题是两处漏洞与一处死路：

1. `get_secret` 会把已保存的凭据填进页面输入框，但它不在 `ACTION_TOOLS` 里，导致只读模式既能
   看到也能执行它。本次把它加入 `ACTION_TOOLS`（并注明理由），由 `isObservationTool` 排除；
   半自动下由风险分类器判定为凭据类。`isPageAction('get_secret')` 相应变为 `true`。
2. `load_tools` 的 `groups` 枚举仍列出了只读模式根本加载不出来的组合（如 `forms`、`flow`、
   `keys`、`vision`、`script`），模型会白跑一轮。新增 `READONLY_LOADABLE_GROUPS`：只保留
   “至少含一个非写、非视觉工具”的组，实测枚举为 `tabs, data, skills, ops, delegate`。
3. 删除旧的“读页面豁免”机制（`needsConfirmation` / `grantedPageUrl` / `isSamePage` 用法）：
   风险确认不再按“是否 attach 过页面”判断，读页面在所有可执行模式下都不再弹确认。

### 实测结果（真浏览器，`tmp/risk-gate-probe.mjs`）

只读模式第一轮下发的工具只有 8 个，且全部是观察或元工具：

```
read_current_page, snapshot_page, read_selected_element, recognize_image,
screenshot, load_tools, ask_user, present_plan
```

`load_tools` 枚举：`tabs, data, skills, ops, delegate`。第一轮 payload 因此远小于 full auto。

## 2. 半自动：按风险确认

### 2.1 判定分层

- 模式层 `modeAutoApproves(mode, name)`：`full` / `workflow` 全放行；`semi` 放行观察类
  （`READ_TOOLS` ∪ `{screenshot, recognize_image}`），其余进入调用层判定。
- 调用层 `assessActionRisk(name, args, resolve)`（`src/lib/action-risk.ts`，纯函数、
  chrome-free）返回 `{risky, reason}`：

| reason           | 触发                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `payment`        | 命中付款/订单/订阅等词（中英双语词表）                                    |
| `credentials`    | `type=password` 输入框、密码/验证码/卡号/OTP 等词，或 `get_secret`        |
| `destructive`    | 删除/清空/重置/注销/退订等词                                              |
| `sending`        | 发送/发布/分享/评论/回复等词，或 `press_key` 的 Enter                     |
| `script`         | `run_javascript`                                                          |
| `persistent`     | `create_skill`、`create_scheduled_task`                                   |
| `unknown-target` | 元素动作（click/fill/select_option/set_checkbox）既无强标识也无输入框类型 |

### 2.2 目标证据从哪来

`riskTargetOf(args, ctx.snapshotTargets)` 优先取快照 ref 对应的可访问名与输入类型
（`snapshot_page` 已缓存），否则读取内联 `args.target` 的 primary/fallback spec：

- **强标识**：可访问名、`role` / `text` / `id` / `name` / `testid` / `cdp-shadow` spec、
  输入框类型。强标识可以证明“安全”。
- **弱标识**：纯 CSS 选择器（如 `#pay-now`、`.checkout-btn`）。弱标识**可以证明危险**
  （词表命中即确认），但**不能证明安全**，因此无其他证据时落入 `unknown-target` 并确认。

这条规则就是用户裁决第 1 条的落地：宁可多问一次，也不让“认不出是什么”的按钮直接执行。

### 2.3 复合工具

- `run_plan`：内层步骤由 `executeTool` 直接执行、绕过逐动作确认，因此分类器递归检查每个
  step，任一步有风险即整张计划先确认。
- `press_key`：仅 Enter / NumpadEnter 视为提交（`sending`），方向键等放行。
- 委派子代理复用父级 `deps.confirm`，同一套门禁自然生效；无人值守路径
  （`agent-unattended.ts`）只放行观察工具。

### 2.4 放行的典型动作

读页面、`snapshot_page`、截图/识图、滚动、等待、导航、标签页管理、`save_local`、`ask_user`、
`use_skill`、`load_tools`、以及有明确可访问名的普通点击/填写。

## 3. 文案与提示词

- 系统提示第 6 条与半自动模式段落改为“只有风险动作先问”，并说明确认卡展示的是动作摘要，
  要求模型精确写出按钮/字段与值。
- 设置面板 `modeSemiHint` 双语更新（en + zh-CN）。
- 工具描述里过时的 “Requires approval.” 清理：读/观察类与 `save_local` 删除该句，
  `run_plan` 改为 “Steps of a risky kind ask for approval first.”；真正仍会确认的
  `run_javascript` / `get_secret` / `create_skill` / `create_scheduled_task` 保留。

## 4. 预算

`tests/agent-payload-size.spec.ts` 相应上调并记录实测值：

- full auto 首轮 12_600 → 12_700（实测 12_661，半自动模式段落变长）。
- workflow 首轮 62_800 → 63_200（实测 63_046）。
- 单类别 38_500 → 38_750（实测 38_674）。
- 全类别 62_800 → 63_200（实测 63_046）。
- 双 hatch 63_900 → 64_200（实测 64_093）。

## 5. 验证

- `pnpm typecheck`、`TZ=UTC pnpm test`（4 个测试文件 / 84 项相关断言，全仓 5,720 项）、
  `pnpm build` 全绿。
- `tests/confirm.spec.ts` 覆盖分类器与模式层；`tests/agent-semi-confirmation.spec.ts`
  覆盖回合级调度（安全点击不弹卡、付款点击弹卡且拒绝后不执行、滚动不弹卡、全自动不弹卡）。
- 真浏览器探针 `tmp/risk-gate-probe.mjs`（17 项全 PASS）：只读只下发 8 个观察/元工具；
  “Pay now”点击弹确认卡且页面未被点击，拒绝后回合结束且无点击，批准后真实点击；
  “Continue”点击与滚动全程无卡并真实生效。

## 6. 不做的事

- 不按域名/白名单做“信任站点免确认”——用户裁决是按动作风险，而不是按站点。
- 不为风险词表引入机器学习或远程配置：本地正则 + 快照证据足够，且必须离线可用。
- 不恢复“读页面需要 attach 才不发确认”的旧豁免：用户明确要求半自动读页面完全不确认。

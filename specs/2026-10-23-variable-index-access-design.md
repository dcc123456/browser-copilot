# 变量下标 / 属性访问（`{{rows[0].name}}`）

日期：2026-10-23
状态：已实现

## 背景

用户要求：工作流变量是数组或对象时，引用变量应能直接按下标或属性取值，
例如数组第 0 项、对象某个字段。

## 现状与证据

- `interpolate` 把表达式**第一个 `.` 之前**的内容整体当作变量名
  （`src/lib/workflow/interpolate.ts:151`），`getByPath` 也只按 `.` 切分
  （`:89`）。因此：
  - `{{rows.0.name}}`（点号下标）可以解析；
  - `{{rows[0].name}}`、`{{obj["key"]}}` 不能——变量名被读成 `rows[0]`，
    整段 token 原样保留，运行时变成未解析输入。
- 多个静态扫描器用 `split('.')[0]` 或 `[A-Za-z0-9_.]+` 取变量根名：
  `dynamic-data.referenceRoot`、`producer-completeness`、`generated-validation`、
  `declare-missing-inputs`、`execution-trace`、`repair/dataflow-analyzer`、
  `repair/variable-provenance`、`repair/patch-policy`、`review-patch`、
  `task-chain`。它们对 `rows[0]` 会得到错误的根名，导致：
  - 生成校验误报 `DATA_UNWRITTEN_VARIABLE`（引用了 `{{rows[0]}}`）；
  - 上游完整性误报悬空变量；
  - 修复链的变量证据、变换来源、补丁白名单找不到真实变量。
- `generated-validation` 已经对 `{{table[0][1]}}` 做了特判（`table` 前缀视为
  数据表引用，不算变量），说明生成侧早就在写方括号语法，运行时是缺口。

## 语法

一个引用表达式 = 根变量名 + 任意个访问段：

```
{{ name }}
{{ name.property }}
{{ name[0] }}
{{ name[0].property }}
{{ name[0]["property"] }}
{{ name['property'] }}
{{ name["key.with.dots"] }}
{{ name[key] }}        ← 不支持，原样保留
```

- 根变量名：第一个 `.` 或 `[` 之前的文本（两端空白忽略）。`refData` 仍是特殊根。
- `.property` / `.0`：与现有行为完全一致（数组数字下标在对象上取值）。
- `[0]`：纯数字，允许方括号内侧空白。
- `["key"]` / `['key']`：带引号的键，键内可以包含 `.`、空格等任意字符；
  双引号走 JSON 转义，单引号按反斜杠转义。
- 非法表达式（如 `rows[`、`rows[]`、`rows[0].` 之后的空段）不猜测：整个 token
  原样保留，沿用「未解析 token 留在文本里」的既有契约。
- JSON 字符串中隐藏的对象/数组照旧在每一段访问前惰性解析，
  `{{articleData["title"]}}` 与 `{{articleData.title}}` 等价。

## 方案

### 1. 引用解析收敛到 `interpolate.ts`

新增并导出：

- `parseReference(expression)` → `{ name, path: string[] } | undefined`：
  解析根名 + 下标/属性段；
- `getByPath(root, path)` 复用同一段解析器，接受 `a.b`、`a[0].b`、
  `a["k"]` 混合路径；
- `interpolate` 先解析一次引用，再沿段行走，不再用 `indexOf('.')` 猜根名。

行走函数保持原有两条规则：字符串先尝试按 JSON 文档解析；任一段缺失或
中途遇到非对象立即返回 `undefined`（token 原样保留）。

### 2. 根名提取统一走 `referenceRoot`

`dynamic-data.referenceRoot` 改为委托 `parseReference`，无法解析时回退到旧的
「第一个 `.` 之前」规则。所有上列扫描器改为调用它：

| 位置                                    | 变化                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `execution-trace` / `dataflow-analyzer` | `split('.')[0]` → `referenceRoot`                     |
| `producer-completeness`                 | 手写切分 → `referenceRoot`                            |
| `generated-validation`                  | 非 `table` 引用 → `referenceRoot`（`table` 特判不变） |
| `declare-missing-inputs`                | 删除本地根名函数，改用共享实现                        |
| `repair/variable-provenance`            | 词法正则 → `referencesIn` + `referenceRoot`           |
| `repair/patch-policy`                   | 词法正则 → `referencesIn` + `referenceRoot`           |
| `review-patch`                          | 读取集合记录根变量而非整段 token（点号/方括号一致）   |
| `task-chain`                            | `token.split('.')[0]` → `referenceRoot`               |

生产方仍按变量名登记（`variableName`），消费方按根名匹配，因此
`{{rows[0].title}}` 与 `{{rows}}` 指向同一个生产者。

### 3. 编辑体验

不加新控件：用户在任意文本字段（或 `/` 菜单插入的 `{{name}}` 后面）直接续写
`[0]` / `.field` / `["key"]` 即可。这是纯文本语法，运行期解析。

## 否决的替代方案

- **用 `eval` / `new Function` 解析表达式**：变量值来自页面与模型，等于把
  任意代码执行引进执行器；自写的小语法更小也更容易拒绝非法输入。
- **只支持点号下标（现状）**：用户明确要下标写法，且生成侧已在写
  `table[0][1]`；不改运行时会持续产生“保存校验报变量不存在、运行原样输出
  token”的假故障。
- **支持 `[key]` 无引号变量键、`[{{i}}]` 动态下标**：需要第二层求值与转义规则，
  当前需求没有它；先按字面拒绝，日后要加时再单独设计。
- **为每个块单独实现取值**：取值只发生在 `interpolate` / `getByPath`；块层已
  统一走它们，分散实现只会造成第二套语义。

## 安全边界

- 解析器只做属性读取，不调用函数、不触发 getter 之外的行为（普通对象属性访问），
  不执行任何表达式。
- 访问段数没有额外上限，但输入是用户/模型写入的模板文本，长度为普通字符串；
  每次引用只做线性扫描。
- `refData`、JSON 字符串惰性解析、未解析 token 原样保留等既有行为不变。

## 测试

- `tests/interpolate-json-path.spec.ts`：数组下标、下标后属性、带引号键（含点号/
  空格）、点号与方括号混合、JSON 字符串、越界/非法表达式保持原样。
- `tests/workflow-integrity.spec.ts`：`{{formsValue[0].foo}}` 只校验根变量。
- `tests/producer-completeness.spec.ts`：生产 `rows` 后引用 `{{rows[0].title}}`
  不再报缺失生产者。
- `tests/repair/execution-trace.spec.ts`：bracket 引用的根名与解析状态。
- `tests/generated-validation.spec.ts`：上游写入 `rows` 时不再报
  `DATA_UNWRITTEN_VARIABLE`。
- `tests/task-chain.spec.ts`：`{{upstream.items[0].id}}` 正常交接，
  缺失上游 token 仍被报告。

## 手工验证

1. 编辑器里建一个 `set-variable`（变量名 `rows`，值填 JSON 数组
   `[{"title":"A"},{"title":"B"}]`），下游 `save-local` 的文件名/内容填
   `{{rows[1].title}}` 运行。预期：写入 `B`，不再原样输出 token。
2. 同一变量用 `{{rows[1]["title"]}}` 与 `{{rows.1.title}}` 各引用一次，
   预期三者结果一致。
3. 填一个不存在的下标 `{{rows[9]}}` 运行。预期：token 原样保留并触发
   `UNRESOLVED_INPUT`（而不是静默写入空值）。
4. 保存含 `{{rows[0].title}}` 的工作流。预期：保存卡片不再提示引用了未写入的
   变量 `rows[0]`；若确实没有上游生产 `rows`，提示的变量名应为 `rows`。

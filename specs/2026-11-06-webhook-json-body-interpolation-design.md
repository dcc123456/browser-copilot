# Webhook 请求体里的变量被当成普通文本：根因与修复

日期：2026-11-06
状态：已实现

## 1. 现象

HTTP Request（`webhook`）算子的请求体写成 `json` 并引用变量时，步骤失败：

```
webhook: body 不是合法 JSON（contentType=json）
```

典型写法：

```json
{ "payload": {{payload}} }
{ "note": "{{note}}" }
```

## 2. 根因

引擎在执行任何算子之前会先做一次**通用文本插值**（`interpolateBlockParams` →
`interpolateParams`），把参数包里的每个字符串按 `String(value)` 渲染。webhook 的 `body`
也在其中，于是进入执行器时已经不是原来的模板：

- 值位置的 `{{payload}}` 里若是对象/数组，先被渲染成 `[object Object]` 或逗号拼接的文本，
  `{"payload": [object Object]}` 自然无法解析；
- 字符串字面量里的 `{{note}}` 若含引号、反斜杠或换行，会直接截断 JSON 字符串；
- 执行器 `webhookBodyOf` 拿到的已是坏文本，类型信息和原始字符串都不可恢复。

也就是说：错误虽然由 `webhookBodyOf` 报出，真正破坏文档的是更早的通用插值。

## 3. 修复

### 3.1 引擎把请求体交给执行器自己处理

`interpolateBlockParams` 新增一张 `AWAITING_EXECUTOR_PARAMS` 表：`webhook` 的 `body`
保持原样交给执行器，其余参数（URL、headers 等）仍走通用文本插值。这与
`set-variable` 的 value slot 是同一思路——由最了解该参数格式的执行器负责编码。

### 3.2 请求体按 JSON 结构插值

`webhookBodyOf` 对 `json` / `form` / `form-data` 使用 `interpolateJsonBody`：
扫描字符时跟踪“是否在 JSON 字符串字面量内”。

- **值位置**：写成变量的 JSON 表示。`{"items": {{rows}}}` 发送真实数组；
  数字、布尔、`null` 保持类型；字符串会带引号。
- **字符串字面量内**：写成 JSON 字符串内容（`JSON.stringify(text).slice(1, -1)`），
  引号、反斜杠与换行被正确转义，不会再破坏文档。
- 未解析的 token 原样保留；若它落在值位置导致解析失败，错误信息直接点名变量：
  `webhook: body 中的变量没有值：{{missing}}`，而不是笼统的“不是合法 JSON”。

`contentType: 'text'` 保持原行为：按纯文本插值（对象仍然是 `[object Object]`，这是文本体的
预期语义）。

## 4. 回归测试

`tests/webhook-response.spec.ts`：

- 先跑 `interpolateBlockParams('webhook', …)` 再执行算子：对象引用以数组/对象发出；
- 数字、布尔与“整个文档就是一个引用”的写法保持类型；
- 引号、反斜杠、换行在字符串字面量内被转义，`JSON.parse` 后原样取回；
- `form-data` 行使用同一套转义；
- 值位置引用不存在变量时报 `{{missing}}` 且不发请求；
- `text/plain` 仍是纯文本插值。

`tests/workflow-engine.spec.ts`：`interpolateBlockParams` 对 webhook 只保留 `body` 原文，
其余字段照常插值。

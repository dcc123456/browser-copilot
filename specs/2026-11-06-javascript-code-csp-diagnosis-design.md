# javascript-code 的 CSP 报错被掩盖：根因与修复

日期：2026-11-06
状态：已实现

## 1. 现象

运行含 JavaScript 代码算子的工作流时，报错：

```
javascript-code: Evaluating a string as JavaScript violates the following Content Security Policy
directive because 'unsafe-eval' is not an allowed source of script:
script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*
```

这条 CSP 属于 **扩展的 MV3 service worker**，不是被操作的页面。页面 CSP 通常带域名或
`unsafe-eval` 之类的来源列表；报错里的来源（`localhost` 白名单、`wasm-unsafe-eval`）是扩展自身
的默认策略。

## 2. 根因

`javascript-code` 的正常路径是：把脚本注入页面、由页面内的 kernel 编译执行。执行失败时：

1. `execWorkflowJsOnActiveTab` 可能先因为“没有可注入的标签页 / 注入被拒”抛错；
2. 旧代码用 `catch { run = null }` 把这条**真实原因**丢掉了；
3. 随后走本地回退 `evalLocalWorkflowJs`，而 MV3 worker 禁止 `eval`/`new Function`，于是抛出
   上面的 CSP 错误；
4. 最终用户看到的是“扩展自己的 CSP”，与真正的失败无关。

另有两条加重因素：

- DevTools（CDP）回退在失败时返回 `null`，连它自己的失败原因也被丢弃。
- `resolveAutomationTab` 在聚焦窗口的活动标签是 `chrome://newtab/` 时，不会退而选择同窗口里
  另一个可注入的标签页，直接把一次本可成功的运行变成“没有可操作的网页”。

## 3. 修复

- **保留页面桥的错误**：`pageFailure` 记录注入/解析失败的原因；优先报告“页面内执行失败”
  （`run.error`），其次页面桥原因，最后才用本地回退的错误。本地回退只负责“确实没有页面桥”
  的场景（例如无 `chrome.scripting` 的宿主）。
- **CDP 回退带回原因**：`runWorkflowJsViaCdp` 返回 `{ok:false,error}` 而不是 `null`；
  两个调用点都用 `explainWorkflowCspFailure(pageError, cdpError)` 说明“页面禁止 eval 且
  DevTools 通道也失败”，并给出可执行的建议（换普通 http(s) 页面、改用浏览器操作算子）。
- **标签页回退**：聚焦窗口的活动标签页不可注入时，选同窗口里第一个可注入的标签页。这是原有的
  语义（“可注入即可操作”），只是补上了活动标签为浏览器内部页时的缺口。

## 4. 测试

- `tests/workflow-executors.spec.ts`：页面桥失败时，`javascript-code` 报出桥的原因，而不是
  worker 的 `unsafe-eval` CSP 文本。
- `tests/driver-scope.spec.ts`：聚焦窗口显示 `chrome://newtab/` 时，无作用域解析到另一个
  可注入标签页。

## 5. 未覆盖 / 已知边界

- 扩展页 UI 与真实页面的端到端验证需要手动加载 unpacked extension；本次以单元/驱动测试为准
  （见交付说明）。
- 页面 CSP 允许 `eval` 时原路径不受影响；CSP 禁止且 DevTools 通道可用时会自动走 CDP。

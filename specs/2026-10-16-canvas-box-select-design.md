# 画布框选（Space）失效与退不出去

裁定来源：用户反馈「现在点击空格键 然后框选 框选了之后无法拖动 且无法退出框选模式」。

## 1. 实测证据（真实 Chromium + 真实编辑器，非文档转述）

复现载体：`tmp/wf-select-probe/`（vite 挂载真实的 `src/workflow-editor/App.tsx`，
`chrome-stub.js` 提供 `probe-wf` 四个节点；扩展页面本身不可被 Playwright 驱动，
这是 §收尾自检⑤ 允许的替代证据，结论一律标为 harness 观察）。

| 观察                                                                   | 手段          | 结果                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可信 Shift 起手框选                                                    | probe18       | pane 进 `selection`，矩形增长，松手后拖一个节点 → 整组同步移动，模式自动退出                                                                      |
| 可信 Space                                                             | probe14/15/17 | pane 恒为 `draggable`；`defaultPrevented=false`（React Flow 匹配成功时必然 `preventDefault`）→ **选择态从未激活**                                 |
| 同一页合成 Space                                                       | probe19       | pane **能**进 `selection`（`prevented=true`）                                                                                                     |
| 裸 ReactFlow（去掉本项目代码，props 完全一致）                         | probe16       | 可信 Space **能**进 `selection`                                                                                                                   |
| `Event.prototype.composedPath` 见证器（不碰 addEventListener，无污染） | probe21       | 可信 Space 只有挂在 **document** 上的 React Flow handler 调用了 `isInputDOMNode`；挂在 **window** 上的 selection handler 一次都没进来看过这个事件 |
| 监听器普查（CDP `DOMDebugger.getEventListeners`）                      | probe20       | window 上 keydown/keyup 数量稳定（Space 前后 delta=0），React Flow 的 handler 确实注册着                                                          |
| 我们自己的 Space 追踪器                                                | probe15/17    | 可信 Space 会让 `data-pan-mode` 翻转 → window 级可信 keydown 是可达的                                                                             |

已排除的假设：

- **props identity churn**（`selectionKeyCode={['Space','Shift']}` 每次 render 新建数组，
  导致 `useKeyPress` 的 effect 反复注销/重注册监听）。把三个 key props 提升成模块常量后
  重测（probe22），可信 Space 依旧不激活选择态 → 假设不成立，改动已回退。
- **`isInputDOMNode` 吞键**：`composedPath()[0]` 为 `BODY`，`nodeType=1`、无 `contenteditable`、
  全页 `.nokey` 计数 0（probe19/21）→ 判定应为 false。且 Shift 与 Space 走同一个 target。
- **监听器丢失/异常中断**：probe20 的普查里监听器数量不随按键变化，页面无 `pageerror`。

结论：在**本项目运行环境**里，React Flow 内部的 key 匹配对「可信 Space」不可依赖——
它匹配 Shift、匹配合成 Space、在裸依赖树里也匹配可信 Space，唯独在这个页面里收不到
可信 Space。继续追第三方 hook 的内部时序没有产出（已投入 8 个探针），且任何依赖它
的方案都无法证明能修好。

## 2. 设计：把 Space 的选择态握在自己手里

不再请求 React Flow 去匹配 Space，而是用我们已验证可靠的可信 Space 状态（同一个
window keydown/keyup 通道，今天驱动 `data-pan-mode` 的就是它）去驱动 React Flow 的
**选择拖拽开关**：

```tsx
selectionKeyCode={['Shift']}                 // Automa 自己的 Shift 框选，实测可靠
selectionOnDrag={spaceSelect}                // 我们自己的可信 Space 状态
panOnDrag={spaceSelect ? [1, 2] : true}      // xyflow: _selectionOnDrag = selectionOnDrag && panOnDrag !== true
nodesDraggable={spaceSelect ? false : true}  // Space 期间从节点起手拖拽不得静默挪动节点
panActivationKeyCode={null}                  // Space 永远不代表平移
```

Space 状态机（`src/workflow-editor/use-space-select.ts`）修掉「退不出去」：

- `keydown`：`code==='Space'`、非 `repeat`、目标不是可编辑元素 → 置位。
- `keyup`：**无条件清零**（原实现要求目标非可编辑，于是「在 body 按下 Space → 焦点落入
  输入框 → 松手」这条路径永远不清零，选择态光标被永久锁住，正是用户说的退不出模式）。
- `window blur` / `contextmenu` 清零，与 React Flow 自身的 `resetHandler` 同构。

顺带删除 `data-pan-mode` 属性与 `editor.css` 里的 `cursor: grab/grabbing` 规则：现在
`selection` / `draggable` / `dragging` 三个类由真实选择态驱动，React Flow 自带对应光标，
不需要第二套来源（§5.4 删除被替换的实现、§5.6 不并列两套）。

## 3. 已知取舍（写清楚，不当作已完成）

React Flow 的 `Pane.onPointerDownCapture` 判定是
`isSelectionActive = (selectionOnDrag && eventTargetIsContainer) || selectionKeyPressed`，
所以在 `selectionOnDrag` 路线下，**Space + 拖拽只能从空白画布起手**；从节点上起手不画框
（Space 期间 `nodesDraggable=false`，所以也不会误挪节点）。这与 Automa 的框选习惯一致
（框选本来就是从空白处描边），但和 §1 之前注释里承诺的「从任意处起手」不同。

## 4. 验收

- `tests/space-select.spec.ts`（jsdom）锁住状态机：body 上按下 Space 置位；焦点在
  INPUT/TEXTAREA/contenteditable 时不置位；**keyup 落在输入框内也要清零**；window blur
  清零。这是「退不出去」的直接回归测试。
- `tests/acceptance-canvas-selection.spec.tsx`：编辑器的 props 组合（Shift 仍登记为选择键、
  Space 期间 `panOnDrag` 不含左键、`nodesDraggable` 关闭）。
- 真实浏览器（tmp harness）：probe 走完整用户故事——Space 起手描边 → 选中 n2/n3/n4 →
  松手 → 拖一个节点整组移动 → 光标/模式退出。命令与输出留在 `tmp/wf-select-probe/`。

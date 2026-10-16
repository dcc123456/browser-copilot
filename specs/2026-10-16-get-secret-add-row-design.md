# get-secret：点「添加凭证」无任何响应

裁定来源：用户反馈「获取凭证算子节点 点击添加凭证 无任何响应」。

## 1. 实测根因（两个，都真实）

### 根因 A：一个凭证都没存时，按钮本身不存在

`EditGetSecret.tsx` 的渲染是三分支：`entries === null` → 加载中；`options.length === 0` →
只渲染一句「No credentials configured yet. Add one in Settings → Secrets.」；否则才渲染行
列表 + 「Add credential」按钮。

也就是说：**当浏览器里一条凭证都没存时，那个按钮根本没渲染**，用户点的是空气。真实浏览器
证据（tmp harness，stub 的 `listPasswords()` 返回空）：修复前打开节点面板只看到那句提示，
`.wf-edit-body select` 数量为 0，「Add credential」按钮数量为 0。

凭证管理 UI 在**侧边栏 Data tab**（`src/sidepanel/DataTab.tsx`），编辑器节点面板里没有新建
入口，所以「先去设置里建一条」这条提示对用户来说等于死路。

### 根因 B：有凭证时，新增的空行在下一帧被抹掉

表单直接以 `secretRowsOf(data)` 渲染行，而该规范化会**丢弃没有凭证引用的行**（执行语义
要求：没有凭证的行不算一次取值请求）。于是 `commit([...rows, EMPTY_ROW])` 写入的空行在同一次
round-trip 里被自己抹掉，点击看起来毫无反应。

## 2. 修复

- **A**：行列表与「Add credential」按钮始终渲染；零凭证时按钮下方给一句说明。行列表在零
  凭证时本来就没什么可选，但面板不再缺按钮，也不再要求用户先离开编辑器去建凭证。
- **B**：表单维护一份 draft 行列表（`workingRowsOf`），用模块自己的
  `secretRowsPatch` / `secretRowsOf` 归一化结果与已存行比对，draft 存得住、也随时可以被外部
  patch（AI 修复、`/` 菜单）替换。**空行永不写入节点**——写进去会让运行去要一个没人选的凭证。
- **挂载归属**：`BlockEditForm` / `BlockSettingsModal` 按节点 id 加 `key`，draft 属于某一个
  节点，切换节点时不能带过去。

## 3. 隐私红线（未放宽）

节点里只存引用 `<credentialId>::<fieldKey>` 与输出变量名。下拉只列元数据
`label · fieldKey`；凭证值不进表单 DOM、不进编辑器 state、不进工作流定义、不进运行日志。
新增的空行连引用都没有，存储形状因此保持原样。

## 4. 验收

- `tests/get-secret-form.spec.tsx`：
  - 零凭证时「Add credential」存在、点击加行、空行不进节点（新增用例，直接锁根因 A）；
  - 有凭证时新增行能存活、能先填名字后选凭证（新增用例，锁根因 B）；
  - 既有 10 条用例全绿（其中一条旧用例断言空行会写进节点，已按新契约改写）。
- 真实浏览器（tmp harness）：`.wf-edit-body select` 1 → 2 → 3，关闭并重开回到 1 行。

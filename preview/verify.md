# UI 改造验证清单

## 设计系统统一
- [x] 共享令牌 src/ui/design-system.css（明暗双主题，单一事实来源）
- [x] 侧边栏 styles.css 变量桥接到 --bc-* 令牌
- [x] 编辑器 theme.css 桥接为 --we-* 别名，editor.css 全部使用别名
- [x] 旧编辑器 styles.css 死代码删除（477 行 → ~100 行，仅留 xyflow + 代码高亮）
- [x] 分类色块统一为"浅底 + 饱和图标"（节点/色板/编辑表单）

## 自定义弹窗替换原生 alert/confirm
- [x] src/ui/ConfirmDialog.tsx — Tailwind 构建，Promise API
- [x] src/ui/confirm.tsx — ConfirmHost 单例，confirmDialog/alertDialog
- [x] src/ui/toast.tsx — ToastHost 单例，toast()
- [x] 侧边栏 9 处 window.confirm/confirm 全部替换
- [x] 编辑器 3 处 window.alert 全部替换为 toast
- [x] 弹窗：Esc 取消、Enter 确认、点遮罩取消、focus 管理、aria-modal

## 可访问性 (A11y)
- [x] 所有正文/链接对比度 ≥ 4.5:1（tests/theme.spec.ts 自动校验，31 项）
- [x] focus-visible 焦点环
- [x] 图标均为 SVG（无 emoji 作图标）
- [x] prefers-reduced-motion 支持
- [x] role="dialog"/"alertdialog"/aria-modal/role="status"

## 质感升级
- [x] 圆角统一（6→8/10/12 层级）
- [x] 输入框 focus 光环（accent-soft 3px）
- [x] 按钮悬停/按下反馈
- [x] 节点/卡片悬停阴影
- [x] 主题化便利贴、代码高亮、toast 图标

# 工作流广场：凭证随发布导出、应用时自动导入

## 1. 目标与非目标

用户发布的工作流如果用了「密钥与字段」（`passwords` 库中的 `PasswordEntry`），消费方应用后必须能直接运行：凭证进入自己的库，`get-secret` 步骤指向它，父工作流和随包子工作流都不需要再次选择凭证。

- 目标：
  - 发布弹窗列出被引用的凭证字段（参数名），**密码类字段默认留空，非密码字段默认填本地值**，两者都可编辑。
  - `meta.json` 携带这些字段（`secrets`）。
  - 应用（新建与更新）时自动导入到本机 `passwords`，并把父工作流与每个子工作流里的 `get-secret` 引用改写到本机 id。
- 非目标：
  - 不改 `get-secret` 块/执行器语义，不改 Runner 的 `BC_SECRET_*` 环境变量通道。
  - 不自动填写密码：密码字段发布时就是空值，用户之后在「密钥与字段」里补；工作流本身不需要再选凭证。
  - 不做凭证共享/同步、不做服务端存储。

## 2. 选型与证据

- **引用形态**：`get-secret` 节点参数是 `<credentialId>::<fieldKey>`，可单行或 `credentials[]` 多行（`src/lib/workflow/secret-params.ts`，`secretRequestsOf` 是唯一读取入口）；执行器按 id 从 `listPasswords()` 取字段（`src/background/workflow-engine/executors.ts:1476`）。因此发布只需导出「被引用到的字段」，应用只需改写 id 并保证字段存在。
- **数据放哪**：放进 `meta.json` 的可选 `secrets`，不新增文件。应用本来就要读 `meta.json`，多一个文件就多一次 API 调用；`dependencies` / `attachments` 已经确立了「可选字段、旧 listing 无该字段、schema 不升版」的先例。
- **凭证身份**：发布记录 `id` 用发布者本地 id（与 bundle 的 `dependencies[].id` 同思路）。应用侧映射成确定性本地 id `mkt-<slug>-<sourceId>`：重复应用命中同一条，两个 listing 各自独立。
- **值策略**：`field.value` 在发布弹窗里预填 —— `secret: true` → 空串；否则 → 本地值。用户可改。密码字段被填入非空值时，`preparePublish` 产生 `secret-value` 警告，沿用现有「仍然发布」二次确认，避免把真实密码静默推进公开仓库。
- 否决方案：
  - 把凭证写进 `workflow.json`：会改变工作流字节/hash，且绕过发布弹窗的字段级编辑。
  - 应用时必须由用户点选凭证：这正是本次要消除的操作。
  - 覆盖已存在的本地凭证值：用户可能已经填了真实值，更新只允许补缺字段。

## 3. 数据模型

```ts
interface MarketplaceSecretField {
  key: string
  /** 发布时的默认值：密码字段为空串，其它字段是发布者本地的值。 */
  value: string
  /** true = 密码类字段，UI 掩码显示。 */
  secret?: boolean
}
interface MarketplaceSecret {
  /** 发布者本地凭证 id，应用时映射成 mkt-<slug>-<sourceId>。 */
  id: string
  label: string
  url?: string
  fields: MarketplaceSecretField[]
}
```

`meta.json`：新增可选 `secrets: MarketplaceSecret[]`。

限制（`lib/marketplace/types.ts`）：单 listing ≤ 20 条凭证、≤ 64 个字段、字段名 ≤ 120 字符、值 ≤ 4000 字符；超限发布直接报错，读取时超限字段按条丢弃（与附件一致）。

导出范围：

- 行里有 `fieldKey`：只导出该字段。
- 行只有凭证 id（`<id>::`，执行器按 `password` → 首字段回退）：导出该凭证全部字段，否则消费方无法保证回退链命中。
- 多条行引用同一凭证不同字段：合并成一条，字段并集。

## 4. 发布

- `preparePublish` 收集父工作流 + 全部被打包依赖里的 `get-secret` 引用（`collectSecretRefs`），与 `input.secrets` 核对：缺凭证或多出的字段都不发布（缺凭证是硬错误，提示缺哪些）。只保留被引用的字段，多余字段丢弃。
- `buildMeta` 校验并写入 `secrets`；`parseMeta` 宽容解析（丢弃坏条目，不影响卡片可用性）。
- 发布弹窗新增「凭证字段」区：
  - 首次打开时 `passwords.list`，按引用顺序列出凭证 label 与字段输入框；密码字段 `type=password`，默认空；其它字段默认填值。
  - 缺凭证（本地库里找不到）时整段标红并禁用发布。
  - 编辑值进入草稿，关闭弹窗后随现有 `marketplaceDrafts` 恢复。
- `toPublishableWorkflow` 不再把 `get-secret` 节点里的 `credential` 当「凭据字面量」警告：它是引用，不是值（历史噪音修复）。

## 5. 应用

- `planApplyBundle` 读取 `card.meta.secrets`（无则完全维持旧行为），生成本地 `PasswordEntry[]`：
  - 不存在 → 新建：`id = mkt-<slug>-<sourceId>`，label/url 照抄，字段值 = 发布值（密码为空，等待用户补）。
  - 已存在 → 保留原值、`useCount`、`createdAt`；只补缺的字段（用发布默认值）和缺失的 label/url。
- `rewriteWorkflowSecrets` 把父工作流和每个依赖里 `get-secret` 行的凭证 id 改成映射后的 id（字段名不变）；同时兼容参数在 `data.values` 下的新形态。
- `installFromCard` 先 `passwords.save` 全部凭证，再存依赖，最后存父工作流：任一步失败都不会留下「工作流指向不存在的凭证」。
- 首次安装的 bundle 仍按既有规则成组；凭证导入不改变分组逻辑。
- 信任确认弹窗在导入凭证时多一行说明（导入哪些凭证；密码字段需要之后补值）。

## 6. 兼容与安全

- 旧 listing 无 `secrets`：父/子工作流的 `get-secret` 引用保持原样，与今天一致。
- 应用从不写入 `secret` 之外的值来源；发布侧只提交用户看到并确认的字段。
- 密码字段发布默认空值；用户主动填写才会公开，且有 `secret-value` 警告 + 二次确认。
- 凭证值只存在于 `meta.json` 与用户本机存储，不进入日志。

## 7. 验收与测试

- 纯逻辑：引用收集（单行/多行/裸 id/依赖中的引用）、发布值策略与覆盖、meta 往返与坏数据丢弃、缺凭证拒绝、密码非空产生警告。
- 应用：新建导入 id 确定性；父与子节点引用都被改写；已存在凭证值不被覆盖、缺字段补齐；无 `secrets` 时零变化。
- `installFromCard`：凭证先于工作流写入；凭证写入失败不写任何工作流。
- 真实浏览器：stub GitHub 数据源，应用带 `secrets` 的卡片后检查 `chrome.storage.local.passwords` 与节点引用；发布弹窗显示密码空/明文预填并可编辑。

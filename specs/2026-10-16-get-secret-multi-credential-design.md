# get-secret 一个节点取多个凭证 — 设计记录

日期：2026-10-16 ｜ 影响面：`src/lib/workflow/**`、`src/background/**`、`src/workflow-editor/**`、`server/src/**`
裁定来源：用户本轮批量需求 + AskUserQuestion（三项，见 §1.2）

## 1. 诉求与裁定

### 1.1 原始诉求

> 「获取凭证算子可以获取多个凭证，供后面的算子去使用。现在一个凭证算子只能设置一个凭证，太麻烦了。」

今天的 `get-secret` 块只有一个 `credential`（`"<凭证ID>::<字段>"`）和一个 `variableName`：想用一个工作流里
放 3 个密钥，就得摆 3 个节点、连 3 段线。

### 1.2 三项裁定（用户 2026-10-16）

| 议题     | 裁定                                         | 落点                                                          |
| -------- | -------------------------------------------- | ------------------------------------------------------------- |
| 数据模型 | **一个节点选多个凭证**（不是"多个节点合并"） | 节点 data 加 `credentials` 列表                               |
| AI 算子  | **保持单凭证调用**                           | `wf_op_get-secret` 的 schema、必填推导、相关测试一律不动      |
| Runner   | **从环境变量读凭证**                         | `server/src/executors.ts` 注册 `get-secret`，读 `BC_SECRET_*` |

## 2. 数据模型：列表 + 首行镜像

```ts
// 规范形态（多于一行时）
node.data = {
  blockId: 'get-secret',
  credential: 'gh-pat::token', // ← 第 1 行的镜像，永远写
  variableName: 'githubToken', // ← 第 1 行变量名的镜像，永远写
  credentials: [
    { credential: 'gh-pat::token', variableName: 'githubToken' },
    { credential: 'smtp::password', variableName: 'mailPassword' },
  ],
}

// 存量形态（老工作流、AI 单凭证调用、历史生成）—— 继续可读，不迁移
node.data = { blockId: 'get-secret', credential: 'gh-pat::token', variableName: 'githubToken' }
node.data = { blockId: 'get-secret', secretId: 'gh-pat', fieldName: 'token', variableName: 'pw' } // 0.6.3 前
```

读侧唯一入口是纯函数 `secretRequestsOf(data): SecretRequest[]`：`credentials` 非空就用它，否则回落到
flat 对（再回落到 `secretId`+`fieldName`）。写侧（编辑表单、`/` 菜单）在 1 行时只写 flat 对并删掉
`credentials`，≥2 行时写全量列表 **并且** 重新镜像第 1 行。

### 2.1 为什么保留首行镜像（而不是纯列表）

纯列表在语义上更干净，但它要求一次性改写所有"这个节点发布哪些变量"的读取方，而 `data.variableName`
是**跨块通用**的字段名——`producer-completeness.producedVariableNames`（`integrity.producedNames` 消费它）、
`repair/variable-provenance` 的 NODE_OUTPUT 索引、`generated-validation.variableWritesOf`、
`block-requirements.params`、`operator-tool-run` 的密钥回收，全都按
"一个节点一个 `variableName`" 写死。镜像带来三条实际收益：

1. **存量工作流不需要迁移**。工作流存在 `chrome.storage`、Runner 的 `workflows.json` / `workflows.d/*.json`，
   还有用户导出后再导入的 JSON——没有任何一个"加载时重写"的钩子能覆盖全部入口。读侧兼容是硬要求，
   镜像只是把同一条回落链也交给写侧。
2. **AI 侧零改动**（按 §1.2 的裁定）。`schemaRequiredArgs('get-secret')` 仍返回
   `['credential','variableName']`，`wf_op_get-secret` 的 JSON-schema `required`、
   `tests/operator-tool-tiers.spec.ts:224`、`tests/block-requirements.spec.ts:215` 全部原样成立。
   把必填改成"二选一"必须把这两个 param 变成带 `when` 的条件项，而 `schemaRequiredArgs` 会过滤掉条件项
   （`block-requirements.ts:604`），等于把生成期的必填门槛降级成事后拒绝。
3. **不新增形状切换的歧义**：`credentials` 出现即代表"这就是多行节点"，列表为空即代表"回落 flat"。

代价是一条镜像规则必须写进文档并在测试里锁住（§5.3）。这是持久化数据模型的迁移策略，不是兼容垫片：
被弃用的只有"读"，写侧永远只写一种真值来源（列表优先）。

### 2.2 `credentialId` 与 `fieldKey` 的两种严格度（不要统一）

- 执行侧：`credential` 允许只写凭证 ID（`gh-pat`），字段回落链是 `fieldName → 'password' → 第一个字段`
  （`executors.ts:1424-1427`）。这是 0.6.3 就有的行为，保留。
- 命名/选单侧：`parseCredentialRef` 要求两半都在（`var-suggestions.ts:75-82`），因为它要为一次点击生成
  碰撞安全的变量名。

`secretRequestsOf` 沿用执行侧的宽松口径（`fieldKey` 可为空字符串），`SecretRequest` 里带
`credentialId / fieldKey / variableName` 三个字段。混用两者会让"只写 ID"的老节点在编辑里变成不可解析。

## 3. 谁是生产者：一个出口，六个消费者

"这个节点往会话里写哪些变量名"今天有 6 份各写一份的实现。多凭证要全部改成 N 个名字，因此先收口成
**一个** 出口：`producer-completeness.ts` 的 `producedVariableNames(node): string[]`
（该模块已经是"哪个块的哪个字段持有它写的变量"的唯一定义，`VARIABLE_PRODUCER_FIELD` 就在那）。

消费者与各自失配的后果：

| 位置                                            | 现在                     | 失配后果                                                  |
| ----------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| `integrity.producedNames`（保存期悬空引用检查） | 读 `data.variableName`   | 引用第 2 行的 `{{mailPassword}}` 会被判为悬空，保存被拒   |
| `repair/variable-provenance` NODE_OUTPUT 索引   | 每节点一个名字           | 修复时的变量来源分析看不见第 2..N 行                      |
| `generated-validation.variableWritesOf`         | 读 `variableName`        | 生成图被判为"写了没人产 / 引用没人写"                     |
| `producer-completeness.producesVariable`        | 字段映射，不含列表       | `MISSING_PRODUCER` 误报（今天 get-secret 根本不在映射里） |
| `var-suggestions.collectSuggestions`            | 每 producer 一条         | `/` 菜单只列得出第一个密钥                                |
| `operator-tool-run` 的密钥回收（561-563）       | 只收 `data.variableName` | **第 2..N 行的明文凭证被写进 `draft.variables` 持久化**   |

最后一行是本次改动的红线：它是唯一一处"漏了不会报错、只会泄密"的地方。修复形态是把单行读取换成
`secretRequestsOf(data)` 全量收名，测试用两行节点断言两个名字都进了密钥袋、两个值都没进草稿。

## 4. Runner：`BC_SECRET_<ID>_<FIELD>` 环境变量

事实核对（不靠记忆）：`server/src/**` 里零个 `get-secret` 引用，`server/src/config.ts` +
`config-store.ts` 只有 llm / feishu 两类 key，没有任何凭证库；而 `server/data/runs/*.final.json` 里有
多条真实运行记录死于 `没有找到块执行器: get-secret`。同文件里 `ai-agent`（2167）是有执行器的，
所以这不是"本地块一律不进 Runner"的先例，就是缺口。

裁定按"从环境变量读凭证"实现：

- **名字派生放纯模块**：`secretEnvNameOf(ref)`（`src/lib/workflow/secret-params.ts`）＝
  `BC_SECRET_` + `<id>` + `_` + `<field>`，转大写、`[^A-Z0-9]` 换 `_`；无 `fieldKey` 时只拼 ID。
  纯函数放 `src/lib/**` 的理由：Runner 与扩展两侧都要同一口径，且 `server/tsconfig.json` 的白名单
  本来就允许 `src/lib/**`（§5.7）。
- **`process.env` 读取只发生在 `server/src/executors.ts`**。核对过现状：`src/lib/**` 里只有两处读环境，
  且都是带 `typeof process !== 'undefined'` 守卫的调参项（`workflow/ai-takeover.ts:33` 的
  `readNumEnv`、`workflow/observer.ts:46`），部署配置类的读取一律在宿主里（`server/src/config.ts` 的
  `applyEnv`、`http-api.ts:134`、`observability.ts:38`）。凭证属于后者：它是部署方给的运行时配置，
  而 §5.6 已把"配置读取"列为禁止再加一套的既有债务——在共享 lib 里开第三条读取路径，扩展宿主那边
  永远只会静默 no-op，正好是最坏的形态。共享的只有名字派生，两侧不可能在命名上漂移。
- **缺变量直接抛**，错误里写清该设哪个变量——沿用同文件 `proxy` 块的口径（"宁可直接失败，也不要在
  静默直连的情况下报告成功"）。绝不用 `unsupportedCloud` 那种 `emit('error') + return null`：那会让
  `{{secret}}` 解析成空串然后"成功"填进表单，正是本仓库最忌讳的假成功。
- **值永不入日志、不入工作流**：与扩展侧 executor 同构，成功日志只到"已获取凭证字段 → 变量 X（值已隐藏）"。
- **不进 `config-store.ts`**：那是磁盘上的 JSON 配置文件，把密钥写进去等于新增一处明文持久化凭证面。
  环境变量是进程级、不落盘、由部署方掌握，和 `BC_TOKEN` 同一档位。

已知并接受的两点：

1. ID 只按标点区分的两个凭证在 env 名上会碰撞（`a.b` 与 `a-b` 都变 `A_B`）。扩展侧凭证 ID 由用户生成、
   现实里是 slug，且碰撞的后果是"取到同一个值"而不是"取不到"，可在错误信息里定位。
2. Runner 拿不到字段元数据，所以 `fieldKey` 缺失时的回落链（`password → 第一个字段`）在 Runner 上退化成
   只试 `BC_SECRET_<ID>`。这是有意的：Headless 侧没有"第一个字段"可枚举。

## 5. 编辑器

- 表单换成行列表：每行 `[凭证下拉] [变量名输入] [删除]`，底部"添加凭证"。行 UI 沿用
  `ParameterFields.tsx` 的 `update/add/remove(index)` 写法与 `wf-params*` / `wf-icon-btn` 既有 class
  （§2：只用既有语义 token，不新增样式）。
- **命名预填规则不变**，只是作用到"被改动的那一行"：选凭证时，若该行变量名为空、或等于上一次选择时
  本表单生成的名字，就换成 `credentialVariableNameOf(新引用)`；人工手打的名字一律不动。这是上一轮
  「输出变量名默认填入秘钥的 key」裁定的按行版本。
- **写入不变量**（测试锁住）：`rows.length === 1` → 只有 flat 对，无 `credentials`；
  `rows.length >= 2` → `credentials` 是**全量**行，且 `credential`/`variableName` 恒等于第 1 行。
- **凭证值仍然绝不落进定义/DOM**：下拉的 option label 只有 `label · fieldKey` 元数据（沿用现有约束）。
- `/` 菜单的 `ensureSecretProducer`：可达 producer 的任一行已经取该凭证 → 复用其变量名；可达 producer
  存在但没有这一行 → 通过既有 `nodePatch` **追加一行**（这正是"一个节点多凭证"的入口），返回新行的名字；
  没有 producer → 照旧新建单行节点。

## 6. 否决项（留证据，别再来一遍）

- **AI 也支持 `credentials` 数组**：按裁定不做。技术上还需要把 `get-secret` 的必填改成条件项，而生成器
  指南的长度是 `MAX_INSTRUCTIONS_LENGTH = 9400`、当前 9273、`tests/skills.spec.ts:202` 要求余量 ≥100，
  可用只有 ~27 字符——连"多凭证写 credentials 列表"这句话都放不下。
- **`server/src/config-store.ts` 加 secrets map**：明文密钥进磁盘配置文件，且 `config-store` 已经是
  §5.6 点名的"只许收敛"债务，不加。
- **一次性迁移存量工作流**：没有覆盖全部入口的迁移钩子（§2.1），改成读侧回落。
- **Runner 用 `unsupportedCloud` 占位**：静默成功路径，见 §4。

## 7. 落点清单

| 文件                                                  | 改动                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/lib/workflow/secret-params.ts`                   | 新增：凭证引用原语（从 `var-suggestions.ts` 迁入）+ `SecretRequest` / `secretRequestsOf` / `secretEnvNameOf` |
| `src/lib/workflow/var-suggestions.ts`                 | 删除原语本地定义，改 import；producer 映射按行扫描                                                           |
| `src/lib/workflow/producer-completeness.ts`           | 新增 `producedVariableNames(node)`；`producesVariable` 走它                                                  |
| `src/lib/workflow/integrity.ts`                       | 保存期 produced 名字集合按节点取全量                                                                         |
| `src/lib/workflow/generated-validation.ts`            | `variableWritesOf` 走 `producedVariableNames`                                                                |
| `src/lib/workflow/repair/variable-provenance.ts`      | NODE_OUTPUT 索引按节点取全量                                                                                 |
| `src/lib/workflow/block-requirements.ts`              | `get-secret` 加 `check`：`credentials` 行必须两半齐全（`params` 不动）                                       |
| `src/background/workflow-engine/executors.ts`         | `getSecret` 遍历行，逐行解析/写变量/记日志                                                                   |
| `src/background/operator-tool-run.ts`                 | 密钥回收遍历 `secretRequestsOf`（§3 红线）                                                                   |
| `src/workflow-editor/blocks/batchC/EditGetSecret.tsx` | 行列表 UI + 写入不变量                                                                                       |
| `src/workflow-editor/i18n.ts`                         | `BLOCK_FORM_STRINGS` 新字面串的 zh 侧（§3 双语）                                                             |
| `src/lib/workflow/blocks/custom.ts` + `block-i18n.ts` | 块描述与 zh 描述改成"可取多个凭证"                                                                           |
| `server/src/executors.ts`                             | 注册 `get-secret`，`BC_SECRET_*` 解析                                                                        |
| `docs/server.md`                                      | `BC_SECRET_*` 段落（部署方怎么设）                                                                           |

收尾自检映射：①②为门禁命令；③本次不动 `ai-takeover.ts` / `workflow-engine/**` 的调试路径，
但 `executors.ts` 在 bench 覆盖范围内仍跑 `pnpm bench:debug` 对照基线；④不动 `executeScript({func})`
内联函数体；⑤扩展页面不可脚本驱动 → 表单交互部分标 BLOCKED，纯逻辑与 Runner 部分有机检证据。

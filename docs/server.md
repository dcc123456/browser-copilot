# 服务器运行器（server/）使用说明

把 Browser Copilot 的工作流放到远程服务器上无人值守运行：同一个纯引擎（`src/background/workflow-engine/engine.ts`）+ Playwright 驱动 + HTTP API / 定时 / Webhook / 飞书四种触发方式。扩展本身不受影响（仅引擎注入了一个 `resolveWorkflow` 钩子）。

```
扩展 workflows.json ──复制/导入──▶ server/data/workflows.json ──▶ RunService ──▶ Playwright(Chromium/CDP)
                                                        ▲                │
        HTTP /api/runs ｜ cron 定时 ｜ /api/hooks/:id ｜ 飞书命令 ───────┘
```

## 1. 三种部署方案

| 方案 | 适用场景 | 说明 |
| --- | --- | --- |
| **A. 直接跑（推荐起步）** | 有台 Linux/Windows 服务器，想最快用起来 | 仓库克隆 → `pnpm install` → `pnpm --dir server start`，见 §2 |
| **B. Docker 单容器** | 干净的环境、容器化交付 | 容器自带 Chromium，数据挂 `/data` 卷，见 §3 |
| **C. Docker + browserless（CDP）** | 想把浏览器独立扩缩、或复用已有 browserless | `BC_BROWSER_MODE=cdp` 连 `ws://browser:3000`，见 §3 |

浏览器会话支持三种形态（`BC_*` / config.json 配置）：

- **fresh**（默认）：每次运行临时上下文，跑完即弃，互不干扰；
- **persistent**：运行参数 `profile: "name"` → 复用 `data/profiles/<name>/` 登录态（同一 profile 串行排队）；
- **CDP**：`BC_BROWSER_MODE=cdp` + `BC_CDP_ENDPOINT`，连接远端浏览器（persistent profile 在 CDP 模式下降级为 fresh 并告警）。

## 2. 方案 A：直接部署

要求 Node 20+、pnpm 11。

```bash
git clone <repo> && cd browser-copilot
pnpm install                       # workspace 会一并装好 server/
npx playwright install chromium    # 下载浏览器（首次）

# 最小配置（也可用 server/config.json，见 §6）
export BC_TOKEN="换成随机长字符串"          # API 鉴权，务必设置
export BC_LLM_BASE_URL="https://api.deepseek.com/v1"   # 仅 ai-agent / AI 接管需要
export BC_LLM_API_KEY="sk-..."
export BC_LLM_MODEL="deepseek-chat"

pnpm --dir server start            # 等价 tsx server/src/main.ts
# 默认端口 8787，日志见 data/runs/<runId>.jsonl
```

用 systemd 常驻（Linux）：

```ini
# /etc/systemd/system/bc-runner.service
[Unit]
After=network-online.target
[Service]
WorkingDirectory=/opt/browser-copilot/server
Environment=BC_TOKEN=xxx BC_LLM_API_KEY=sk-xxx
ExecStart=/usr/bin/pnpm exec tsx src/main.ts
Restart=always
[Install]
WantedBy=multi-user.target
```

## 3. 方案 B / C：Docker 部署

```bash
# 方案 B：容器内置 Chromium
BC_TOKEN=xxx docker compose up -d --build

# 方案 C：浏览器独立容器（browserless），runner 通过 CDP 连接
BC_TOKEN=xxx BROWSERLESS_TOKEN=xxx \
BC_BROWSER_MODE=cdp BC_CDP_ENDPOINT=ws://browser:3000 \
docker compose --profile cdp up -d
```

- 数据卷：`./data` → 容器 `/data`（workflows.json、runs/、artifacts/、profiles/）。
- 导入工作流：`curl -X POST http://host:8787/api/workflows/import -H "Authorization: Bearer $BC_TOKEN" --data-binary @workflows.json`。
- 升级：`git pull && docker compose up -d --build`；工作流数据在卷里，不随容器销毁。

## 4. 工作流迁移：从扩展复制到服务器（含嵌套）

扩展的所有工作流存在**一个键**里，导出/备份文件即 `workflows.json`（一个数组）。服务器读同一格式。

### 4.1 复制方式（二选一）

1. **文件直放**：把扩展导出的 `workflows.json` 放到 `server/data/workflows.json`（或 `BC_WORKFLOWS_FILE` 指向的路径），重启或 `POST /api/workflows/reload`。
2. **API 导入**（不重启，逐条回报结果）：

```bash
curl -X POST http://127.0.0.1:8787/api/workflows/import \
  -H "Authorization: Bearer $BC_TOKEN" -H "Content-Type: application/json" \
  --data-binary @workflows.json
```

响应（每条工作流一行结果）：

```json
{
  "imported": 2, "skipped": 0,
  "entries": [
    { "index": 0, "id": "child-1", "name": "子流程", "ok": true, "warnings": [], "missing": [] },
    { "index": 1, "id": "parent-1", "name": "父流程", "ok": true, "warnings": [], "missing": ["ghost-id"] }
  ]
}
```

### 4.2 嵌套调用（execute-workflow）怎么复制 —— 关键

工作流里“调用另一个工作流”的块（`execute-workflow`）保存的是**子工作流的 id**，不是名字。所以：

- **子工作流必须和父工作流一起复制**。只拷父流程，服务器启动/导入时就会报告缺失。
- **id 绝对不能手改**：扩展编辑器左侧复制工作流时 id 是新生成的——你复制到服务器的每一条都带着原始 id，父子关系天然对上；手动改 id 会让所有引用它的父流程断链。
- **同一批导入天然解决顺序问题**：导入是“两遍”的——先收录全部，再检查引用，所以父流程和子流程放在同一个 `workflows.json` 里一次导入即可。
- **同名不冲突**：服务器按 id 索引；两个同名工作流只要 id 不同就是两条。

缺失检查的三道防线：

| 层 | 入口 | 行为 |
| --- | --- | --- |
| 导入时 | `POST /api/workflows/import` | 每条返回 `missing: [子流程id…]`（整个批次收完后计算） |
| 查询时 | `GET /api/workflows/:id/references` | 返回完整引用树：`references`（引用了谁）、`missing`（缺谁，**传递闭包**）、`cycles`（循环引用链） |
| 启动前 | `POST /api/runs` | 预检失败 → **422**，`missing` 列出要补拷的子流程 id |

```bash
# 看一个流程完整依赖了谁、缺谁
curl -s http://127.0.0.1:8787/api/workflows/parent-1/references -H "Authorization: Bearer $BC_TOKEN"
# { "references": [{"nodeId":"sub-0","nodeLabel":"Execute workflow","childId":"child-1"}],
#   "missing": [], "cycles": [] }
```

**循环引用**（A 调 B、B 又调 A）允许存储、允许列出，运行时引擎的 `parentWorkflowIds` 护栏会拦截自环并继续执行后续节点；服务器启动日志也会警告。

### 4.3 变量与触发器的迁移语义

- 变量表 `table`、运行变量、触发器字段都在 workflows.json 里，随复制一起迁移。
- 触发器（trigger 块）：`interval`（每 N 分钟）、`specific-day`（每周几 + 时间）、`date`（一次性）、`scheduled`（**cron 表达式，扩展里不自动生效，服务器支持**，写在 trigger 块 `data.schedule` 或顶层 `trigger.schedule`，5 段式 `分 时 日 月 周`）。`trigger.enabled=false` 的时间触发器不会部署。

## 5. 触发方式与调用示例

所有请求带 `Authorization: Bearer <BC_TOKEN>`（Webhook 无法自定义头时可用 `?token=`）。

### 5.1 HTTP API

```bash
# 列出工作流
curl -s http://127.0.0.1:8787/api/workflows -H "Authorization: Bearer $BC_TOKEN"

# 立即运行（按 id），可注入变量 / 指定持久化 profile / 代理
curl -s -X POST http://127.0.0.1:8787/api/runs \
  -H "Authorization: Bearer $BC_TOKEN" -H "Content-Type: application/json" \
  -d '{"workflowId":"parent-1","variables":{"keyword":"手机"},"profile":"shop","proxy":{"server":"http://per-context"}}'
# → 202 {"runId":"r7Kx…","status":"queued"}

# 也可以直接内联提交一份工作流 JSON 运行（不入库）
curl -s -X POST .../api/runs -d '{"workflow":{…},"variables":{…}}'

# 查询进度/结果（steps 是引擎逐步日志，尾部 500 条）
curl -s http://127.0.0.1:8787/api/runs/<runId> -H "Authorization: Bearer $BC_TOKEN"
# → {"status":"ok|failed|cancelled|running|queued","summary":"…","error":"…","steps":[…]}

# 取消
curl -X DELETE http://127.0.0.1:8787/api/runs/<runId> -H "Authorization: Bearer $BC_TOKEN"
```

完整路由：`GET /healthz`、`GET/PUT /api/workflows[/:id]`、`POST /api/workflows/import`、`POST /api/workflows/reload`、`GET /api/workflows/:id/references`、`GET/POST /api/runs`、`GET/DELETE /api/runs/:id`、`POST /api/hooks/:workflowId`。

### 5.2 Webhook 触发

```bash
curl -X POST "http://127.0.0.1:8787/api/hooks/parent-1?token=$BC_TOKEN" \
  -H "Content-Type: application/json" -d '{"variables":{"order":"A-1024"}}'
```

适合从 GitHub Actions / CI / 第三方系统回调触发。

### 5.3 定时（cron）

无需调用——导入带触发器的工作流后自动布防（导入/更新会即时重新计算）。服务器还额外支持扩展里闲置的 `scheduled` cron 文本。并发上限 `BC_MAX_CONCURRENT`（默认 2），排队队列 FIFO。

### 5.4 飞书

- **命令机器人**（长连接，无需公网回调）：`BC_FEISHU_BOT_ENABLED=1` + `BC_FEISHU_APP_ID/APP_SECRET`（应用需开启长连接模式、订阅 `im.message.receive_v1` 并发布版本）。私聊机器人发 `/workflow <名称或id>` 运行并回报结果；`/runs` 看最近运行；`/help` 帮助。
- **结果推送**（群自定义机器人）：`BC_FEISHU_WEBHOOK_URL/WEBHOOK_SECRET` 预留推送通道。

## 6. 配置参考

优先级：`BC_*` 环境变量 > `server/config.json`（`BC_CONFIG` 可指向别处）> 内置默认。模板见 `server/config.example.json`。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `BC_PORT` | 8787 | HTTP 端口 |
| `BC_TOKEN` | （空=无鉴权） | Bearer Token；**生产必设**，空时启动会警告 |
| `BC_DATA_DIR` | server/data | 运行日志/产物/ profile 根目录 |
| `BC_WORKFLOWS_FILE` | server/workflows.json | 工作流库文件（扩展同格式） |
| `BC_WORKFLOWS_EXTRA_DIR` | server/workflows.d | 额外合并的 `*.json` 工作流目录（可空） |
| `BC_BROWSER_MODE` | local | `local` 本地 Chromium / `cdp` 远端 CDP |
| `BC_CDP_ENDPOINT` | — | CDP 模式必填，如 `ws://127.0.0.1:9222` |
| `BC_BROWSER_HEADLESS` | 1 | 有头调试设 0（桌面环境） |
| `BC_MAX_CONCURRENT` | 2 | 同时运行的 workflow 数 |
| `BC_RUN_TIMEOUT_MS` | 600000 | 单次运行硬超时 |
| `BC_LLM_BASE_URL/_API_KEY/_MODEL` | — | ai-agent / AI 接管用的 OpenAI 兼容模型 |
| `BC_FEISHU_*` | — | 见 §5.4 |

### 6.1 敏感配置放哪、怎么配（LLM Key / 飞书 Secret 示例）

敏感值有**三个配置渠道**，选一个即可；同一台机器上环境变量优先级最高（会覆盖 config.json）。
无论哪个渠道，这些文件都**不会进 git**（根 `.gitignore` 已忽略 `.env`，`server/.gitignore` 已忽略 `config.json`）——但仍要养成习惯：密钥只出现在服务器本机。

#### 渠道 1：环境变量（推荐，任何部署方式都适用）

**Linux / macOS（bash，临时，当前终端有效）：**

```bash
export BC_LLM_BASE_URL="https://api.deepseek.com/v1"
export BC_LLM_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxx"        # DeepSeek/OpenAI 兼容 Key
export BC_LLM_MODEL="deepseek-chat"
export BC_FEISHU_BOT_ENABLED=1
export BC_FEISHU_APP_ID="cli_a1b2c3d4e5f6g7h8"             # 飞书自建应用 App ID
export BC_FEISHU_APP_SECRET="xxxxxxxxxxxxxxxxxxxxxxxx"     # 飞书自建应用 App Secret
pnpm --dir server start
```

**Windows（PowerShell）：**

```powershell
$env:BC_LLM_API_KEY     = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
$env:BC_FEISHU_APP_ID   = "cli_a1b2c3d4e5f6g7h8"
$env:BC_FEISHU_APP_SECRET = "xxxxxxxxxxxxxxxxxxxxxxxx"
pnpm --dir server start
```

**systemd 常驻（密钥落在独立文件，`EnvironmentFile` 格式：`KEY=VALUE`，不要加 `export`）：**

```bash
# 1) 建密钥文件（root 可读，其他用户不可）
sudo install -m 600 /dev/null /etc/browser-copilot/runner.env
sudo tee /etc/browser-copilot/runner.env > /dev/null <<'EOF'
BC_TOKEN=换成一段随机长字符串
BC_LLM_BASE_URL=https://api.deepseek.com/v1
BC_LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
BC_LLM_MODEL=deepseek-chat
BC_FEISHU_BOT_ENABLED=1
BC_FEISHU_APP_ID=cli_a1b2c3d4e5f6g7h8
BC_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
EOF

# 2) service 里引用它
#    /etc/systemd/system/bc-runner.service 的 [Service] 段加一行：
#    EnvironmentFile=/etc/browser-copilot/runner.env
sudo systemctl daemon-reload && sudo systemctl restart bc-runner
```

#### 渠道 2：`server/config.json`（单机直跑最省事，文件不入库）

```bash
cd browser-copilot
cp server/config.example.json server/config.json   # 模板复制一份
chmod 600 server/config.json                       # 收紧权限（Linux）
```

然后编辑 `server/config.json`，把密钥填进对应字段（和上表的环境变量一一对应）：

```json
{
  "token": "换一段随机长字符串",
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    "model": "deepseek-chat"
  },
  "feishu": {
    "botEnabled": true,
    "appId": "cli_a1b2c3d4e5f6g7h8",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

保存后启动 `pnpm --dir server start` 即生效。注意：**这个文件在 `server/.gitignore` 里，永远不会被 `git add`，但如果你手工打包/复制整个目录到别处，要记得它带着密钥。**

#### 渠道 3：Docker Compose 的 `.env`（容器部署推荐）

`docker-compose.yml` 里的 `${BC_TOKEN:-}` 占位符会自动读取**与 compose 文件同目录**的 `.env` 文件：

```bash
cd browser-copilot
cat > .env <<'EOF'
BC_TOKEN=换一段随机长字符串
BC_LLM_BASE_URL=https://api.deepseek.com/v1
BC_LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
BC_LLM_MODEL=deepseek-chat
BC_FEISHU_BOT_ENABLED=0
BC_FEISHU_APP_ID=
BC_FEISHU_APP_SECRET=
EOF
chmod 600 .env
docker compose up -d        # 密钥只进入容器内存，不进镜像、不进 git
```

根 `.gitignore` 已包含 `.env`（含 `.env.*`），不会误提交。用 `docker compose config` 可以核对最终注入容器的值。

#### 验证密钥已生效（30 秒 demo）

**LLM**：起服务后内联提交一个只有 `ai-prompt` 的最小工作流，看回复：

```bash
curl -s -X POST http://127.0.0.1:8787/api/runs \
  -H "Authorization: Bearer $BC_TOKEN" -H "Content-Type: application/json" \
  -d '{"workflow":{"id":"llm-check","name":"LLM连通性检查","drawflow":{"nodes":[{"id":"t","label":"trigger","position":{"x":0,"y":0},"data":{"blockId":"trigger"}},{"id":"p","label":"ai-prompt","position":{"x":1,"y":0},"data":{"blockId":"ai-prompt","prompt":"只回复两个字：OK"}}],"edges":[{"id":"e","source":"t","target":"p"}]}}}'
# → {"runId":"…"}；轮询 GET /api/runs/<runId>，steps 里 ai-prompt 的 result 出现 "OK" 即配置生效
```

若报 `AI 块: 服务端未配置模型…` 说明三个 `BC_LLM_*` 变量没有读到（查启动终端 / `docker compose config`）。

**飞书**：配置了 `BC_FEISHU_APP_ID/APP_SECRET` 且 `BC_FEISHU_BOT_ENABLED=1` 时，服务启动日志出现
`[feishu] long connection established`；在飞书里私聊你的应用机器人发送 `/help`，收到命令列表即通了。
（注意：App Secret 属于自建应用凭证，在飞书开放平台「凭证与基础信息」页获取；应用需开启长连接模式并订阅 `im.message.receive_v1`。`BC_FEISHU_WEBHOOK_URL/SECRET` 是群自定义机器人的推送通道，当前为预留项，命令机器人只依赖 APP_ID/APP_SECRET。）

#### 密钥轮换与泄露处理

- 换 Key：改环境变量/文件 → 重启进程（容器则 `docker compose up -d` 重建），无需动仓库。
- 一旦怀疑泄露：先在服务商后台吊销（DeepSeek 控制台 / 飞书开放平台重置 App Secret），再换新值重启；已提交进 git 历史的密钥视为已泄露，必须吊销而不是删除提交。

## 7. 块支持矩阵（相对扩展）

- **完全支持**：click/fill/scroll/hover/按键/勾选、open-url/new-tab/switch-tab/close-tab/reload、get-text/get-form/set-radio/attribute-value/tab-url、set/get-variable、insert/export-data、slice/regex/increase/delete/sort/data-mapping、log-data、condition/conditions/delay、loop-data/repeat-task/while-loop/loop-elements（引擎循环）、**execute-workflow（嵌套）**、cookie、clipboard、element-exists、link、create-element、upload-file、handle-dialog、wait-connections、trigger-event、webhook、javascript-code（页面优先、本地兜底）、handle-download、save-local、forms、event-click/hover-element/element-scroll、loop-breakpoint、workflow-state、parameter-prompt（从运行变量读取）。
- **服务端降级**（记录日志后继续）：notification（→日志）、proxy/save-assets/switch-to/browser-event（占位说明）、parameter-prompt（无人值守无弹窗）。
- **AI 块**：`ai-prompt`、`ai-agent`（可带 `actOnPage` 让模型真实操作页面）、失败节点 **AI 接管**（与扩展同一 prompt/判定协议，最多 3 次尝试，结果写入失败块的目标变量；参数修正建议只记录不自动应用）。
- **OCR**：`ocr` 走 tesseract.js（Node 原生可用）。
- **不支持**：google-sheets / google-drive（需 Google OAuth 云服务，报错终止）。

## 8. 数据与可观测性

```
data/
├── workflows.json          # 工作流库（主文件，扩展同格式）
├── runs/<runId>.jsonl      # 每次运行的逐步日志（JSON Lines）
├── runs/<runId>.final.json # 终态记录（status/summary/error）
└── artifacts/<runId>/      # export-data 导出、截图、下载文件、AI 截图
```

## 9. 安全清单

1. **必设 `BC_TOKEN`**；没有 Token 时 API 完全开放，只适合 `127.0.0.1` 调试。
2. 对公网暴露时前置反向代理 + HTTPS，或用 SSH 隧道 / WireGuard 内网访问。
3. 工作流能驱动真实浏览器出网——只导入可信来源的 workflows.json。
4. LLM Key、飞书 Secret 用环境变量注入，不要写进仓库——三个渠道的具体配法与验证 demo 见 §6.1。
5. `BC_MAX_CONCURRENT` 控制资源占用；CDP/browserless 端口不要裸暴露公网。

## 10. 故障排查

| 现象 | 处理 |
| --- | --- |
| `422 missing: [...]` | 把列出的子工作流一并复制进来（§4.2），导入后再跑 |
| 运行一直 `queued` | 并发被占满（`/api/runs` 看在跑的），或浏览器启动失败看 stderr |
| `cdp` 启动报 endpoint 错误 | `BC_BROWSER_MODE=cdp` 必须同时给 `BC_CDP_ENDPOINT` |
| AI 块报“未配置模型” | 设置 `BC_LLM_BASE_URL/_API_KEY/_MODEL` |
| 飞书 404 / 收不到消息 | 应用未开“长连接模式”或未订阅 `im.message.receive_v1` / 版本未发布 |
| 定时没触发 | `GET /api/workflows` 看 trigger；`trigger.enabled=false` 不布防；cron 需 5 段式 |
| Windows 有头调试 | `BC_BROWSER_HEADLESS=0`，且以桌面会话运行（不要在服务会话里有头） |

## 11. 本地验证

```bash
pnpm --dir server typecheck   # 类型检查
pnpm --dir server test        # 单元测试（无浏览器）
pnpm --dir server smoke       # 端到端冒烟：起本地夹具页 + 真实 Chromium 跑父子工作流
```

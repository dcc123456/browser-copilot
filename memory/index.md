# 修改记忆索引

一行一天：**今天那一行可以改，历史行冻结**。详情进当天的 `YYYY-MM-DD.md`。

| 日期       | 摘要                                                                                                                                                                        | 详情                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 2026-11-27 | 删除轮次预算：聊天任务不再因 20 轮用尽暂停、可续期/改预算，长任务一直跑到模型完成或点停止，无人值守/子 agent 保留独立硬上限（到点直接停）；删除 Pollinations 免密钥默认 provider：新装 provider 列表为空、每个 provider 都必须填自己的 key，旧 default-pollinations 配置在读取与 v10 迁移时清理，保留免费额度徽标；修复发布包版本漂移：v0.6.20/v0.6.21 发布包里 manifest 停在 0.6.19、原地更新全部失败——打包前校验 manifest 版本 = package.json 且变体标记一致，并把「包内版本不符」从「无效安装包」改报为版本不一致、提示手动安装；完成 0.6.22 发布准备（bump 版本到 0.6.22、重写发布说明、CHANGELOG 与中英 README 更新）；移除对话区目标状态条：输入一句话不再出现「任务进行中」/「已完成」框，goal.state 广播与遗留的面板目标命令一并删除，任务仍在后台跟踪；原地更新改为不备份直接覆盖（写失败 abort 保留原文件、大文件 1MiB 分片），失败弹窗提供「重新下载」安装包与恢复提示，删除备份目录/清理逻辑与相关文案 | [详情](2026-11-27.md) |
| 2026-11-26 | 对话中不再自动弹出预算轮数设置：聊天模式不沿用旧目标的预算条与暂停闸门，其他模式的预算输入改为点「调整预算」才展开，切换/新建/删除会话会清掉残留的预算条与暂停卡片；设置顶部新增「故障恢复 → 重载插件」（确认后重启扩展）；下载目录移除「打开系统下载文件夹」按钮 | [详情](2026-11-26.md) |
| 2026-11-25 | 算子节点工具栏新增「只运行当前节点」测试按钮（单节点运行、不跟随出边、不写认证/首跑指标）；算子设置「出错时」的重试次数与间隔改为同一行；版本「应用」改为直接切换、不新增版本/回滚留痕，失败只提示一次；完成 0.6.21 发布准备（notes/CHANGELOG/README）；回合准备阶段加 20 秒超时、可被「停止」打断；打包版本号改为读 package.json（此前 manifest 停在 0.6.19）；存储位置在原目录不可读时可跳过迁移重选，重连失败有明确提示；文件夹选择器改为点击内直接弹出（取消不报错、失败显示原因） | [详情](2026-11-25.md) |
| 2026-11-24 | 工作流保存版本历史；未知算子可见占位卡片；一键美化排版剔除回退边、结果确定，分支组不可拆、合并在右，大图自动重选列数把可读拐点推到约 55 节点、日志改为输出排版事实；节点间距恢复 40；折行禁止 1–2 列碎片行（有分支组才强制、纯长链允许短尾行） | [详情](2026-11-24.md) |
| 2026-11-23 | 记忆目录规则与回填；`memory:log` 改为传入即将提交的 subject                                                                                                                 | [详情](2026-11-23.md) |
| 2026-11-22 | R10 显式预算（批次一/二、无人值守 K、持久化字段修复）；编辑器 AI 按 id 增/改/移/删 + 五条整图不变量；未解析变量兜底（P2）；tag 规则写进规范；版本号 bump 0.6.21（未打 tag） | [详情](2026-11-22.md) |
| 2026-11-21 | 10 次提交：chore(release): v0.6.20；docs(release): note the replay-memory limits …；docs(readme): deduplicate the 0.6.20 known-li… 等 10 项（回填） | [详情](2026-11-21.md) |
| 2026-11-20 | 22 次提交：feat(agent): persist durable task progress ac…；fix(agent): project retired reads instead of …；fix(agent): keep compaction sticky and projec… 等 22 项（回填） | [详情](2026-11-20.md) |
| 2026-11-19 | 1 次提交：fix(workflow): harden run reliability and add…（回填） | [详情](2026-11-19.md) |
| 2026-11-18 | 2 次提交：feat(workflow): add continue-from-log-row run…；feat(workflow): show full AI change diffs in …（回填） | [详情](2026-11-18.md) |
| 2026-11-17 | 4 次提交：feat(mcp): add save_workflow for manual workf…；docs(workflow): add GitHub AI tool to Xiaohon…；docs(workflow): align Xiaohongshu draft desig… 等 4 项（回填） | [详情](2026-11-17.md) |
| 2026-11-16 | 1 次提交：docs(discoverability): improve AI search and …（回填） | [详情](2026-11-16.md) |
| 2026-11-13 | 8 次提交：feat(agent): let users pick multiple elements…；Refactor code structure for improved readabil…；fix(agent): enable multi-element picking in c… 等 8 项（回填） | [详情](2026-11-13.md) |
| 2026-11-12 | 16 次提交：feat(workflow): allow deleting run logs indiv…；fix(workflow): expose script-produced variabl…；feat(workflow): make the assistant's script s… 等 16 项（回填） | [详情](2026-11-12.md) |
| 2026-11-11 | 4 次提交：docs(workflow): plan editor panel improvement…；docs(workflow): format improvement specs with…；fix(sidepanel): remove the AI repair entry fr… 等 4 项（回填） | [详情](2026-11-11.md) |
| 2026-11-09 | 2 次提交：fix(workflow): bound run-log variables and st…；fix(sidepanel): keep interrupted conversation…（回填） | [详情](2026-11-09.md) |
| 2026-11-08 | 1 次提交：feat(workflow): add company and headhunter jo…（回填） | [详情](2026-11-08.md) |
| 2026-11-06 | 16 次提交：feat(workflow): let users save drafts that fa…；feat(workflow): copy the run log as text from…；fix(workflow): keep object variables typed so… 等 16 项（回填） | [详情](2026-11-06.md) |
| 2026-11-05 | 3 次提交：test(scheduler): keep the one-shot alarm case…；fix(workflow): stop a missed click paying the…；chore(release): v0.6.18（回填） | [详情](2026-11-05.md) |
| 2026-11-02 | 10 次提交：refactor(models): remove redundant free-provi…；fix(models): make web-chat failures actionabl…；refactor(models): run web chat in a backgroun… 等 10 项（回填） | [详情](2026-11-02.md) |
| 2026-11-01 | 6 次提交：feat(settings): add directory shortcuts and i…；feat(agent): gate semi-auto on action risk an…；chore(release): v0.6.16 等 6 项（回填） | [详情](2026-11-01.md) |
| 2026-10-31 | 1 次提交：fix(sidepanel): keep terminate clickable whil…（回填） | [详情](2026-10-31.md) |
| 2026-10-30 | 2 次提交：feat(ui): polish notices, menus and workflow …；feat(sidepanel): terminate running workflows …（回填） | [详情](2026-10-30.md) |
| 2026-10-29 | 3 次提交：feat(agent): load specialised page tools by g…；feat(sidepanel): group the settings tool list…；docs(readme): document the features added sin…（回填） | [详情](2026-10-29.md) |
| 2026-10-28 | 16 次提交：fix(agent): stop narrating step counts in chat；fix(agent): keep image reads available in rea…；feat(picker): let the local agent act on the … 等 16 项（回填） | [详情](2026-10-28.md) |
| 2026-10-27 | 27 次提交：feat(update): delete the backup after the new…；fix(thinking): recognise the MiniMax internat…；feat(marketplace): share workflows inside a p… 等 27 项（回填） | [详情](2026-10-27.md) |
| 2026-10-26 | 29 次提交：feat(marketplace): add finer categories and p…；feat(marketplace): bundle called workflows on…；chore: fix prettier formatting for CI 等 29 项（回填） | [详情](2026-10-26.md) |
| 2026-10-25 | 15 次提交：docs(marketplace): spec a zero-server workflo…；feat(marketplace): add publish metadata model…；feat(marketplace): add github client and loca… 等 15 项（回填） | [详情](2026-10-25.md) |
| 2026-10-24 | 11 次提交：feat(docs): publish the bilingual workflow op…；feat(workflow-editor): link block docs to the…；fix(workflow): parse text exports misnamed as… 等 11 项（回填） | [详情](2026-10-24.md) |
| 2026-10-23 | 19 次提交：feat(workflow): widen assistant vocabulary an…；feat(workflow-editor): show model output and …；docs(workflow): record the assistant output a… 等 19 项（回填） | [详情](2026-10-23.md) |
| 2026-10-22 | 11 次提交：feat(workflow): rework group interactions and…；refactor(editor): drop AI optimize and save-t…；chore(deps): sync the pnpm lockfile 等 11 项（回填） | [详情](2026-10-22.md) |
| 2026-10-21 | 12 次提交：chore(workflow): add selftest corpus stats sc…；feat(workflow): compute safe rerun boundary f…；feat(workflow): add operator failure evidence… 等 12 项（回填） | [详情](2026-10-21.md) |
| 2026-10-20 | 7 次提交：Update media references in README；Update README.zh-CN.md；feat(workflow): add group blocks and page-gro… 等 7 项（回填） | [详情](2026-10-20.md) |
| 2026-10-19 | 5 次提交：feat(workflow): target a URL with reload-tab,…；style: reformat two files that drifted from p…；feat(repair): reflect on why a repair round f… 等 5 项（回填） | [详情](2026-10-19.md) |
| 2026-10-16 | 10 次提交：feat(workflow-editor): offer upstream variabl…；feat(workflow-editor): explain the goal contr…；fix(agent): bill a workflow ai-agent block's … 等 10 项（回填） | [详情](2026-10-16.md) |
| 2026-10-15 | 11 次提交：fix(workflow): unlock JS escape hatch when th…；feat(workflow): send the notification node to…；feat(workflow): free send-only operators from… 等 11 项（回填） | [详情](2026-10-15.md) |
| 2026-10-14 | 5 次提交：fix(storage): keep user turns when trimming a…；fix(workflow): box-select with Space instead …；feat(workflow): reserve the seed attribution … 等 5 项（回填） | [详情](2026-10-14.md) |
| 2026-10-13 | 4 次提交：docs(spec): record the run-window isolation d…；feat(background): give a conflicting schedule…；fix(workflow): make the new-window block re-p… 等 4 项（回填） | [详情](2026-10-13.md) |
| 2026-10-12 | 15 次提交：chore(gitignore): ignore the OCR traineddata …；feat(lib): add the token ledger aggregation a…；feat(lib): capture and persist token usage at… 等 15 项（回填） | [详情](2026-10-12.md) |
| 2026-10-10 | 1 次提交：feat(sidepanel): export a single skill and dr…（回填） | [详情](2026-10-10.md) |
| 2026-10-09 | 18 次提交：Merge remote-tracking branch 'origin/develop'…；chore(repo): format the tracked tree with pre…；fix(background): read shadow actionability wi… 等 18 项（回填） | [详情](2026-10-09.md) |
| 2026-10-08 | 2 次提交：Merge pull request #39 from dcc123456/develop；fix(workflow): stop branch gates falling thro…（回填） | [详情](2026-10-08.md) |
| 2026-10-06 | 5 次提交：docs(agents): add enforcement tags, reuse rul…；fix(workflow): honour the operator options th…；docs(workflow): record the per-operator verdi… 等 5 项（回填） | [详情](2026-10-06.md) |
| 2026-10-03 | 15 次提交：fix(workflow): let L3 certify a goal against …；fix(workflow): give an unattended replay a di…；fix(workflow): grade a step's promise on the … 等 15 项（回填） | [详情](2026-10-03.md) |
| 2026-10-02 | 5 次提交：fix(workflow): prove a generated graph's goal…；fix(workflow): give an unattended replay a di…；fix(workflow): make upload-file name its vari… 等 5 项（回填） | [详情](2026-10-02.md) |
| 2026-10-01 | 3 次提交：feat(workflow): make an unattended replay ans…；fix(workflow): make the failures a user actua…；feat(workflow): let a draft-goal replay reach…（回填） | [详情](2026-10-01.md) |
| 2026-09-30 | 1 次提交：fix(workflow): harden generation save, replay…（回填） | [详情](2026-09-30.md) |
| 2026-09-27 | 11 次提交：feat(workflow): make node fix verify goal sta…；Merge pull request #28 from dcc123456/develop；fix(inpage): accept target-shaped probes and … 等 11 项（回填） | [详情](2026-09-27.md) |
| 2026-09-26 | 14 次提交：refactor(workflow): add operator registry, di…；feat(workflow): add node goal contracts, veri…；feat(workflow): add file artifact and user fi… 等 14 项（回填） | [详情](2026-09-26.md) |
| 2026-09-23 | 36 次提交：feat(workflow): integrate generation and debu…；feat(workflow): support loop-back edges in wo…；feat(workflow): add block capability catalog 等 36 项（回填） | [详情](2026-09-23.md) |
| 2026-09-22 | 6 次提交：Implement new feature for user authentication…；feat(workflow): unify repair engine and make …；docs(workflow): document ai workflow architec… 等 6 项（回填） | [详情](2026-09-22.md) |
| 2026-09-21 | 2 次提交：feat(workflow): enforce runnability gates, co…；Implement feature X to enhance user experienc…（回填） | [详情](2026-09-21.md) |
| 2026-09-20 | 1 次提交：feat(agent): add ask_user tool with structure…（回填） | [详情](2026-09-20.md) |
| 2026-09-18 | 7 次提交：feat(workflow): keep business data dynamic an…；fix(workflow): align operator parameters acro…；fix(inpage): make injected functions self-con… 等 7 项（回填） | [详情](2026-09-18.md) |
| 2026-09-16 | 13 次提交：feat(workflow): resolve secrets at runtime in…；feat(agent): add i18n support for built-in ag…；fix(build): restore direct vite script refere… 等 13 项（回填） | [详情](2026-09-16.md) |
| 2026-09-15 | 6 次提交：feat: improve SEO — meta tags, manifest field…；feat(agent): add supervisor/specialist delega…；feat(sidepanel): add agents tab after skills … 等 6 项（回填） | [详情](2026-09-15.md) |
| 2026-09-14 | 2 次提交：feat(workflow): describe generated JS nodes i…；fix(workflow): record a scheduled workflow ta…（回填） | [详情](2026-09-14.md) |
| 2026-09-13 | 15 次提交：feat(workflow): raise AI-debug success rate (…；feat(server): harden the standalone runner；test: add offline debug benchmark and regress… 等 15 项（回填） | [详情](2026-09-13.md) |
| 2026-09-11 | 2 次提交：feat(sidepanel): separate thinking and tool c…；fix(sidepanel): sync workflow trigger edits a…（回填） | [详情](2026-09-11.md) |
| 2026-09-10 | 4 次提交：feat(executors): enhance error handling and c…；feat(mcp): bundle local-agent adapter with on…；chore(release): 0.6.1 等 4 项（回填） | [详情](2026-09-10.md) |
| 2026-09-09 | 7 次提交：fix(ocr): capture real pixels for canvas/capt…；refactor(editor): extract shared selector and…；feat(editor): localize all block form labels,… 等 7 项（回填） | [详情](2026-09-09.md) |
| 2026-09-08 | 13 次提交：fix(agent): auto-load tool groups on direct c…；feat(workflow): inject sub-workflow resolver …；feat(server): add standalone workflow runner … 等 13 项（回填） | [详情](2026-09-08.md) |
| 2026-09-07 | 6 次提交：feat(panel): draggable floating button, local…；docs: add AI coding guidelines (English commi…；feat(release): dual OCR/no-OCR variants; OCR … 等 6 项（回填） | [详情](2026-09-07.md) |
| 2026-09-06 | 1 次提交：feat: AI 接管替代自动调试 + AI 算子输出清洗（去思考/围栏）+ v0.5.7（回填） | [详情](2026-09-06.md) |
| 2026-09-05 | 1 次提交：feat: 面板最小化悬浮按钮 + 多窗口选择策略 + 编辑器连线模块 + 输入框失焦校验（回填） | [详情](2026-09-05.md) |
| 2026-09-04 | 17 次提交：docs(specs): 控制台日志查看工具 list_console_messages …；docs(specs): 控制台日志工具实施计划；refactor(capture): 元素截取多框架探测与 img-src 直取，OCR … 等 17 项（回填） | [详情](2026-09-04.md) |
| 2026-09-03 | 17 次提交：fix(ci): 放行 tesseract.js 构建脚本并移除本机 storeDir；chore: manifest 版本对齐 0.5.4；fix(mcp): 静态兜底工具列表对齐 ref 契约并补齐新工具 等 17 项（回填） | [详情](2026-09-03.md) |
| 2026-09-02 | 2 次提交：feat: local agent access, OCR image recogniti…；perf: 对话 agent 提速——常驻内核、CDP 事件监控、ref 缓存与 run_…（回填） | [详情](2026-09-02.md) |
| 2026-09-01 | 19 次提交：feat(storage): file-backed persistence and sc…；feat(skills): store skills as per-folder SKIL…；chore(release): 0.5.3 — document file-based s… 等 19 项（回填） | [详情](2026-09-01.md) |
| 2026-08-31 | 4 次提交：feat(chat): CSV export for tables and per-mes…；refactor(workflow): self-authored block catal…；feat(chat): lucide icons, stream usage stats,… 等 4 项（回填） | [详情](2026-08-31.md) |
| 2026-08-30 | 3 次提交：feat(chat): attachments, CDP trusted typing, …；chore(release): 0.5.2；feat(chat): bottom message actions, skill imp…（回填） | [详情](2026-08-30.md) |
| 2026-08-29 | 7 次提交：feat(page): click elements inside closed shad…；Add video embed to README；Insert video element in Chinese README 等 7 项（回填） | [详情](2026-08-29.md) |
| 2026-08-28 | 5 次提交：工作流修改提交；feat(workflow): enhance parameter editing wit…；feat(workflow): update action mappings and en… 等 5 项（回填） | [详情](2026-08-28.md) |
| 2026-08-27 | 20 次提交：feat(schedule): add manual task scheduling an…；docs: design spec for Automa workflow editor …；docs: implementation plan for Automa workflow… 等 20 项（回填） | [详情](2026-08-27.md) |
| 2026-08-26 | 1 次提交：fix(workflow): dispatch executors by blockId …（回填） | [详情](2026-08-26.md) |
| 2026-08-25 | 30 次提交：Trim page-context bloat in automated runs；Show token usage next to the mode selector；Let users turn off the system prompt and indi… 等 30 项（回填） | [详情](2026-08-25.md) |
| 2026-08-24 | 21 次提交：Add scheduled tasks, GitHub review reports, a…；Implement correct Feishu long-connection prot…；Fix Feishu long-connection handshake: correct… 等 21 项（回填） | [详情](2026-08-24.md) |
| 2026-08-23 | 1 次提交：ci: install pnpm before setup-node, use Node …（回填） | [详情](2026-08-23.md) |
| 2026-08-22 | 4 次提交：Add page actions, agent modes, data storage, …；Document acting capabilities, modes, data sto…；Add release packaging and CI workflow 等 4 项（回填） | [详情](2026-08-22.md) |
| 2026-08-20 | 6 次提交：Browser Copilot: side-panel assistant with pa…；Add pnpm lockfile；Render assistant replies as Markdown 等 6 项（回填） | [详情](2026-08-20.md) |

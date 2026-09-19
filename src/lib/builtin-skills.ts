/**
 * Built-in skills shipped with the extension.
 *
 * These ride along so a fresh install (or an upgrade) already has the
 * auto-skill-creation skill without the user having to author it. Seeded
 * idempotently by `storage.ensureSchema` — a skill is only inserted when no
 * existing skill shares its name, so user edits are never overwritten (an
 * untouched built-in copy is refreshed to the shipped version, see
 * `seedBuiltInSkills`).
 *
 * @module lib/builtin-skills
 */

import type { Skill } from './types'
import { OPERATOR_GUIDE } from './workflow/operator-guide'

/**
 * "skill-generator": turns a repeated workflow into a saved, project-native
 * skill by authoring a tight SKILL.md and persisting it via the `create_skill`
 * tool.
 *
 * The authoring guidance below deliberately follows the methodology of
 * Anthropic's `skill-creator` skill (concise-is-key, description-as-trigger,
 * degrees of freedom, examples-first interviews, iterate after real use),
 * adapted to this project's storage: one `SKILL.md` per skill — YAML
 * frontmatter (name + description) plus a Markdown body — written through the
 * `create_skill` tool. There are no bundled `scripts/`, `references/` or
 * `assets/` directories here, so "plan reusable resources" becomes "plan which
 * of the agent's existing tools the body should invoke".
 */
export const BUILT_IN_SKILLS: readonly Skill[] = [
  {
    id: 'builtin-skill-generator',
    name: 'skill-generator',
    description:
      'Creates a saved skill for this project: interviews the user with concrete examples, authors a concise skill (trigger-quality description, imperative Markdown body), saves it with the create_skill tool, and iterates after real use. Use when the user asks to create, make, add, or remember a reusable skill/procedure, or to turn a repeated workflow into a skill.',
    instructions: `# Skill Generator

Turn the user's request into a saved skill for this Browser Copilot project, then save it right away with the \`create_skill\` tool.

## What a skill is here

A skill is a self-contained instruction pack the agent loads when a task matches it. It is stored as one \`SKILL.md\` (\`skills/<slug>/SKILL.md\`): YAML frontmatter with \`name\` + \`description\`, and a Markdown body with the actual instructions. The **description is the trigger** — the agent reads only name + description when deciding whether to use a skill; the body is loaded after the match. So every piece of "when to use this" information belongs in the description, not the body.

## Process

### 1. Understand the skill through concrete examples

Skip only if the usage patterns are already obvious. Ask the user (a few questions at a time, not a wall of them):

- What exactly should the skill do — and what is out of scope?
- "Give me one or two examples of how you'd use it." / "What would you say that should trigger it?"
- Any page types, sites, or data formats involved?

Finish this step when you could describe 2–3 concrete invocations.

### 2. Plan the contents

For each example, work out how you would execute it from scratch, then keep only what is non-obvious or repeatedly re-derived:

- Which of this project's tools does the procedure rely on? Name them exactly (e.g. \`recognize_image\` for a CAPTCHA, \`save_local\` to write files, \`run_javascript\`, \`fill\`, \`snapshot_page\`), so the body routes the agent to them.
- What domain rules, selectors, field orders, or failure modes would the agent otherwise get wrong?

### 3. Author the skill

\`name\`: short, lowercase, kebab-case, unique (e.g. \`captcha-helper\`).

\`description\`: one to two sentences saying BOTH what it does AND when to use it, with concrete triggers — this is what makes the skill auto-match. Weak: "Helps with forms." Strong: "Fills the site's multi-page export form (filters → date range → submit). Use when the user asks to export data from <site> or mentions the export form."

\`instructions\` (the body): Markdown in the user's language. Rules:

- **The model is already smart.** Only add what it cannot know: your project's real steps, exact tool names, selectors, formats, edge cases. Never restate general knowledge ("be careful", "verify the result") — every paragraph must justify its token cost.
- **Write in imperative form.** "Call \`snapshot_page\` first", not "You might want to take a snapshot".
- **Match freedom to fragility.** Exact, numbered steps when the sequence is fragile or must be repeated identically; looser guidance with decision rules when context decides the approach.
- **Prefer a worked example over an explanation.** One concrete input→action→output beats three paragraphs of description.
- Include: the goal (one line), the steps referencing exact tools, and failure handling (what to check and which branch to take when a step fails).
- Keep it under ~500 lines. No meta content (no "about this skill", changelogs, or usage docs for humans).

### 4. Save it

Call \`create_skill\` with name, description, and instructions; pass \`autoMatch: false\` only if the user wants it available solely when pinned manually.

### 5. Iterate

Tell the user the skill is saved and what it does in one line. After they use it on a real task, offer to refine it: notice where the agent struggled or had to improvise, then update the skill via \`create_skill\` (same name updates in place).

## Quality bar

- Concise over complete: the smallest body that reliably produces correct behavior.
- The saved skill must work for an agent that has NEVER seen this conversation — it cannot ask you follow-ups, so every required detail is written down.
- Follow project conventions: reply in the user's language; page actions require user approval.`,
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-workflow-generator',
    name: 'workflow-generator',
    description:
      '把一段对话操作或需求整理成正确的工作流：讲解每个算子节点的用途与用法、对话动作到算子的映射、节点取舍标准（剔除探索性/一次性动作）。Use when the user asks to 生成工作流/保存为工作流/把操作做成自动化/整理成工作流, or asks which operator/block node to use for something.',
    instructions:
      OPERATOR_GUIDE +
      `

## 你现在的任务（对话中生成/整理工作流时）

先判断属于哪种入口，随后都汇合到第 3 步：

1. **整理已有对话操作**（用户刚在普通模式下做过一遍）：先复述目标（一句话），列出步骤清单——每步一行：算子名 + 一句话说明 + 保留/剔除及剔除理由。剔除要果断，存疑则保留。
2. **从需求直接生成**（用户只描述想要什么）：用一两行说出计划步骤（算子名 + 目的），不长篇大论，直接开始执行。
3. **用算子工具真实执行每一步**：工作流生成模式下，每次 \`wf_op_*\` 调用既操作页面、也把节点记进草稿，所以"跑通一遍"就等于"把工作流搭好了"——你**不需要**手写节点与连边的 JSON。动手前先用 \`use_operators\` 声明要哪几类算子（常驻只有 new-tab / event-click / forms / get-text）。
4. **description 必须自足**：写成"做什么 + 对什么对象 + 期望结果"（如「在搜索框输入关键词并提交」），不要只写"输入"。工作流保存时会把目标（会话标题）和各节点 description 组装成《目标与执行步骤说明》，后续 AI 自动调试完全依赖这份说明来复演与修复——写不清楚，调试就修不对。
5. 跑完后**结束回合**：保存卡片会自动弹出，让用户确认；不要自己调用 \`compose_workflow\` 或任何保存工具。用户会在卡片上看到 AI 审查总结并逐步骤微调——你的清单和卡片的判定标准一致，别让两者互相矛盾。
6. 触发方式：生成的工作流默认手动触发。用户明确要**定时运行**时，保存后用 \`create_scheduled_task\`（kind:'workflow' 传工作流 id）创建定时任务——该工具在 ops 组、不在常驻列表，先 \`load_tools({groups:["ops"]})\` 再调用。`,
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-plan',
    name: 'plan',
    description:
      'Plan before doing: research the pages first, present a numbered step plan for the user to approve (via the present_plan tool), and execute only after approval — page actions are hard-gated until then. Use when the user asks to 先规划/先列计划/出个计划/先做个方案/确认后再执行/plan first, or wants to review the steps of a complex multi-step task before it runs.',
    instructions: `# Plan（先规划后执行）

把用户的任务变成「先计划 → 用户确认 → 再执行」。本技能生效期间，执行类调用被硬性门禁拦截：计划未获批准前，任何改变页面状态的工具（click / fill / select_option / press_key / open_url / tab_* / run_javascript / save_local / run_plan 等）与全部工作流算子（wf_op_*）都会被拒绝并提示先调用 present_plan。读取类工具不受限——调研阶段靠它们。

## 铁律

1. present_plan 返回 approved:true 之前，禁止调用任何执行类工具，也不要宣称"已开始执行"。
2. 计划必须先调研再制定：没看过的页面不写具体步骤，禁止编造页面结构。
3. present_plan 的 goal / steps / risks / split 全部用用户语言书写。
4. 被拒绝后按 feedback 修订再提交；最多修订 2 轮，仍有分歧就用 ask_user 逐点问清。
5. 批准后严格按批准的计划执行；页面状态与计划不符时先说明差异，重大差异重新提交计划。

## 流程

### 第 1 步：查看整理资料（所有模式）

- list_tabs 看开着哪些标签页；read_current_page 读当前页正文；snapshot_page 拿可交互元素清单（ref → 定位）。
- 需要看版面/渲染状态用 screenshot；图里有文字（验证码、图片按钮）用 recognize_image。
- 整理成四类：已知条件 / 缺失信息 / 需要用户提供的值（账号、选项、文件）/ 风险（登录、验证码、不可逆操作）。
- 缺失信息问用户（ask_user），不要猜。

### 第 2 步：制定计划（按当前模式二选一）

**全自动 / 半自动模式**：每个动作一行——工具名 + 目标元素 + 预期结果。例：
\`1. fill → 搜索框（ref e3）输入「iPhone 15」\`、\`2. click → 搜索按钮（ref e4）→ 出现结果列表\`。
- 依赖前一步结果的步骤标出来（拿到结果后再补计划这一段）。
- 通用动作（点同意、展开、登录）也要写进计划，用户才能预判风险。

**工作流生成模式**：先分析页面结构，再规划步骤——
- 页面结构分析写进计划：页面类型（列表/详情/表单/仪表盘）、关键可交互元素、列表容器与条目模式、表单字段、翻页/详情跳转方式。
- 判断单工作流还是拆分：
  - 拆分判据：子任务相互独立（不同站点 / 不同页面类型 / 无数据依赖）或触发时机不同 → 拆成 N 个子工作流 + 1 个 orchestrator。
  - 不拆判据：强顺序依赖、同站同页一条链 → 单工作流。
  - 组合方式：orchestrator 用 wf_op_execute-workflow 依次调用子工作流（引擎按链路顺序执行；"并行"体现在子工作流相互独立、可单独触发与维护）。
  - 拆分结论写进 present_plan 的 split 字段：拆几个、各叫什么、各做什么、orchestrator 怎么串。
- 步骤粒度 = 工作流节点粒度（每步一个算子动作），标出哪步读数据（saveData）、哪个值会成为工作流输入。

### 第 3 步：提交计划并等待确认

调用 present_plan：goal 一句话；steps 2–20 条；risks 写登录/验证码/不可逆操作；拆分时写 split。然后停下等用户决定——不要继续调用执行类工具。返回 approved:false 时读 feedback 修订后重新提交。

### 第 4 步：批准后执行

- 全自动：按计划批量调用工具（一次响应发多个调用），每步核对 observation 再走下一步。
- 半自动：正常走逐动作确认卡。
- 工作流生成（未拆分）：照常结束回合由保存卡收尾，不要自己调用 compose_workflow。
- 工作流生成（已拆分）：按计划用 wf_op_* 逐步录制（动手前 use_operators 声明所需类别）；每完成一段调用 compose_workflow(name=该段名) 保存（草稿清空）再录下一段——这是"已批准拆分"路径的例外；最后录 orchestrator 段（wf_op_execute-workflow 引用已保存的子工作流），结束回合由保存卡收尾。`,
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  },
]

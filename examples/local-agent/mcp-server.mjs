#!/usr/bin/env node
/**
 * ============================================================================
 * Browser Copilot — 本地 Agent MCP 适配器（mcp-server.mjs）
 * ============================================================================
 *
 * 架构总览
 * --------
 * Browser Copilot 是一个 MV3 Chrome 扩展，它的 service worker 无法直接监听
 * TCP 端口，因此插件扮演 WebSocket 客户端，主动“向外拨号”连接本机适配器的
 * WebSocket 服务端（默认 ws://127.0.0.1:8765，仅回环地址，安全）。本文件就是
 * 这个“本地适配器”，它同时扮演两个角色：
 *
 *   1. WebSocket 服务端（RFC 6455，零依赖）：
 *      监听 127.0.0.1:8765，等待插件连接（插件 = WS 客户端）。
 *   2. MCP stdio 服务端（JSON-RPC 2.0，换行分隔 JSON）：
 *      编码 Agent（Claude Code / Trae / Codex）通过 stdio 自动拉起本进程，
 *      并把浏览器的操作能力当作 MCP 工具来调用。
 *
 * 数据流：
 *   Agent (MCP stdio) ──工具调用──▶ 本适配器 ──WS JSON──▶ Browser Copilot 插件
 *        ▲                              │                        │
 *        └──────────── 返回结果 ─────────┴────────────────────────┘
 *
 * 本文件只依赖 Node.js 内置模块（node:http / node:crypto / node:readline /
 * node:process），无需 npm install，直接 `node mcp-server.mjs` 即可运行。
 *
 * WS JSON 协议（对称的 JSON 文本帧）
 * ----------------------------------
 * 任意一侧都可以发送请求 { id, type, ... }，另一侧必须回
 * { id, ok: true, data } 或 { id, ok: false, error }。
 *
 * 本适配器发给插件的请求：
 *   { id, type: "ping" }
 *   { id, type: "tools.list" }
 *   { id, type: "tool", tool: "<name>", args: { ... } }   // args 可选
 *   { id, type: "prompt", prompt: "<自然语言指令>" }
 * 若在插件设置里配置了共享 token，则每个请求都要带上 token: "<token>"。
 *
 * 插件发给本适配器的请求（必须应答）：
 *   { id: "hb-<n>", type: "ping" }
 *       -> 回 { id: "hb-<n>", ok: true, data: { pong: true } }
 *   未知 type
 *       -> 回 { id, ok: false, error: "unknown request type: <type>" }
 *
 * 使用方式
 * --------
 *   node mcp-server.mjs                    # 直接运行
 *   node mcp-server.mjs --token <value>    # 附加共享 token（或用环境变量 BROWSER_COPILOT_TOKEN）
 * 然后在你的编码 Agent 中添加一条 stdio MCP 配置指向本文件（见同目录 README.md）。
 * 注意：stdout 只输出 JSON-RPC 响应，所有日志一律写入 stderr。
 *
 * 安全
 * ----
 * 只绑定 127.0.0.1（回环），外部网络无法访问。
 * ============================================================================
 */

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const HOST = '127.0.0.1';
// 端口可被环境变量覆盖（BROWSER_COPILOT_PORT）：供 mcp-tools-format.spec.ts 的
// 集成测试使用——测试要在同一台机器上起多份 adapter 实例互相对接，用临时端口
// 避免和用户本机正在运行的真实适配器（默认 8765）互相干扰。
const PORT = Number(process.env.BROWSER_COPILOT_PORT) || 8765;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const REQUEST_TIMEOUT_MS = 120_000; // 等待插件响应超时
const MAX_FRAME_SIZE = 1 << 20; // 单帧最大 ~1MB

// ---------------------------------------------------------------------------
// 共享 token：优先取 --token 参数，否则读环境变量 BROWSER_COPILOT_TOKEN
// ---------------------------------------------------------------------------
function readToken(argv) {
  const i = argv.indexOf('--token');
  if (i !== -1 && argv[i + 1] !== undefined && argv[i + 1] !== '') {
    return argv[i + 1];
  }
  return process.env.BROWSER_COPILOT_TOKEN || null;
}
const TOKEN = readToken(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 本适配器实例的 Agent 身份：每个编码 Agent 会话会拉起一个独立的适配器进程，
// 因此每个进程都有唯一的 agentId（仅用于匹配）。可读名称按
// BROWSER_COPILOT_AGENT_NAME > 启动方(claude/codex/trae)@项目目录名 生成，
// 让插件设置页里展示的连接名稳定可辨认。插件用它在多个连接之间区分/选择服务对象。
// ---------------------------------------------------------------------------
const AGENT_ID = randomUUID();

/** 从启动命令行大小写不敏感地推断调用方（claude / codex / trae，否则 mcp）。 */
function inferLauncher(argv) {
  const joined = argv.join(' ');
  if (/claude/i.test(joined)) return 'claude';
  if (/codex/i.test(joined)) return 'codex';
  if (/trae/i.test(joined)) return 'trae';
  return 'mcp';
}

/** 生成稳定可读的 Agent 名称：环境变量 BROWSER_COPILOT_AGENT_NAME > 启动方@当前目录名。 */
function buildAgentName(argv) {
  const envName = (process.env.BROWSER_COPILOT_AGENT_NAME || '').trim();
  if (envName) return envName;
  const launcher = inferLauncher(argv);
  const cwdBase = path.basename(process.cwd()) || 'workspace';
  return `${launcher}@${cwdBase}`;
}

const AGENT_NAME = buildAgentName(process.argv);

function log(...args) {
  console.error(`[mcp-server] ${new Date().toLocaleTimeString()}`, ...args);
}

// ---------------------------------------------------------------------------
// WebSocket 帧编解码（RFC 6455，零依赖）
// ---------------------------------------------------------------------------

/** 解析缓冲区里的第一个完整帧；数据不足返回 null，超大帧抛错。 */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    // 64 位长度（高 32 位 + 低 32 位）
    if (buf.length < 10) return null;
    const high = buf.readUInt32BE(2);
    const low = buf.readUInt32BE(6);
    len = high * 0x100000000 + low;
    offset = 10;
  }
  if (len > MAX_FRAME_SIZE) throw new Error('frame too large');
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked && maskKey) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, consumed: offset + len };
}

/** 编码一个服务端 -> 客户端帧（不掩码）。 */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// 插件连接（只保留一条）与“待回复请求”映射
// ---------------------------------------------------------------------------
let plugin = null; // 当前唯一的插件 socket（插件是 WS 客户端）
const agents = new Set(); // 代理客户端（其它适配器实例转发过来的 MCP 请求）
let ownServer = false; // 本进程是否成功占用了 8765 端口（否则以代理模式运行）
const pending = new Map(); // WS 请求 id -> { resolve, timer }

// 已连接 Agent 列表（id -> name）。主适配器负责汇总（自身的 stdio 会话 + 通过
// 代理模式接入的其它适配器实例），并上报给插件（agents.update）。
const connectedAgents = new Map();
/** 代理客户端 socket -> agentId，用于断开时从连接列表移除。 */
const agentSocketMap = new Map();

/** 本次运行中从插件拿到的真实工具列表缓存；插件离线时回退到静态列表兜底。 */
let cachedTools = null;

// ---------------------------------------------------------------------------
// JSON Schema 净化：把 $ref / $defs / oneOf 等可能不被部分 MCP 客户端支持的
// 结构扁平化，避免整个工具被客户端丢弃（表现为“工具空/不全”）。
// ---------------------------------------------------------------------------

/** 判断 schema 节点是否（任意深度）引用了 $ref；若是则整体折叠为 object。 */
function schemaHasRef(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(schemaHasRef);
  if (Object.prototype.hasOwnProperty.call(node, '$ref')) return true;
  return Object.values(node).some(schemaHasRef);
}

/**
 * 递归净化一个 JSON Schema 节点：
 *  - 删除 $ref / $defs / oneOf / anyOf / allOf / not
 *  - 属性含 $ref（如 target）时，该属性整体替换为 { type: 'object' }（尽量保留 description）
 *  - type 为数组（如 ['string','array']）折叠为单个字符串（优先 'string'）
 *  - 保留 type / description / enum / properties / items / required / additionalProperties
 */
function sanitizeSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  const out = {};
  if (typeof node.type !== 'undefined') {
    out.type = Array.isArray(node.type)
      ? node.type.includes('string')
        ? 'string'
        : node.type[0]
      : node.type;
  }
  if (typeof node.description === 'string') out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum;
  if (
    node.properties &&
    typeof node.properties === 'object' &&
    !Array.isArray(node.properties)
  ) {
    const props = {};
    for (const [key, val] of Object.entries(node.properties)) {
      // 属性定义（或其 items）引用了 $ref（如 target）→ 该属性整体折叠为 object，
      // 但 parameters 本身不受影响，其它属性仍被保留并递归净化。
      if (val && typeof val === 'object' && schemaHasRef(val)) {
        const collapsed = { type: 'object' };
        if (typeof val.description === 'string') {
          collapsed.description = val.description;
        }
        props[key] = collapsed;
      } else {
        props[key] = sanitizeSchema(val);
      }
    }
    out.properties = props;
  }
  if (node.items && typeof node.items === 'object') {
    out.items = schemaHasRef(node.items)
      ? { type: 'object' }
      : sanitizeSchema(node.items);
  }
  if (Array.isArray(node.required) && out.properties) {
    // 过滤后为空（如 STATIC_TOOLS 里 required: t.required || [] 生成的 []）
    // 时不输出该字段：required: [] 与省略语义相同，但测试契约要求 click 这类
    // 无必填参数的工具在 wire format 上干脆没有 required 字段。
    const required = node.required.filter((k) =>
      Object.prototype.hasOwnProperty.call(out.properties, k)
    );
    if (required.length > 0) out.required = required;
  }
  if (typeof node.additionalProperties !== 'undefined') {
    out.additionalProperties = node.additionalProperties;
  }
  return out;
}

/**
 * 把工具列表统一转换为 MCP 顶层格式 { name, description, inputSchema }：
 *  - OpenAI 格式（tool.type === 'function' 且 tool.function.name 为字符串）
 *    → { name, description, inputSchema: sanitizeSchema(fn.parameters) }
 *  - 已是 MCP 格式（tool.name 为字符串）→ 幂等转换
 *  - 无法识别（无合法 name）的条目被过滤掉
 */
function toMcpTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    let name = null;
    let description = '';
    let inputSchema;
    if (
      tool.type === 'function' &&
      tool.function &&
      typeof tool.function === 'object' &&
      typeof tool.function.name === 'string'
    ) {
      // OpenAI 格式 → MCP 顶层格式
      const fn = tool.function;
      name = fn.name;
      if (typeof fn.description === 'string') description = fn.description;
      inputSchema = sanitizeSchema(fn.parameters);
    } else if (typeof tool.name === 'string') {
      // 已是 MCP 格式（幂等）
      name = tool.name;
      if (typeof tool.description === 'string') description = tool.description;
      inputSchema = sanitizeSchema(tool.inputSchema);
    }
    if (!name) continue; // 无法识别（无合法 name）→ 过滤
    out.push({ name, description, inputSchema });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 静态兜底工具列表：插件未连接时 tools/list 仍返回真实工具名/描述/参数，确保
// 编码 Agent 的会话一启动就能挂载这些工具；插件连上后由插件返回的实时列表取代。
// ---------------------------------------------------------------------------
const STATIC_TOOLS = [
  { name: 'read_current_page', description: 'Read the title, URL, selection, and visible text of the active tab.', properties: { maxChars: { type: 'number' } } },
  { name: 'snapshot_page', description: 'Read the active page AND list its interactive elements (buttons, links, inputs) with refs. Call before clicking or filling.', properties: { maxChars: { type: 'number' }, maxElements: { type: 'number' } } },
  { name: 'click', description: 'Click an element (button, link, tab, etc.) by its ref from a snapshot.', properties: { ref: { type: 'string' }, target: { type: 'object' }, label: { type: 'string' }, withScreenshot: { type: 'boolean' } } },
  { name: 'recognize_image', description: 'Recognize text/content of an image (CAPTCHA). Pass an `image` data URL/URL, a CSS `selector` to capture, or nothing to screenshot the page.', properties: { image: { type: 'string' }, selector: { type: 'string' }, prompt: { type: 'string' } } },
  { name: 'screenshot', description: 'Capture the page or an element and send it to the vision model for inspection.', properties: { target: { type: 'string' }, prompt: { type: 'string' } } },
  { name: 'fill', description: 'Type text into an input or textarea, replacing its value.', properties: { ref: { type: 'string' }, target: { type: 'object' }, value: { type: 'string' }, label: { type: 'string' }, clear: { type: 'boolean' }, generated: { type: 'boolean' }, withScreenshot: { type: 'boolean' } }, required: ['value'] },
  { name: 'select_option', description: 'Choose an option in a <select> dropdown by its visible label or value.', properties: { ref: { type: 'string' }, target: { type: 'object' }, value: { type: 'string' }, label: { type: 'string' } }, required: ['value'] },
  { name: 'set_checkbox', description: 'Check or uncheck a checkbox, or select a radio button.', properties: { ref: { type: 'string' }, target: { type: 'object' }, value: { type: 'boolean' }, label: { type: 'string' } } },
  { name: 'press_key', description: 'Press a key on the focused element, e.g. "Enter", "Tab", "Escape".', properties: { key: { type: 'string' }, ref: { type: 'string' }, target: { type: 'object' } }, required: ['key'] },
  { name: 'scroll', description: 'Scroll the page or an element (into_view / by / top / bottom).', properties: { mode: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, ref: { type: 'string' }, target: { type: 'object' }, withScreenshot: { type: 'boolean' } } },
  { name: 'wait_for', description: 'Wait briefly until an element becomes visible.', properties: { ref: { type: 'string' }, target: { type: 'object' }, label: { type: 'string' } } },
  { name: 'open_url', description: 'Navigate the active tab to a URL.', properties: { url: { type: 'string' }, withScreenshot: { type: 'boolean' } }, required: ['url'] },
  { name: 'tab_new', description: 'Open a new tab, optionally navigating to a URL, and switch to it.', properties: { url: { type: 'string' } } },
  { name: 'tab_switch', description: 'Switch to another tab in this window by its index (0-based, from list_tabs).', properties: { index: { type: 'number' } }, required: ['index'] },
  { name: 'tab_close', description: 'Close the active tab.', properties: {} },
  { name: 'pin_tab', description: 'Pin a tab so subsequent actions target it (expires after 5 minutes).', properties: { tabId: { type: 'number' } } },
  { name: 'unpin_tab', description: 'Remove the tab pin; actions target the active tab again.', properties: {} },
  { name: 'run_javascript', description: 'Run custom JavaScript in the active page and return its result.', properties: { code: { type: 'string' } }, required: ['code'] },
  { name: 'run_plan', description: 'Execute an ordered sequence of already-decided steps in one round, stopping at the first failure.', properties: { steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' }, optional: { type: 'boolean' } }, required: ['tool'] } } }, required: ['steps'] },
  { name: 'list_tabs', description: 'List the tabs open in the current window with index, title, and URL.', properties: {} },
  { name: 'list_network_requests', description: 'List recent network requests of the active tab (URL, method, status, failures).', properties: {} },
  { name: 'get_my_profile', description: "Get the user's saved personal profile(s) for filling forms.", properties: {} },
  { name: 'list_secrets', description: 'List saved credential bundles by label/URL with field names (not values).', properties: {} },
  { name: 'get_secret', description: "Fill a field using a saved credential bundle by id (value never shown).", properties: { id: { type: 'string' }, field: { type: 'string' }, ref: { type: 'string' }, target: { type: 'object' } }, required: ['id'] },
  { name: 'use_skill', description: "Load a saved skill's full instructions by name and follow them.", properties: { name: { type: 'string' } }, required: ['name'] },
  { name: 'create_skill', description: 'Create or update a saved reusable skill (name/description/instructions).', properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' }, autoMatch: { type: 'boolean' } }, required: ['name', 'description', 'instructions'] },
  { name: 'list_scheduled_tasks', description: 'List the currently enabled scheduled tasks.', properties: {} },
  { name: 'save_local', description: 'Save text/content as a local file on the user\'s computer.', properties: { content: { type: 'string' }, filename: { type: 'string' } }, required: ['content'] },
].map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: t.properties,
      required: t.required || [],
    },
  },
}));

/** 主适配器把当前已连接的 Agent 列表上报给插件（供设置页选择连接）。 */
function broadcastAgents() {
  if (!ownServer || !plugin || plugin.destroyed) return;
  const list = [...connectedAgents.entries()].map(([id, name]) => ({ id, name }));
  wsSend(plugin, { type: 'agents.update', agents: list });
}

/** 向插件发送一个 JSON 文本帧。 */
function wsSend(socket, obj) {
  if (socket && !socket.destroyed) {
    socket.write(encodeFrame(0x1, JSON.stringify(obj)));
    return true;
  }
  return false;
}

/** 向插件发送一个请求并等待匹配 id 的回复；插件未连接时返回错误对象。 */
function sendWsRequest(payload) {
  return new Promise((resolve) => {
    if (!plugin || plugin.destroyed) {
      resolve({
        ok: false,
        error:
          'Browser Copilot 插件未连接：请先在插件设置里启用“本地 Agent 接入”，并保持浏览器运行。',
      });
      return;
    }
    const id = randomUUID();
    // 注意：必须先展开 payload 再覆盖 id。代理模式转发过来的 msg 自带上游请求
    // 的 id，若写成 { id, ...payload }，payload.id 会覆盖掉新生成的 id，导致插件
    // 按错误的 id 回包、pending 匹配不上而超时（表现为“插件未连接”/无响应）。
    const msg = { ...payload, id };
    // 标记请求来源 Agent，插件据此区分/选择服务哪个连接。
    // 代理客户端转发的请求已自带其自身身份，不要用本进程身份覆盖。
    if (typeof msg.agentId !== 'string') msg.agentId = AGENT_ID;
    if (typeof msg.agentName !== 'string') msg.agentName = AGENT_NAME;
    if (TOKEN) msg.token = TOKEN;

    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `等待插件响应超时（${payload.type}）` });
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, timer });
    if (!wsSend(plugin, msg)) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: 'Browser Copilot 插件连接已断开' });
    } else {
      log(`→ 插件 [${id}] ${payload.type}${payload.tool ? ` ${payload.tool}` : ''}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 代理模式：本进程无法绑定 8765（端口已被主适配器占用）时，以 WS 客户端身份
// 连接主适配器，把 MCP 请求转发过去执行。这样 Claude Code 的健康检查或其它
// 会话拉起的“重复实例”也能提供真实工具，而不会因 EADDRINUSE 直接退出。
// ---------------------------------------------------------------------------
const proxyPending = new Map(); // 上游请求 id -> { resolve, timer }
let proxyWs = null; // 上游主适配器连接（WS 客户端）
let proxyConnecting = false;
let proxyBuffer = Buffer.alloc(0);

/** 客户端 → 服务端帧必须掩码（RFC 6455）。 */
function encodeClientFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ maskKey[i & 3];
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, maskKey, masked]);
}

function failProxyPending(message) {
  for (const [id, entry] of proxyPending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: message });
  }
  proxyPending.clear();
}

function handleProxyFrame(socket, frame) {
  if (frame.opcode !== 0x1) return;
  let msg;
  try {
    msg = JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  const rid = msg.id;
  if (typeof rid === 'string' && proxyPending.has(rid)) {
    const entry = proxyPending.get(rid);
    proxyPending.delete(rid);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }
}

function proxyConnect() {
  if (proxyWs || proxyConnecting) return;
  proxyConnecting = true;
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    host: HOST,
    port: PORT,
    path: '/',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    },
  });
  req.on('upgrade', (_res, socket) => {
    proxyConnecting = false;
    proxyWs = socket;
    proxyBuffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      proxyBuffer = Buffer.concat([proxyBuffer, chunk]);
      while (true) {
        let frame;
        try {
          frame = parseFrame(proxyBuffer);
        } catch {
          socket.destroy();
          return;
        }
        if (!frame) break;
        proxyBuffer = proxyBuffer.subarray(frame.consumed);
        handleProxyFrame(socket, frame);
        if (socket.destroyed) return;
      }
    });
    socket.on('close', () => {
      if (proxyWs === socket) proxyWs = null;
      failProxyPending('与主适配器的连接已断开');
    });
    socket.on('error', () => {
      if (proxyWs === socket) proxyWs = null;
    });
    log('已作为 WS 客户端连上主适配器（代理模式）');
  });
  req.on('error', () => {
    proxyConnecting = false;
    proxyWs = null;
  });
  req.end();
}

/** 通过上游主适配器发起一个 WS 请求并等待匹配 id 的回复。 */
function proxyRequest(payload) {
  return new Promise((resolve) => {
    proxyConnect();
    const trySend = () => {
      if (!proxyWs || proxyWs.destroyed) {
        resolve({ ok: false, error: `主适配器不可达：请确认端口 ${PORT} 有主适配器在监听` });
        return;
      }
      const id = randomUUID();
      const msg = { id, ...payload };
      // 代理模式：把来源 Agent 的身份一并带给主适配器，主适配器据此汇总连接列表
      msg.agentId = AGENT_ID;
      msg.agentName = AGENT_NAME;
      if (TOKEN) msg.token = TOKEN;
      const timer = setTimeout(() => {
        proxyPending.delete(id);
        resolve({ ok: false, error: `等待主适配器响应超时（${payload.type}）` });
      }, REQUEST_TIMEOUT_MS);
      proxyPending.set(id, { resolve, timer });
      proxyWs.write(encodeClientFrame(0x1, JSON.stringify(msg)));
    };
    if (proxyWs && !proxyWs.destroyed) {
      trySend();
      return;
    }
    // 连接尚未建立：稍等片刻再发送（最多约 2s）
    let waited = 0;
    const tick = setInterval(() => {
      waited += 200;
      if (proxyWs && !proxyWs.destroyed) {
        clearInterval(tick);
        trySend();
      } else if (waited >= 2000) {
        clearInterval(tick);
        resolve({ ok: false, error: `主适配器不可达：请确认端口 ${PORT} 有主适配器在监听` });
      }
    }, 200);
  });
}

/** 统一出口：本进程持有端口且有插件连接则直接转发；否则代理到主适配器。 */
function sendToPlugin(payload) {
  if (ownServer) {
    if (plugin && !plugin.destroyed) return sendWsRequest(payload);
    return Promise.resolve({ ok: false, error: PLUGIN_OFFLINE_MSG });
  }
  return proxyRequest(payload);
}

// ---------------------------------------------------------------------------
// WebSocket 服务端（HTTP Upgrade + 帧处理）
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('Browser Copilot MCP adapter: WebSocket only (ws://127.0.0.1:8765)');
});

/** 首次识别出插件连接时：登记自身 Agent 并把当前连接列表上报给插件。 */
function ensurePlugin(socket) {
  const first = !plugin;
  plugin = socket;
  connectedAgents.set(AGENT_ID, AGENT_NAME);
  if (first) broadcastAgents();
}

/** 登记一个通过代理模式接入的 Agent（从它转发的请求里读取身份）。 */
function registerAgent(socket, msg) {
  if (msg && typeof msg.agentId === 'string') {
    connectedAgents.set(
      msg.agentId,
      typeof msg.agentName === 'string' ? msg.agentName : msg.agentId,
    );
    agentSocketMap.set(socket, msg.agentId);
    broadcastAgents();
  }
}

/** 处理一个 WS 客户端发来的帧（插件或代理客户端）。 */
function handleWsFrame(socket, frame) {
  switch (frame.opcode) {
    case 0x1: {
      // 文本帧
      let msg;
      try {
        msg = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        log('收到非 JSON 文本帧，忽略');
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const rid = msg.id;

      // 1) 插件对我们的请求的回复（代理客户端不会有 pending 匹配）
      if (typeof rid === 'string' && pending.has(rid)) {
        ensurePlugin(socket);
        const entry = pending.get(rid);
        pending.delete(rid);
        clearTimeout(entry.timer);
        entry.resolve(msg);
        return;
      }
      // 2) 插件心跳 / 连接识别：插件（WS 客户端）连上后会发 ping 心跳。心跳
      // 可能不带 id（真实插件发送 { type: 'ping' }，没有 id 字段）。只要收到
      // ping 就把它登记为插件连接，否则插件永远无法被识别、工具调用会一直报
      // “插件未连接”（tools/list 只返回静态兜底列表掩盖问题）。带 id 时回 pong。
      if (msg.type === 'ping') {
        ensurePlugin(socket);
        if (typeof rid === 'string') {
          log(`← 插件心跳 [${rid}]`);
          wsSend(socket, { id: rid, ok: true, data: { pong: true } });
        } else {
          log('← 插件心跳（无 id，已登记为插件连接）');
        }
        return;
      }
      // 3) 代理客户端（其它适配器实例）转发的 MCP 请求 → 转发给插件执行
      if (
        typeof rid === 'string' &&
        (msg.type === 'tools.list' || msg.type === 'tool' || msg.type === 'prompt')
      ) {
        agents.add(socket);
        registerAgent(socket, msg);
        void (async () => {
          const resp = await sendWsRequest(msg);
          if (!socket.destroyed) {
            wsSend(socket, {
              id: rid,
              ok: resp.ok === true,
              data: resp.data,
              error: resp.error,
            });
          }
        })();
        return;
      }
      // 4) 其它未知类型
      if (typeof rid === 'string' && typeof msg.type === 'string') {
        log(`← 未知请求类型 [${rid}] ${msg.type}`);
        wsSend(socket, { id: rid, ok: false, error: `unknown request type: ${msg.type}` });
      }
      return;
    }
    case 0x8:
      // 关闭帧：回一个 close 再关闭 TCP
      socket.write(encodeFrame(0x8, frame.payload));
      socket.end();
      return;
    case 0x9:
      // ping -> pong（原样回显负载）
      socket.write(encodeFrame(0xa, frame.payload));
      return;
    case 0xa:
      // pong：忽略
      return;
    default:
      return;
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  // 不在升级时抢占：等首条消息再识别是插件还是代理客户端，避免误踢已连的插件。
  log('新的 WS 客户端已连接（等待识别为插件或代理）');

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      let frame;
      try {
        frame = parseFrame(buffer);
      } catch (err) {
        log('帧解析错误:', err.message);
        socket.destroy();
        return;
      }
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      handleWsFrame(socket, frame);
      if (socket.destroyed) return;
    }
  });

  socket.on('close', () => {
    if (plugin === socket) {
      log('插件已断开');
      plugin = null;
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: '插件已断开连接' });
      }
      pending.clear();
    } else {
      // 代理客户端断开：从连接列表移除并重新上报
      const agentId = agentSocketMap.get(socket);
      if (agentId) {
        connectedAgents.delete(agentId);
        agentSocketMap.delete(socket);
        broadcastAgents();
      }
      agents.delete(socket);
    }
  });

  socket.on('error', (err) => log('socket 错误:', err.message));
});

// ---------------------------------------------------------------------------
// MCP stdio 服务端（JSON-RPC 2.0，换行分隔 JSON）
// ---------------------------------------------------------------------------

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 未连接插件时的统一错误文案（中英对照，帮助排障）。 */
const PLUGIN_OFFLINE_MSG =
  'Browser Copilot 插件未连接：请先在插件设置里启用“本地 Agent 接入”，并保持浏览器运行。';

async function handleMCPRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    log('MCP initialize');
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'browser-copilot-mcp', version: '0.1.0' },
    });
  }

  if (method === 'tools/list') {
    const resp = await sendToPlugin({ type: 'tools.list' });
    if (!resp || resp.ok !== true) {
      const errMsg = (resp && resp.error) || PLUGIN_OFFLINE_MSG;
      // 插件未连接时返回缓存的真实工具列表（或静态兜底列表）而非空列表：
      // 保证 Agent 会话一启动就能挂载 browser-copilot 工具。插件连上后由插件
      // 返回的实时列表取代，并更新缓存。两者都先做 schema 净化，避免客户端
      // 因 $ref/$defs/oneOf 等结构丢弃工具。
      const tools = toMcpTools(cachedTools || STATIC_TOOLS);
      log(`tools/list 插件未连接（返回兜底工具列表 ${tools.length} 个）：${errMsg}`);
      return jsonRpcResult(id, { tools });
    }
    const tools =
      resp.data && Array.isArray(resp.data.tools) ? resp.data.tools : [];
    if (Array.isArray(tools) && tools.length > 0) cachedTools = tools;
    return jsonRpcResult(id, { tools: toMcpTools(tools) });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const resp = await sendToPlugin({ type: 'tool', tool: name, args });
    if (resp && resp.ok === true) {
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(resp.data) }],
        isError: false,
      });
    }
    const errMsg = (resp && resp.error) || PLUGIN_OFFLINE_MSG;
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: errMsg }],
      isError: true,
    });
  }

  // 其它请求方法一律返回 Method not found
  return jsonRpcError(id, -32601, 'Method not found');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') return;
  // 无 id 的 JSON-RPC 通知（如 notifications/initialized）静默忽略
  if (req.id === undefined || req.id === null) return;

  let resp;
  try {
    resp = await handleMCPRequest(req);
  } catch (err) {
    resp = jsonRpcError(req.id, -32603, String((err && err.message) || err));
  }
  if (resp !== undefined) {
    process.stdout.write(JSON.stringify(resp) + '\n');
  }
});

rl.on('close', () => {
  log('stdin 已关闭（编码 Agent 退出），进程退出');
  process.exit(0);
});

// ---------------------------------------------------------------------------
// 启动与退出
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  ownServer = true; // 本进程成功占用了 8765 端口，成为主适配器
  log(`WebSocket 服务已启动：ws://${HOST}:${PORT}（仅回环）`);
  log('MCP stdio 服务已就绪：等待编码 Agent 通过 stdio 调用');
  log(
    TOKEN
      ? `已启用共享 token（BROWSER_COPILOT_TOKEN，${TOKEN.length} 字符）`
      : '未配置共享 token'
  );
  log('等待 Browser Copilot 插件连接…（请在插件设置里启用“本地 Agent 接入”）');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 端口已被其它适配器实例占用：不退出，切换到代理模式。
    // 以 WS 客户端身份连上主适配器，把 MCP 请求转发过去执行，
    // 这样 `claude mcp list` 的健康检查也能通过（返回真实工具）。
    log(`端口 ${PORT} 已被占用：切换到代理模式，转发请求到主适配器。`);
    ownServer = false;
    try {
      server.close(); // 释放未监听成功的 server，避免残留句柄
    } catch {
      /* 忽略：server 可能未处于运行状态 */
    }
    proxyConnect();
    return; // 继续作为 MCP stdio 服务（代理模式），不退出进程
  }
  log('服务错误:', err && err.message);
  process.exit(1);
});

function shutdown() {
  log('正在关闭…');
  if (plugin && !plugin.destroyed) {
    try {
      plugin.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
    } catch {
      /* ignore */
    }
    plugin.destroy();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

#!/usr/bin/env node
/**
 * One-shot MCP end-to-end verification for browser-copilot.
 * Spawns the adapter (mcp-server.mjs), performs MCP handshake,
 * lists tools, and optionally smoke-tests open_url + read_current_page.
 * Usage: node scripts/verify-mcp.mjs [--smoke]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ADAPTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/mcp-server.mjs');
const SMOKE = process.argv.includes('--smoke');
const child = spawn(process.execPath, [ADAPTER], { env: { ...process.env, BROWSER_COPILOT_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', d => process.stderr.write('[adapter] ' + d));

const pending = new Map();
let nextId = 1;
const rl = createInterface({ input: child.stdout });
rl.on('line', line => {
  const line2 = line.trim();
  if (!line2) return;
  let msg;
  try { msg = JSON.parse(line2); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
    pending.set(id, msg => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '0.0.1' },
  });
  if (init.error) throw new Error('initialize failed: ' + JSON.stringify(init.error));
  console.log('✓ MCP initialize OK:', JSON.stringify(init.result?.serverInfo ?? {}));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list');
  if (list.error) throw new Error('tools/list failed: ' + JSON.stringify(list.error));
  const tools = list.result?.tools ?? [];
  console.log(`✓ tools/list OK: ${tools.length} tools`);
  console.log('  ' + tools.map(t => t.name).join(', '));

  if (SMOKE) {
    // tab_new 而非 open_url：新开标签页，不打断用户正在看的页面
    const open = await rpc('tools/call', { name: 'tab_new', arguments: { url: 'https://example.com' } }, 60000);
    console.log('tab_new →', JSON.stringify(open.result?.content ?? open.error ?? open.result).slice(0, 200));
    const read = await rpc('tools/call', { name: 'read_current_page', arguments: {} }, 60000);
    const text = JSON.stringify(read.result?.content ?? read.error ?? read.result);
    console.log('read_current_page →', text.slice(0, 400));
  }
  console.log('ALL-CHECKS-PASSED');
} catch (e) {
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}

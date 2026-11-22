#!/usr/bin/env node
// Claude プラグインが起動する MCP サーバーを、Claude Code と同じ形で起動して確かめる。
//
// plugin/.mcp.json の command と args（${CLAUDE_PLUGIN_ROOT} は plugin/ に置き換える）で
// サーバーを起動し、initialize と tools/list に応答することを確かめる。npx は固定したバージョンを
// npm から取得するので、そのバージョンがまだ公開されていなければ失敗する。
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'plugin');
const mcp = JSON.parse(await fs.readFile(path.join(pluginRoot, '.mcp.json'), 'utf-8'));
const server = mcp.mcpServers.o2n;
const args = server.args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));

// 利用者のホーム（~/.o2n）に触れないよう、空のホームで起動する。作業フォルダも空にする
// （リポジトリの中で npx を実行すると、npm から取らずにワークスペースのパッケージを使ってしまう）
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-smoke-'));
// npm のプロキシや証明書の設定は引き継ぎ、o2n の設定（トークンなど）は渡さない
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(NOTION_TOKEN|O2N_)/.test(key)),
);
const child = spawn(server.command, args, {
  cwd: home,
  env: { ...env, HOME: home, USERPROFILE: home },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const timer = setTimeout(() => fail('no tools/list response within 120s'), 120_000);

function fail(message) {
  console.error(`smoke test failed: ${message}`);
  child.kill();
  process.exit(1);
}

child.on('exit', (code) => fail(`server exited early (code ${code})`));

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      console.log(`server: ${msg.result.serverInfo.name} ${msg.result.serverInfo.version}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name);
      if (!names.includes('scan_vault')) fail(`scan_vault missing from tools: ${names.join(', ')}`);
      console.log(`tools (${names.length}): ${names.join(', ')}`);
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.kill();
      fs.rm(home, { recursive: true, force: true }).finally(() => process.exit(0));
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'o2n-smoke', version: '0' } },
});

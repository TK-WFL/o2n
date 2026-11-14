#!/usr/bin/env node
// Claude プラグイン（plugin/）を、npm に公開済みの o2n のバージョンに合わせる。
//
//   node scripts/pin-plugin.mjs 0.8.1
//
// - plugin/package.json の version と @tk_wfl/o2n-mcp-server の固定バージョン
// - plugin/.claude-plugin/plugin.json の version と、説明文中の `npx @tk_wfl/o2n-cli@<version>`
// - plugin/README.md の `npx @tk_wfl/o2n-cli@<version>`
// を書き換え、plugin/package-lock.json を作り直す。
//
// ロックファイルは npm レジストリの情報（integrity）から作るので、そのバージョンを npm に
// 公開した後でしか実行できない。バージョン更新 PR → Publish → この PR、の順に進める（SECURITY.md）。
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/pin-plugin.mjs <exact version, e.g. 0.8.1>');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'plugin');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 公開前のバージョンを指すプラグインを配らないよう、先にレジストリを確かめる
const published = execFileSync(npmCmd, ['view', `@tk_wfl/o2n-mcp-server@${version}`, 'version'], { encoding: 'utf-8' }).trim();
if (published !== version) {
  console.error(`@tk_wfl/o2n-mcp-server@${version} is not on npm yet. Publish it first.`);
  process.exit(1);
}

const pinCli = (text) => text.replace(/npx (@tk_wfl\/o2n-cli)(?:@[^\s`]+)?/g, `npx $1@${version}`);

async function editJson(file, edit) {
  const json = JSON.parse(await fs.readFile(file, 'utf-8'));
  edit(json);
  await fs.writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
}

await editJson(path.join(pluginRoot, 'package.json'), (pkg) => {
  pkg.version = version;
  pkg.dependencies['@tk_wfl/o2n-mcp-server'] = version;
});
await editJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), (manifest) => {
  manifest.version = version;
  for (const option of Object.values(manifest.userConfig)) {
    if (typeof option.description === 'string') option.description = pinCli(option.description);
  }
});
const readmePath = path.join(pluginRoot, 'README.md');
await fs.writeFile(readmePath, pinCli(await fs.readFile(readmePath, 'utf-8')));

// 推移的な依存も含めて、その時点の最新の版で作り直す（古い依存を残さない）
await fs.rm(path.join(pluginRoot, 'package-lock.json'), { force: true });
execFileSync(npmCmd, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: pluginRoot,
  stdio: 'inherit',
});
console.log(`plugin pinned to ${version}. Run: npm test && (cd plugin && npm ci --ignore-scripts && npm audit) && node scripts/smoke-plugin-server.mjs`);

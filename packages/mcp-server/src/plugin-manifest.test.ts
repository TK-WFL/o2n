import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Claude のプラグイン（plugin/）が、公開する npm パッケージと食い違わないことを確かめる（#165）。
 * バージョン更新 PR で plugin.json と .mcp.json のピン留めを上げ忘れると、ここで落ちる。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pluginRoot = path.join(repoRoot, 'plugin');

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, 'utf-8')) as T;
}

interface UserConfigOption {
  type: string;
  default?: unknown;
  sensitive?: boolean;
}
interface PluginManifest {
  name: string;
  version: string;
  license?: string;
  userConfig: Record<string, UserConfigOption>;
}
interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}
interface PluginPackage {
  version: string;
  dependencies: Record<string, string>;
  overrides?: unknown;
}
interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
}
interface PluginLock {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

const SERVER_PACKAGE = '@tk_wfl/o2n-mcp-server';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

describe('Claude plugin manifest (#165)', () => {
  it('plugin.json・plugin/package.json の version と固定した MCP サーバーのバージョンがそろっている', async () => {
    const workspacePkg = await readJson<{ version: string; bin: Record<string, string> }>(path.join(repoRoot, 'packages', 'mcp-server', 'package.json'));
    const manifest = await readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const pluginPkg = await readJson<PluginPackage>(path.join(pluginRoot, 'package.json'));
    const pinned = pluginPkg.dependencies[SERVER_PACKAGE];
    // ディレクトリの審査は範囲指定や @latest を Blocking にするので、完全なバージョンで固定する
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(pinned);
    expect(pluginPkg.version).toBe(pinned);
    // プラグインは npm に公開済みのバージョンだけを指す。バージョン更新 PR の後、公開してから
    // scripts/pin-plugin.mjs で追いつかせるので、手元のパッケージより新しくなることはない
    expect(compareVersions(pinned, workspacePkg.version)).toBeLessThanOrEqual(0);
    // サーバーは Claude Code がロックファイルから入れたものを node で直接起動する（#257）
    const server = (await readJson<McpConfig>(path.join(pluginRoot, '.mcp.json'))).mcpServers.o2n;
    expect(server.command).toBe('node');
    expect(server.args).toEqual([`\${CLAUDE_PLUGIN_ROOT}/node_modules/${SERVER_PACKAGE}/${workspacePkg.bin['o2n-mcp-server']}`]);
  });

  it('plugin/package-lock.json が Claude Code の依存インストールの条件を満たす（#257）', async () => {
    const pluginPkg = await readJson<PluginPackage>(path.join(pluginRoot, 'package.json'));
    const lock = await readJson<PluginLock>(path.join(pluginRoot, 'package-lock.json'));
    // Claude Code は lockfileVersion 2 か 3 の npm ロックファイルだけを読む
    expect([2, 3]).toContain(lock.lockfileVersion);
    // package.json とロックファイルの依存が食い違うと、Claude Code はインストールしない
    expect(lock.packages[''].dependencies).toEqual(pluginPkg.dependencies);
    expect(lock.packages[`node_modules/${SERVER_PACKAGE}`].version).toBe(pluginPkg.dependencies[SERVER_PACKAGE]);
    // overrides があるとインストールしない
    expect(pluginPkg.overrides).toBeUndefined();
    // レジストリ以外の取得元を指す設定を置かない（ディレクトリの審査で Blocking）
    await expect(fs.access(path.join(pluginRoot, '.npmrc'))).rejects.toThrow();
    const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      // すべて npm レジストリの完全なバージョンで、ハッシュつき
      expect(entry.link, key).toBeUndefined();
      expect(entry.resolved, key).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, key).toMatch(/^sha512-/);
      // Claude Code は --ignore-scripts で入れるので、インストールスクリプトが要るパッケージは動かない
      expect(entry.hasInstallScript, key).toBeUndefined();
    }
  });

  it('プラグインの説明に書く npx のコマンドは、プラグインと同じ完全なバージョンで固定する', async () => {
    const manifest = await readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const texts = [
      await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf-8'),
      await fs.readFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'),
    ];
    const launches = texts.flatMap((t) => [...t.matchAll(/npx\s+(?:-y\s+)?(@tk_wfl\/[a-z0-9-]+)(@[^\s`"]+)?/g)]);
    expect(launches.length).toBeGreaterThan(0);
    for (const m of launches) expect(m[0]).toBe(`${m[0].slice(0, m[0].indexOf(m[1]))}${m[1]}@${manifest.version}`);
  });

  it('.mcp.json が参照する設定はすべて userConfig に既定値つきで宣言されている', async () => {
    const manifest = await readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const mcp = await readJson<McpConfig>(path.join(pluginRoot, '.mcp.json'));
    const referenced = Object.values(mcp.mcpServers.o2n.env).flatMap((v) => [...v.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) {
      const option = manifest.userConfig[key];
      expect(option, key).toBeDefined();
      // Cowork は設定画面を出さず、既定値のない設定を参照するサーバーを起動しない
      expect(option.default, key).not.toBeUndefined();
    }
    // トークン類は安全な保管場所に入る sensitive にする
    expect(manifest.userConfig.notion_token.sensitive).toBe(true);
    expect(manifest.userConfig.write_confirmation_token.sensitive).toBe(true);
    // 書き込みは既定で無効
    expect(manifest.userConfig.enable_write.default).toBe(false);
  });

  it('ディレクトリの必須項目（README 40語以上・ライセンス）がある', async () => {
    const manifest = await readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(manifest.license).toBe('MIT');
    await expect(fs.access(path.join(pluginRoot, 'LICENSE'))).resolves.toBeUndefined();
    const readme = await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf-8');
    const prose = readme.replace(/```[\s\S]*?```/g, '');
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  });

  it('ディレクトリ用のアイコン（正方形・128px 以上の SVG）がある (#169)', async () => {
    const svg = await fs.readFile(path.join(pluginRoot, '.claude-plugin', 'icon.svg'), 'utf-8');
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(Number(m![1])).toBeGreaterThanOrEqual(128);
    // 外部参照やスクリプトを含まない
    expect(svg).not.toMatch(/<script|href=|<image/i);
  });

  it('プライバシーポリシーを参照している (#175)', async () => {
    const manifest = await readJson<PluginManifest & { privacyPolicyUrl?: string }>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const url = 'https://github.com/TK-WFL/o2n/blob/main/PRIVACY.md';
    expect(manifest.privacyPolicyUrl).toBe(url);
    const readme = await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf-8');
    expect(readme).toMatch(/^## Privacy$/m);
    expect(readme).toContain(url);
    await expect(fs.access(path.join(repoRoot, 'PRIVACY.md'))).resolves.toBeUndefined();
  });

  it('マーケットプレイス（.claude-plugin/marketplace.json）が plugin/ の o2n を指している（#192）', async () => {
    const marketplace = await readJson<{ name: string; plugins: { name: string; source: string; description?: string }[] }>(
      path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
    );
    const manifest = await readJson<PluginManifest & { description: string }>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(manifest.name);
    expect(path.resolve(repoRoot, entry.source)).toBe(pluginRoot);
    expect(entry.description).toBe(manifest.description);
  });
});

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

describe('Claude plugin manifest (#165)', () => {
  it('plugin.json の version と .mcp.json のピン留めが npm パッケージのバージョンと一致する', async () => {
    const pkg = await readJson<{ version: string }>(path.join(repoRoot, 'packages', 'mcp-server', 'package.json'));
    const manifest = await readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const mcp = await readJson<McpConfig>(path.join(pluginRoot, '.mcp.json'));
    expect(manifest.version).toBe(pkg.version);
    const server = mcp.mcpServers.o2n;
    expect(server.command).toBe('npx');
    // ディレクトリの審査は範囲指定や @latest を Blocking にするので、完全なバージョンで固定する
    expect(server.args).toEqual(['-y', `@tk_wfl/o2n-mcp-server@${pkg.version}`]);
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
});

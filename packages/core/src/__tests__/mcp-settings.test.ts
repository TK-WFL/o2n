import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyMcpSettings,
  isTruthyFlag,
  loadMcpSettings,
  McpSettingsError,
  resolveMcpAccess,
  saveMcpSettings,
  type McpSettings,
} from '../mcp-settings.js';

let testRoot: string;
let homePath: string;

beforeEach(async () => {
  testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-mcp-settings-')));
  homePath = path.join(testRoot, 'home');
  await fs.mkdir(homePath);
  vi.spyOn(os, 'homedir').mockReturnValue(homePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

const fileWith = (s: Partial<McpSettings>) => async (): Promise<McpSettings> => ({ ...emptyMcpSettings(), ...s });
const noFile = async () => null;
const PHRASE = 'phrase-with-16-chars!';

describe('mcp-settings.json の保存と読み込み (#170)', () => {
  it('0600 で保存し、同じ内容を読める', async () => {
    const settings: McpSettings = { version: 1, allowedVaults: ['/v'], writeEnabled: true, writeConfirmationToken: PHRASE };
    await saveMcpSettings(settings);
    expect(await loadMcpSettings()).toEqual(settings);
    expect((await fs.stat(path.join(homePath, '.o2n', 'mcp-settings.json'))).mode & 0o777).toBe(0o600);
  });

  it('ファイルが無ければ null', async () => {
    await expect(loadMcpSettings()).resolves.toBeNull();
  });

  it('壊れた JSON や想定外の内容は分かるエラーにする', async () => {
    await fs.mkdir(path.join(homePath, '.o2n'), { mode: 0o700 });
    const p = path.join(homePath, '.o2n', 'mcp-settings.json');
    await fs.writeFile(p, '{not json', { mode: 0o600 });
    await expect(loadMcpSettings()).rejects.toBeInstanceOf(McpSettingsError);
    await fs.writeFile(p, JSON.stringify({ version: 1, allowedVaults: [], writeEnabled: true, writeConfirmationToken: 'short' }), { mode: 0o600 });
    await expect(loadMcpSettings()).rejects.toBeInstanceOf(McpSettingsError);
    await fs.writeFile(p, JSON.stringify({ ...emptyMcpSettings(), extra: 1 }), { mode: 0o600 });
    await expect(loadMcpSettings()).rejects.toBeInstanceOf(McpSettingsError);
  });

  it('短い確認フレーズは保存しない', async () => {
    await expect(saveMcpSettings({ ...emptyMcpSettings(), writeConfirmationToken: 'short' })).rejects.toThrow();
  });
});

describe('resolveMcpAccess (#170)', () => {
  it('プラグインの既定値（空・false）なら保存ファイルに従う（Cowork）', async () => {
    const env = { O2N_ALLOWED_VAULTS: '', O2N_ENABLE_MCP_WRITE: 'false', O2N_MCP_WRITE_TOKEN: '' };
    const access = await resolveMcpAccess(env, fileWith({ allowedVaults: ['/a', '/b'], writeEnabled: true, writeConfirmationToken: PHRASE }));
    expect(access).toEqual({
      allowedVaults: ['/a', '/b'],
      allowedVaultsSource: 'file',
      writeEnabled: true,
      writeEnabledSource: 'file',
      writeToken: PHRASE,
      writeTokenSource: 'file',
    });
  });

  it('環境変数に値があれば環境変数を使い、ファイルと合算しない', async () => {
    const env = { O2N_ALLOWED_VAULTS: ' /env ,', O2N_ENABLE_MCP_WRITE: 'true', O2N_MCP_WRITE_TOKEN: 'env-phrase-0123456789' };
    const access = await resolveMcpAccess(env, fileWith({ allowedVaults: ['/file'], writeEnabled: false, writeConfirmationToken: PHRASE }));
    expect(access.allowedVaults).toEqual(['/env']);
    expect(access.allowedVaultsSource).toBe('env');
    expect(access.writeEnabled).toBe(true);
    expect(access.writeEnabledSource).toBe('env');
    expect(access.writeToken).toBe('env-phrase-0123456789');
  });

  it('環境変数の確認フレーズが短すぎると無効（ファイルにも戻らない）', async () => {
    const access = await resolveMcpAccess({ O2N_MCP_WRITE_TOKEN: 'short' }, fileWith({ writeConfirmationToken: PHRASE }));
    expect(access.writeToken).toBeNull();
  });

  it('どちらにも無ければすべて拒否・無効', async () => {
    const access = await resolveMcpAccess({}, noFile);
    expect(access).toMatchObject({ allowedVaults: null, writeEnabled: false, writeToken: null });
  });

  it('環境変数だけで決まる項目のためにファイルを読まない', async () => {
    const load = vi.fn(noFile);
    await resolveMcpAccess({ O2N_ALLOWED_VAULTS: '/v', O2N_ENABLE_MCP_WRITE: '1', O2N_MCP_WRITE_TOKEN: PHRASE }, load);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('isTruthyFlag', () => {
  it.each(['1', 'true', 'TRUE', ' true '])('%j は有効', (v) => expect(isTruthyFlag(v)).toBe(true));
  it.each([undefined, '', '0', 'false', 'yes', 'on'])('%j は無効', (v) => expect(isTruthyFlag(v)).toBe(false));
});

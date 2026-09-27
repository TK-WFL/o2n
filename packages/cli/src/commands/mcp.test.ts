import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyMcpSettings, type McpSettings } from '@tk_wfl/o2n-core';
import { mcpAllowCommand, mcpDisallowCommand, mcpStatusCommand, mcpWriteCommand, type McpCommandDeps } from './mcp.js';

let testRoot: string;
let vault: string;
let stored: McpSettings | null;

const now = () => new Date('2026-09-27T00:00:00Z');
function deps(over: Partial<McpCommandDeps> = {}): Partial<McpCommandDeps> {
  return {
    isInteractive: () => true,
    prompt: async () => '',
    load: async () => (stored ? structuredClone(stored) : null),
    save: async (s) => {
      stored = structuredClone(s);
    },
    now,
    env: {},
    ...over,
  };
}
const output = () => vi.mocked(console.log).mock.calls.flat().join('\n');

beforeEach(async () => {
  testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-mcp-cmd-')));
  vault = path.join(testRoot, 'vault');
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  stored = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('o2n mcp allow / disallow (#170)', () => {
  it('Obsidian vault を実パスで追加し、二重には追加しない', async () => {
    expect(await mcpAllowCommand(path.join(vault, '.'), deps())).toBe(0);
    expect(await mcpAllowCommand(vault, deps())).toBe(0);
    expect(stored?.allowedVaults).toEqual([vault]);
    expect(stored?.updatedAt).toBe('2026-09-27T00:00:00.000Z');
  });

  it('ターミナル以外（ツール経由）からは許可を広げられない', async () => {
    expect(await mcpAllowCommand(vault, deps({ isInteractive: () => false }))).toBe(2);
    expect(stored).toBeNull();
  });

  it('Obsidian vault でないフォルダは拒否する', async () => {
    const plain = path.join(testRoot, 'plain');
    await fs.mkdir(plain);
    expect(await mcpAllowCommand(plain, deps())).toBe(2);
    expect(stored).toBeNull();
  });

  it('消えた vault も取り消せる（取り消しはターミナル外からでも可）', async () => {
    stored = { ...emptyMcpSettings(), allowedVaults: [vault, '/gone/vault'] };
    expect(await mcpDisallowCommand('/gone/vault', deps({ isInteractive: () => false }))).toBe(0);
    expect(stored?.allowedVaults).toEqual([vault]);
    expect(await mcpDisallowCommand('/not/listed', deps())).toBe(1);
  });
});

describe('o2n mcp write (#170)', () => {
  it('入力した確認フレーズで有効にする', async () => {
    expect(await mcpWriteCommand('on', deps({ prompt: async () => 'my-own-phrase-123456' }))).toBe(0);
    expect(stored).toMatchObject({ writeEnabled: true, writeConfirmationToken: 'my-own-phrase-123456' });
    expect(output()).not.toContain('my-own-phrase-123456');
  });

  it('空なら生成して一度だけ表示する', async () => {
    expect(await mcpWriteCommand('on', deps())).toBe(0);
    const phrase = stored?.writeConfirmationToken ?? '';
    expect(phrase.length).toBeGreaterThanOrEqual(16);
    expect(output()).toContain(phrase);
  });

  it('短いフレーズ・ターミナル外・不明なモードは拒否する', async () => {
    expect(await mcpWriteCommand('on', deps({ prompt: async () => 'short' }))).toBe(2);
    expect(await mcpWriteCommand('on', deps({ isInteractive: () => false }))).toBe(2);
    expect(await mcpWriteCommand('maybe', deps())).toBe(2);
    expect(stored).toBeNull();
  });

  it('off は確認フレーズも消す（ターミナル外からでも可）', async () => {
    stored = { ...emptyMcpSettings(), allowedVaults: [vault], writeEnabled: true, writeConfirmationToken: 'my-own-phrase-123456' };
    expect(await mcpWriteCommand('off', deps({ isInteractive: () => false }))).toBe(0);
    expect(stored).toEqual({ version: 1, allowedVaults: [vault], writeEnabled: false, updatedAt: '2026-09-27T00:00:00.000Z' });
  });
});

describe('o2n mcp status (#170)', () => {
  it('確認フレーズの値は表示しない', async () => {
    stored = { ...emptyMcpSettings(), allowedVaults: [vault], writeEnabled: true, writeConfirmationToken: 'secret-phrase-123456789' };
    expect(await mcpStatusCommand(deps({ env: { O2N_ENABLE_MCP_WRITE: 'false' } }))).toBe(0);
    const out = output();
    expect(out).toContain(vault);
    expect(out).toContain('設定済み');
    expect(out).toContain('有効（保存された設定）');
    expect(out).not.toContain('secret-phrase-123456789');
  });
});

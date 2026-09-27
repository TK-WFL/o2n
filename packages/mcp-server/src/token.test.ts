import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveCredentials } from '@tk_wfl/o2n-core';
import { isTruthyFlag, MISSING_TOKEN_MESSAGE, notionTokenFor } from './token.js';

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-mcp-token-')));
  const home = path.join(testRoot, 'home');
  await fs.mkdir(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('notionTokenFor (#164)', () => {
  it('プラグインのトークン欄が空（NOTION_TOKEN=""）なら保存済みの認証情報を使う', async () => {
    await saveCredentials({ token: 'stored', savedAt: '2026-09-27T00:00:00Z' });
    await expect(notionTokenFor(false, { NOTION_TOKEN: '' })).resolves.toBe('stored');
  });

  it('プラグインのトークン欄に入力があればそれを優先する', async () => {
    await saveCredentials({ token: 'stored', savedAt: '2026-09-27T00:00:00Z' });
    await expect(notionTokenFor(false, { NOTION_TOKEN: 'from-plugin' })).resolves.toBe('from-plugin');
  });

  it('どこにも無ければ null（dry-run は仮の値）', async () => {
    await expect(notionTokenFor(false, { NOTION_TOKEN: '' })).resolves.toBeNull();
    await expect(notionTokenFor(true, {})).resolves.toBe('dry-run-placeholder-token');
  });

  it('案内文が3つの経路を示す', () => {
    expect(MISSING_TOKEN_MESSAGE).toContain('プラグインの設定');
    expect(MISSING_TOKEN_MESSAGE).toContain('login --token');
    expect(MISSING_TOKEN_MESSAGE).toContain('NOTION_TOKEN');
  });
});

describe('isTruthyFlag (#165)', () => {
  it.each(['1', 'true', 'TRUE', ' true '])('%j は有効', (v) => expect(isTruthyFlag(v)).toBe(true));
  it.each([undefined, '', '0', 'false', 'yes', 'on'])('%j は無効', (v) => expect(isTruthyFlag(v)).toBe(false));
});

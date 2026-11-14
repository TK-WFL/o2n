import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore, atomicWriteVaultStateFile } from '@tk_wfl/o2n-core';
import { verifyCommand } from './verify.js';

let testRoot: string;
let vaultPath: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-verify-command-')));
  vaultPath = path.join(testRoot, 'vault');
  const homePath = path.join(testRoot, 'home');
  await fs.mkdir(vaultPath);
  await fs.mkdir(homePath, { mode: 0o700 });
  await fs.writeFile(path.join(vaultPath, 'Note.md'), '# Note');
  vi.spyOn(os, 'homedir').mockReturnValue(homePath);

  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

/** この端末で移行した状態を作る（署名鍵と、署名済みの state.json ができる） */
async function migrateOnce(targetVault: string): Promise<void> {
  const store = await StateStore.load(targetVault, 'root-page');
  await store.setNote('Note.md', { status: 'done', pageId: 'page-1', pageUrl: 'https://www.notion.so/page-1' });
  await store.flush();
}

/** 受け取った vault に最初から入っている、署名の無い state */
const CRAFTED_STATE = JSON.stringify({
  version: 2,
  parentPageId: 'root-page',
  notes: { 'Note.md': { status: 'done', pageId: '../users/me' } },
  files: {},
  folders: {},
});

describe('verify は確かめた state だけを使う（#251）', () => {
  it('この端末で移行した state は検証できる', async () => {
    await migrateOnce(vaultPath);
    expect(await verifyCommand(vaultPath)).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).toContain('done: 1');
  });

  it('署名鍵のある端末では、署名の無い state を置かれた vault の検証を止める', async () => {
    const ownVault = path.join(testRoot, 'own');
    await fs.mkdir(ownVault);
    await migrateOnce(ownVault);

    await atomicWriteVaultStateFile(vaultPath, 'state.json', CRAFTED_STATE);
    expect(await verifyCommand(vaultPath, { deep: true })).toBe(2);
    expect(errors.join('\n')).toContain('署名を確認できない');
    expect(logs).toEqual([]);
  });

  it('署名後に書き換えられた state は検証を止める', async () => {
    await migrateOnce(vaultPath);
    const statePath = path.join(vaultPath, '.o2n', 'state.json');
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf-8')) as { notes: Record<string, { pageId: string }> };
    parsed.notes['Note.md']!.pageId = 'another-page';
    await fs.writeFile(statePath, JSON.stringify(parsed));
    expect(await verifyCommand(vaultPath)).toBe(2);
    expect(errors.join('\n')).toContain('署名を確認できない');
  });

  it('署名鍵の無い端末では、署名を確認していないと伝えたうえで続ける', async () => {
    await atomicWriteVaultStateFile(vaultPath, 'state.json', CRAFTED_STATE);
    expect(await verifyCommand(vaultPath)).toBe(0);
    expect(errors.join('\n')).toContain('署名は確認していません');
    expect(logs.join('\n')).toContain('done: 1');

    logs = [];
    await verifyCommand(vaultPath, { json: true });
    expect((JSON.parse(logs.join('\n')) as { stateSignatureChecked: boolean }).stateSignatureChecked).toBe(false);
  });

  it('スキーマに合わない state は検証を止める', async () => {
    await atomicWriteVaultStateFile(
      vaultPath,
      'state.json',
      JSON.stringify({ version: 2, parentPageId: 'root-page', notes: { 'Note.md': { status: 'done', pageUrl: { toString: 1 } } }, files: {} }),
    );
    expect(await verifyCommand(vaultPath)).toBe(2);
    expect(errors.join('\n')).toContain('形式が正しくない');
    expect(logs).toEqual([]);
  });

  it('state.json が無いときは今までどおり migrate を促す', async () => {
    expect(await verifyCommand(vaultPath)).toBe(2);
    expect(errors.join('\n')).toContain('先に migrate を実行してください');
  });
});

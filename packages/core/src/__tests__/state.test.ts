import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateIntegrityError, StateStore, planHash, statePath } from '../state.js';

let tmpDir: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-state-test-'));
  tmpDir = await fs.realpath(createdRoot);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('StateStore readOnly（dry-run用）', () => {
  it('readOnly:true では setNote/setFile/setFolder がディスクに書き込まない', async () => {
    const state = await StateStore.load(tmpDir, 'root-page', { readOnly: true });
    await state.setNote('Note.md', { status: 'done', pageId: 'dry-run-x', contentHash: 'sha256:abc' });
    await state.setFile('img.png', { status: 'attached', fileUploadId: 'dry-run-upload' });
    await state.setFolder('Folder', { status: 'created', kind: 'page', notionId: 'dry-run-page' });

    await expect(fs.readFile(statePath(tmpDir), 'utf-8')).rejects.toThrow();
    // メモリ上には反映されている（dry-run内での進捗表示・レポート生成には使える）
    expect(state.getNote('Note.md')?.status).toBe('done');
  });

  it('readOnly指定なし（デフォルトfalse）では通常どおりディスクに書き込む', async () => {
    const state = await StateStore.load(tmpDir, 'root-page');
    await state.setNote('Note.md', { status: 'done', pageId: 'page-123', contentHash: 'sha256:abc' });

    const raw = await fs.readFile(statePath(tmpDir), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.notes['Note.md'].pageId).toBe('page-123');
  });

  it('dry-runで書いた内容は、後で readOnly:false で読み込んでも見えない', async () => {
    const dryState = await StateStore.load(tmpDir, 'root-page', { readOnly: true });
    await dryState.setNote('Note.md', { status: 'done', pageId: 'dry-run-x', contentHash: 'sha256:abc' });

    const realState = await StateStore.load(tmpDir, 'root-page');
    expect(realState.getNote('Note.md')).toBeUndefined();
  });
});

describe('StateStore integrity guard', () => {
  it('既存stateのparentPageIdが現在の計画と異なる場合は停止する', async () => {
    const state = await StateStore.load(tmpDir, 'root-page');
    await state.setNote('Note.md', { status: 'created', pageId: 'page-123', contentHash: 'sha256:abc' });

    await expect(StateStore.load(tmpDir, 'other-root')).rejects.toBeInstanceOf(StateIntegrityError);
  });

  it('署名済みstateのNotion IDが改ざんされた場合は停止する', async () => {
    const plan = { version: 1, vaultPath: tmpDir, parentPageId: 'root-page', folders: [], frontmatterMappings: {}, skipList: [] };
    const state = await StateStore.load(tmpDir, 'root-page', {
      planHash: planHash(plan),
      notionWorkspaceId: 'workspace-a',
      notionBotId: 'bot-a',
    });
    await state.setNote('Note.md', { status: 'created', pageId: 'page-123', contentHash: 'sha256:abc' });

    const parsed = JSON.parse(await fs.readFile(statePath(tmpDir), 'utf-8'));
    parsed.notes['Note.md'].pageId = 'attacker-page';
    await fs.writeFile(statePath(tmpDir), JSON.stringify(parsed, null, 2), 'utf-8');

    await expect(
      StateStore.load(tmpDir, 'root-page', {
        planHash: planHash(plan),
        notionWorkspaceId: 'workspace-a',
        notionBotId: 'bot-a',
      }),
    ).rejects.toBeInstanceOf(StateIntegrityError);
  });
});

describe('state.json の書き込みまとめ（#111）', () => {
  it('連続した setNote は書き込み回数がまとめられ、flush 後には全て反映されている', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-state-coalesce-')));
    try {
      const store = await StateStore.load(dir, 'root');
      const { promises: fsp } = await import('node:fs');
      const origWrite = fsp.writeFile;
      let writes = 0;
      const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => {
        if (String(args[0]).includes('state.json')) writes += 1;
        return origWrite.apply(fsp, args as Parameters<typeof origWrite>);
      });
      const pending: Promise<void>[] = [];
      for (let i = 0; i < 200; i += 1) pending.push(store.setNote(`n${i}.md`, { status: 'done', pageId: `p${i}` }));
      await Promise.all(pending);
      await store.flush();
      spy.mockRestore();
      expect(writes).toBeLessThan(200);
      const reloaded = await StateStore.load(dir, 'root');
      expect(Object.keys(reloaded.snapshot.notes)).toHaveLength(200);
      expect(reloaded.getNote('n199.md')?.pageId).toBe('p199');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

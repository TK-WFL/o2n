import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore, statePath } from '../state.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-state-test-'));
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

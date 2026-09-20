import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration, wasAbortedByBlockLimit } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-blocklimit-')));
  for (const n of ['A', 'B', 'C', 'D']) {
    await fs.writeFile(path.join(tmpDir, `${n}.md`), `# ${n}\n\n本文 ${n}\n`);
  }
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Free プランのブロック上限で中断・再開（#70）', () => {
  it('上限 403 を受けたら残りノートの POST /pages を送らず、aborted として報告し、state は未着手のまま残る', async () => {
    const mock = createMockServer();
    mock.setBlockLimitAfterCreates(2); // 2ページ目まで成功、3ページ目で 403
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);

    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(wasAbortedByBlockLimit(report)).toBe(true);
    const aborted = report.find((e) => e.category === 'aborted');
    expect(aborted?.message).toContain('ブロック上限');
    expect(aborted?.message).toContain('resume');

    // 403 を受けた1回で止まる（4ノート分 = 4回にならない）
    const pageCreates = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages');
    expect(pageCreates).toHaveLength(3);

    const statuses = ['A.md', 'B.md', 'C.md', 'D.md'].map((p) => state.getNote(p)?.status);
    // 作成できた2件は created（Pass2 は走らないので linked/done にはならない）、残りは未着手（undefined）。failed は無い
    expect(statuses.filter((s) => s === 'created')).toHaveLength(2);
    expect(statuses.filter((s) => s === undefined)).toHaveLength(2);
    expect(statuses).not.toContain('failed');
    // 中断後は Pass2/3 のリクエストも送らない
    expect(mock.calls.some((c) => c.method === 'PATCH' && /markdown$/.test(c.path))).toBe(false);
  });

  it('上限解除後に再実行（resume）すると、未着手だったノートだけを作成して完走する', async () => {
    const mock = createMockServer();
    mock.setBlockLimitAfterCreates(2);
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });

    mock.setBlockLimitAfterCreates(null);
    const createsBefore = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });

    expect(wasAbortedByBlockLimit(report)).toBe(false);
    const createsAfter = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;
    // 2件だけ追加作成（既に created の2件は再作成しない）
    expect(createsAfter - createsBefore).toBe(2);
    for (const p of ['A.md', 'B.md', 'C.md', 'D.md']) expect(second.state.getNote(p)?.status).toBe('done');
  });

  it('フォルダコンテナ作成で上限に当たった場合も failed にせず中断する', async () => {
    await fs.mkdir(path.join(tmpDir, 'Sub'));
    await fs.writeFile(path.join(tmpDir, 'Sub', 'S.md'), '# S\n');
    const mock = createMockServer();
    mock.setBlockLimitAfterCreates(0);
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);

    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(wasAbortedByBlockLimit(report)).toBe(true);
    expect(state.snapshot.folders?.Sub).toBeUndefined();
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages')).toHaveLength(1);
  });
});

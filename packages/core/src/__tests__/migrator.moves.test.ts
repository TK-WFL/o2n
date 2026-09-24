import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration } from '../migrator.js';
import { summarizeState } from '../verify.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-moves-')));
  await fs.mkdir(path.join(tmpDir, 'Sub'));
  await fs.writeFile(path.join(tmpDir, 'Sub', 'keep.md'), '# keep');
  await fs.writeFile(path.join(tmpDir, 'A.md'), '# A\n\n本文 A\n');
  await fs.writeFile(path.join(tmpDir, 'B.md'), '# B\n\n本文 B\n');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function firstRun(mock: ReturnType<typeof createMockServer>) {
  const r = await setupMigration(tmpDir, mock.fetchImpl);
  await runMigration({ vaultPath: tmpDir, plan: r.plan, inventory: r.inventory, api: r.api, state: r.state, dryRun: false });
  return r.state;
}

describe('ノートの移動・改名の検知（#147）', () => {
  it('フォルダを移動したノートは同じページを Move page API で移動し、新規作成しない', async () => {
    const mock = createMockServer();
    const s1 = await firstRun(mock);
    const pageA = s1.getNote('A.md')!.pageId!;
    const creates = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;
    await fs.rename(path.join(tmpDir, 'A.md'), path.join(tmpDir, 'Sub', 'A.md'));

    const r = await setupMigration(tmpDir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan: r.plan, inventory: r.inventory, api: r.api, state: r.state, dryRun: false });
    const move = mock.calls.find((c) => c.method === 'POST' && c.path === `/pages/${pageA}/move`);
    expect(move?.body).toEqual({ parent: { type: 'page_id', page_id: r.state.snapshot.folders!['Sub']!.notionId } });
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length).toBe(creates);
    expect(r.state.getNote('Sub/A.md')?.pageId).toBe(pageA);
    expect(r.state.getNote('A.md')).toBeUndefined();
    expect(report.some((e) => e.category === 'moved' && e.message.includes('移動'))).toBe(true);
    expect(summarizeState(r.state.snapshot, r.inventory).orphaned).toEqual([]);
  });

  it('同じフォルダで改名したノートはタイトルだけ更新する', async () => {
    const mock = createMockServer();
    const s1 = await firstRun(mock);
    const pageB = s1.getNote('B.md')!.pageId!;
    await fs.rename(path.join(tmpDir, 'B.md'), path.join(tmpDir, 'B2.md'));
    const r = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: r.plan, inventory: r.inventory, api: r.api, state: r.state, dryRun: false });
    expect(mock.calls.some((c) => c.path === `/pages/${pageB}/move`)).toBe(false);
    const patch = mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${pageB}`);
    expect(JSON.stringify(patch?.body)).toContain('"content":"B2"');
    expect(r.state.getNote('B2.md')?.pageId).toBe(pageB);
  });

  it('内容も変えて移動した場合や、指紋が重複する場合は判別せず新規作成する', async () => {
    await fs.writeFile(path.join(tmpDir, 'E1.md'), '同じ');
    await fs.writeFile(path.join(tmpDir, 'E2.md'), '同じ');
    const mock = createMockServer();
    await firstRun(mock);
    await fs.rename(path.join(tmpDir, 'E1.md'), path.join(tmpDir, 'Sub', 'E1.md'));
    await fs.rename(path.join(tmpDir, 'E2.md'), path.join(tmpDir, 'Sub', 'E2.md'));
    await fs.writeFile(path.join(tmpDir, 'Sub', 'A.md'), '# A\n\n本文 A を編集\n');
    await fs.rm(path.join(tmpDir, 'A.md'));
    const creates = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;
    const r = await setupMigration(tmpDir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan: r.plan, inventory: r.inventory, api: r.api, state: r.state, dryRun: false });
    expect(mock.calls.some((c) => /\/move$/.test(c.path))).toBe(false);
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length).toBe(creates + 3);
    expect(report.some((e) => e.category === 'moved')).toBe(false);
  });

  it('dry-run では移動を報告するだけで API を呼ばない', async () => {
    const mock = createMockServer();
    await firstRun(mock);
    await fs.rename(path.join(tmpDir, 'A.md'), path.join(tmpDir, 'Sub', 'A.md'));
    const r = await setupMigration(tmpDir, mock.fetchImpl);
    const before = mock.calls.length;
    const report = await runMigration({ vaultPath: tmpDir, plan: r.plan, inventory: r.inventory, api: r.api, state: r.state, dryRun: true });
    expect(report.some((e) => e.category === 'moved' && e.message.includes('dry-run'))).toBe(true);
    expect(mock.calls.slice(before).some((c) => /\/move$/.test(c.path))).toBe(false);
  });
});

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-update-')));
  await fs.writeFile(path.join(tmpDir, 'A.md'), '# A\n\nv1\n');
  await fs.writeFile(path.join(tmpDir, 'B.md'), '# B\n');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ノート編集後の resume（#105）', () => {
  it('内容が変わったノートは新規作成せず、同じページを replace_content で更新する', async () => {
    const mock = createMockServer();
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const pageId = first.state.getNote('A.md')!.pageId!;
    const createsBefore = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;

    await fs.writeFile(path.join(tmpDir, 'A.md'), '# A\n\nv2 ![[pic.png]]\n');
    await fs.writeFile(path.join(tmpDir, 'pic.png'), Buffer.from([1]));
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });

    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length).toBe(createsBefore);
    const replace = mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${pageId}/markdown` && (c.body as { type?: string }).type === 'replace_content');
    expect(String((replace!.body as { replace_content: { new_str: string } }).replace_content.new_str)).toContain('v2');
    expect(mock.calls.some((c) => c.method === 'PATCH' && c.path === `/pages/${pageId}`)).toBe(true);
    expect(second.state.getNote('A.md')).toMatchObject({ status: 'done', pageId });
    expect(report.some((e) => e.message.includes('本文を置き換えました'))).toBe(true);
    // 変更のない B は触らない
    expect(mock.calls.some((c) => c.path.includes(first.state.getNote('B.md')!.pageId!) && c.method === 'PATCH')).toBe(false);
  });

  it('replace_content が失敗（子ページを含む等）した場合は警告して前回の state を据え置く', async () => {
    const mock = createMockServer();
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const before = { ...first.state.getNote('A.md')! };

    await fs.writeFile(path.join(tmpDir, 'A.md'), '# A\n\nv2\n');
    mock.failMarkdownPatchOfType('replace_content');
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });
    expect(second.state.getNote('A.md')).toMatchObject({ pageId: before.pageId, contentHash: before.contentHash });
    expect(report.some((e) => e.category === 'warning' && e.message.includes('ページ更新に失敗'))).toBe(true);
  });
});

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-deferred-')));
  await fs.writeFile(path.join(tmpDir, 'A.md'), '# A\n\nsee [[B]] here\n');
  await fs.writeFile(path.join(tmpDir, 'B.md'), '# B\n\nbody\n');
  await fs.writeFile(path.join(tmpDir, 'C.md'), '# C\n\n[[Nowhere]]\n');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('リンク先の作成失敗 → resume で成功したらリンクに書き換える（#139）', () => {
  it('1回目は [[B]] のまま保留し、2回目に B が作られたらブロック単位でリンクに置き換える', async () => {
    const mock = createMockServer();
    mock.failPageCreateContaining('# B');
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    const report1 = await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const a = first.state.getNote('A.md')!;
    expect(a.deferredLinks).toEqual([{ targetPath: 'B.md', text: '[[B]]', displayText: 'B' }]);
    expect(first.state.getNote('C.md')!.deferredLinks).toBeUndefined(); // vault に無いリンクは保留しない
    expect(report1.some((e) => e.message.includes('resume でリンク先が作成されると'))).toBe(true);

    // Notion 上の A の本文（Pass2 で [[B]] に戻された状態）を再現
    mock.setPageBlocks(a.pageId!, [
      { id: 'a-block-1', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'see [[B]] here', link: null }, annotations: { bold: false }, plain_text: 'see [[B]] here' }] } },
    ]);
    mock.failPageCreateContaining(null);
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });

    const bUrl = second.state.getNote('B.md')!.pageUrl!;
    const patch = mock.calls.find((c) => c.method === 'PATCH' && c.path === '/blocks/a-block-1');
    expect(patch?.body).toEqual({
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: 'see ', link: null }, annotations: { bold: false } },
          { type: 'text', text: { content: 'B', link: { url: bUrl } }, annotations: { bold: false } },
          { type: 'text', text: { content: ' here', link: null }, annotations: { bold: false } },
        ],
      },
    });
    expect(second.state.getNote('A.md')!.deferredLinks).toBeUndefined();
  });

  it('リンク先がまだ失敗中なら保留のまま残し、ブロックも取得しない', async () => {
    const mock = createMockServer();
    mock.failPageCreateContaining('# B');
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const aId = first.state.getNote('A.md')!.pageId!;
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    const before = mock.calls.length;
    await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });
    expect(second.state.getNote('A.md')!.deferredLinks).toHaveLength(1);
    expect(mock.calls.slice(before).some((c) => c.method === 'GET' && c.path === `/blocks/${aId}/children`)).toBe(false);
  });
});

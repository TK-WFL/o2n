import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-folders-')));
  await fs.mkdir(path.join(tmpDir, 'Projects', 'Alpha'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'Projects', 'Beta'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'Projects', 'Alpha', 'a.md'), '# a');
  await fs.writeFile(path.join(tmpDir, 'Projects', 'Beta', 'b.md'), '# b');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('中間フォルダの階層（#135）', () => {
  it('Projects ページが作られ、Alpha / Beta はその子として作られる', async () => {
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const projectsId = state.snapshot.folders?.['Projects']?.notionId;
    expect(projectsId).toBeTruthy();
    const creates = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages');
    const parentOf = (title: string) =>
      (creates.find((c) => JSON.stringify((c.body as { properties?: unknown }).properties).includes(`"content":"${title}"`))?.body as { parent: { page_id: string } }).parent.page_id;
    expect(parentOf('Projects')).toBe('root-page');
    expect(parentOf('Alpha')).toBe(projectsId);
    expect(parentOf('Beta')).toBe(projectsId);
    expect(parentOf('a')).toBe(state.snapshot.folders?.['Projects/Alpha']?.notionId);
  });

  it('旧バージョンで子フォルダだけ作成済みの state を resume しても、空の中間フォルダページを後から作らない', async () => {
    const mock = createMockServer();
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    // 旧バージョン相当: Projects を計画から外して移行（Alpha/Beta がルート直下に作成される）
    first.plan.folders = first.plan.folders.filter((f) => f.folderPath !== 'Projects');
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const before = mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;

    const second = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length).toBe(before);
    expect(second.state.snapshot.folders?.['Projects']).toBeUndefined();
  });
});

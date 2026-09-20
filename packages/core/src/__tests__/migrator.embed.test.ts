import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-embed-')));
  await fs.mkdir(path.join(tmpDir, 'Sub'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'Host.md'), '# Host\n\n![[Embedded]]\n\n[[Other]]\n');
  await fs.writeFile(path.join(tmpDir, 'Sub', 'Embedded.md'), '# Embedded\n\n![[pic.png]]\n\n[[Other]]\n');
  await fs.writeFile(path.join(tmpDir, 'Other.md'), '# Other\n');
  await fs.writeFile(path.join(tmpDir, 'Sub', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('embedMode: inline の end-to-end（#80）', () => {
  it('埋め込み先の本文が Host ページに展開され、その中の添付・リンクは Host ページ上で解決される', async () => {
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);
    plan.embedMode = 'inline';

    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const hostCreate = mock.calls.find((c) => c.method === 'POST' && c.path === '/pages' && String((c.body as { markdown?: string })?.markdown).includes('# Host'));
    const md = (hostCreate!.body as { markdown: string }).markdown;
    expect(md).toContain('埋め込み:');
    expect(md).toContain('# Embedded');
    // Host の本文に Embedded 由来の添付プレースホルダーが含まれる
    expect(md.match(/⟦o2n-file-\d+⟧/g)).toHaveLength(1);

    const hostId = state.getNote('Host.md')!.pageId!;
    const embeddedId = state.getNote('Sub/Embedded.md')!.pageId!;
    const otherId = state.getNote('Other.md')!.pageId!;
    // Pass2: Host ページの update_content に Other と Embedded（caption）へのリンクが両方入る
    const hostPatches = mock.calls.filter((c) => c.method === 'PATCH' && c.path === `/pages/${hostId}/markdown`);
    const patchJson = JSON.stringify(hostPatches.map((c) => c.body));
    expect(patchJson).toContain(`notion.so/${otherId}`);
    expect(patchJson).toContain(`notion.so/${embeddedId}`);
    // Pass3: 添付ブロックが Host ページ（と Embedded ページ自身）の両方に貼られる
    const appends = mock.calls.filter((c) => c.method === 'PATCH' && /\/blocks\/.+\/children$/.test(c.path));
    expect(appends.some((c) => c.path === `/blocks/${hostId}/children`)).toBe(true);
    expect(appends.some((c) => c.path === `/blocks/${embeddedId}/children`)).toBe(true);
    expect(state.getNote('Host.md')?.attachedPlaceholders).toHaveLength(1);

    for (const p of ['Host.md', 'Sub/Embedded.md', 'Other.md']) expect(state.getNote(p)?.status).toBe('done');
    expect(report.some((e) => e.path === 'Host.md' && e.message.includes('インライン展開'))).toBe(true);
    expect(report.some((e) => e.category === 'unresolved_link')).toBe(false);
  });

  it('embedMode 未指定（link）では従来通り埋め込みはリンクに降格する', async () => {
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);
    expect(plan.embedMode).toBeUndefined();

    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const hostCreate = mock.calls.find((c) => c.method === 'POST' && c.path === '/pages' && String((c.body as { markdown?: string })?.markdown).includes('# Host'));
    const md = (hostCreate!.body as { markdown: string }).markdown;
    expect(md).not.toContain('# Embedded');
    expect(md.match(/⟦o2n-file-\d+⟧/g)).toBeNull();
    expect(report.some((e) => e.path === 'Host.md' && e.message.includes('リンクに降格'))).toBe(true);
  });
});

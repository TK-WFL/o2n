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

describe('frontmatter の icon / cover（#113）', () => {
  it('絵文字 icon・URL cover・vault 内画像 cover がページ装飾として PATCH され、メタ callout から除かれる', async () => {
    await fs.writeFile(path.join(tmpDir, 'pic.png'), Buffer.from([1]));
    await fs.writeFile(path.join(tmpDir, 'D1.md'), '---\nicon: 🚀\ncover: "![[pic.png]]"\ntags: [x]\n---\n# D1\n');
    await fs.writeFile(path.join(tmpDir, 'D2.md'), '---\nicon: https://x/i.png\nbanner: https://x/b.jpg\n---\n# D2\n');
    await fs.writeFile(path.join(tmpDir, 'D3.md'), '---\nicon: LiCoffee\n---\n# D3\n');
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const patchFor = (name: string) => mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${state.getNote(name)!.pageId}`)?.body as { icon?: unknown; cover?: unknown } | undefined;
    expect(patchFor('D1.md')).toMatchObject({ icon: { type: 'emoji', emoji: '🚀' }, cover: { type: 'file_upload' } });
    expect(patchFor('D2.md')).toMatchObject({ icon: { type: 'external', external: { url: 'https://x/i.png' } }, cover: { type: 'external', external: { url: 'https://x/b.jpg' } } });
    expect(patchFor('D3.md')).toBeUndefined();

    const created = (name: string) => String((mock.calls.find((c) => c.method === 'POST' && c.path === '/pages' && String((c.body as { markdown?: string }).markdown).includes(`# ${name}`))!.body as { markdown: string }).markdown);
    expect(created('D1')).toContain('tags: x');
    expect(created('D1')).not.toContain('icon:');
    expect(created('D1')).not.toContain('cover:');
    expect(created('D3')).toContain('icon: LiCoffee');
  });
});

describe('変更判定の指紋（#136）', () => {
  it('frontmatter だけを変えたノートも resume で同じページが更新される', async () => {
    await fs.writeFile(path.join(tmpDir, 'F.md'), '---\nstatus: todo\n---\n# F\n');
    const mock = createMockServer();
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const pageId = first.state.getNote('F.md')!.pageId!;

    await fs.writeFile(path.join(tmpDir, 'F.md'), '---\nstatus: done\n---\n# F\n');
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });
    const replace = mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${pageId}/markdown` && (c.body as { type?: string }).type === 'replace_content');
    expect(JSON.stringify(replace?.body)).toContain('status: done');
  });

  it('本文だけのハッシュ（v0.4.0 以前）の state は変更なしとみなし、ハッシュだけ新形式に更新する', async () => {
    const mock = createMockServer();
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const { contentHash } = await import('../state.js');
    const a = first.state.getNote('A.md')!;
    const body = first.inventory.notes.find((n) => n.path === 'A.md')!.content;
    await first.state.setNote('A.md', { ...a, contentHash: contentHash(body) });
    await first.state.flush();
    const patchesBefore = mock.calls.filter((c) => c.method === 'PATCH').length;

    const second = await setupMigration(tmpDir, mock.fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });
    expect(mock.calls.filter((c) => c.method === 'PATCH').length).toBe(patchesBefore);
    expect(second.state.getNote('A.md')!.contentHash).not.toBe(contentHash(body));
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages')).toHaveLength(2);
  });

  it('inline 埋め込み先ノートの変更でホストページも更新される', async () => {
    await fs.writeFile(path.join(tmpDir, 'Host.md'), '# Host\n\n![[B]]\n');
    const mock = createMockServer();
    const first = await setupMigration(tmpDir, mock.fetchImpl);
    first.plan.embedMode = 'inline';
    await runMigration({ vaultPath: tmpDir, plan: first.plan, inventory: first.inventory, api: first.api, state: first.state, dryRun: false });
    const hostId = first.state.getNote('Host.md')!.pageId!;

    await fs.writeFile(path.join(tmpDir, 'B.md'), '# B\n\n埋め込み先を編集\n');
    const second = await setupMigration(tmpDir, mock.fetchImpl);
    second.plan.embedMode = 'inline';
    await runMigration({ vaultPath: tmpDir, plan: second.plan, inventory: second.inventory, api: second.api, state: second.state, dryRun: false });
    const replace = mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${hostId}/markdown` && (c.body as { type?: string }).type === 'replace_content');
    expect(JSON.stringify(replace?.body)).toContain('埋め込み先を編集');
  });
});

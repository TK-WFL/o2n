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

describe('icon / cover にできるのはスキャナーが見つけた画像だけ（#248）', () => {
  let outside: string;
  beforeEach(async () => {
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-outside-')));
    await fs.writeFile(path.join(outside, 'secret.png'), 'outside-the-vault');
  });
  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  const migrate = async () => {
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });
    const uploads = mock.calls.filter((c) => c.method === 'POST' && c.path === '/file_uploads');
    const decorated = (name: string) =>
      mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${state.getNote(name)!.pageId}`)?.body as { icon?: unknown; cover?: unknown } | undefined;
    const created = (heading: string) =>
      String((mock.calls.find((c) => c.method === 'POST' && c.path === '/pages' && String((c.body as { markdown?: string }).markdown).includes(`# ${heading}`))!.body as { markdown: string }).markdown);
    return { mock, state, report, uploads, decorated, created };
  };

  it.skipIf(process.platform === 'win32')('vault の外を指すシンボリックリンク（ファイル・フォルダ）はアップロードしない', async () => {
    await fs.symlink(path.join(outside, 'secret.png'), path.join(tmpDir, 'link.png'));
    await fs.symlink(outside, path.join(tmpDir, 'linked-dir'));
    await fs.writeFile(path.join(tmpDir, 'S1.md'), '---\ncover: link.png\n---\n# S1\n');
    await fs.writeFile(path.join(tmpDir, 'S2.md'), '---\nicon: linked-dir/secret.png\n---\n# S2\n');
    await fs.writeFile(path.join(tmpDir, 'S3.md'), '---\nbanner: "![[link.png]]"\n---\n# S3\n');
    const { uploads, decorated, created } = await migrate();

    expect(uploads).toHaveLength(0);
    for (const name of ['S1.md', 'S2.md', 'S3.md']) expect(decorated(name)).toBeUndefined();
    // 反映しなかった値はメタ callout に残る
    expect(created('S1')).toContain('cover: link.png');
    expect(created('S2')).toContain('icon: linked-dir/secret.png');
  });

  it('隠しフォルダの中のファイルと、画像以外のファイルはアップロードしない', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'));
    await fs.writeFile(path.join(tmpDir, '.git', 'pic.png'), Buffer.from([1]));
    await fs.mkdir(path.join(tmpDir, '.obsidian'));
    await fs.writeFile(path.join(tmpDir, '.obsidian', 'workspace.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'memo.txt'), 'plain text');
    await fs.writeFile(path.join(tmpDir, 'H1.md'), '---\ncover: .git/pic.png\n---\n# H1\n');
    await fs.writeFile(path.join(tmpDir, 'H2.md'), '---\nicon: .obsidian/workspace.json\n---\n# H2\n');
    await fs.writeFile(path.join(tmpDir, 'H3.md'), '---\ncover: memo.txt\n---\n# H3\n');
    await fs.writeFile(path.join(tmpDir, 'H4.md'), '---\ncover: ../outside.png\n---\n# H4\n');
    const { uploads, decorated } = await migrate();

    expect(uploads).toHaveLength(0);
    for (const name of ['H1.md', 'H2.md', 'H3.md', 'H4.md']) expect(decorated(name)).toBeUndefined();
  });

  it('vault 内の画像は、ファイル名・ルートからのパス・ノートからの相対パスのどれでも使える', async () => {
    await fs.mkdir(path.join(tmpDir, 'img'));
    await fs.mkdir(path.join(tmpDir, 'notes', 'assets'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'img', 'root.png'), Buffer.from([1]));
    await fs.writeFile(path.join(tmpDir, 'notes', 'assets', 'near.jpg'), Buffer.from([2]));
    await fs.writeFile(path.join(tmpDir, 'P1.md'), '---\ncover: root.png\n---\n# P1\n');
    await fs.writeFile(path.join(tmpDir, 'P2.md'), '---\ncover: /img/root.png\n---\n# P2\n');
    await fs.writeFile(path.join(tmpDir, 'notes', 'P3.md'), '---\nicon: ./assets/near.jpg\n---\n# P3\n');
    const { uploads, decorated } = await migrate();

    expect(uploads.map((c) => (c.body as { filename: string }).filename).sort()).toEqual(['near.jpg', 'root.png', 'root.png']);
    expect(decorated('P1.md')).toMatchObject({ cover: { type: 'file_upload' } });
    expect(decorated('P2.md')).toMatchObject({ cover: { type: 'file_upload' } });
    expect(decorated('notes/P3.md')).toMatchObject({ icon: { type: 'file_upload' } });
  });

  it.skipIf(process.platform === 'win32')('スキャン後にシンボリックリンクへ置き換えられた添付は送らず、警告を残す', async () => {
    await fs.writeFile(path.join(tmpDir, 'pic.png'), Buffer.from([1]));
    await fs.writeFile(path.join(tmpDir, 'T1.md'), '# T1\n\n![[pic.png]]\n');
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(tmpDir, mock.fetchImpl);
    await fs.rm(path.join(tmpDir, 'pic.png'));
    await fs.symlink(path.join(outside, 'secret.png'), path.join(tmpDir, 'pic.png'));
    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/file_uploads')).toHaveLength(0);
    expect(state.getFile('pic.png')).toMatchObject({ status: 'failed' });
    expect(report.some((e) => e.category === 'warning' && e.path === 'pic.png' && e.message.includes('シンボリックリンク'))).toBe(true);
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

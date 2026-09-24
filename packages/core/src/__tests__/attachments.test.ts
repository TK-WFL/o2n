import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extensionOf, isFileExtension, mimeTypeFor } from '../attachments.js';
import { convertNote, type ConverterContext } from '../converter.js';
import { attachmentBlockType } from '../notion-blocks.js';
import { scanVault } from '../scanner.js';
import { runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

describe('添付の種別判定（#145）', () => {
  it('拡張子・MIME・ブロック種別', () => {
    expect(extensionOf('a/b/Report.DOCX')).toBe('docx');
    expect(extensionOf('noext')).toBe('');
    expect(isFileExtension('docx')).toBe(true);
    for (const e of ['md', 'canvas', 'base', '']) expect(isFileExtension(e)).toBe(false);
    expect(mimeTypeFor('a.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeTypeFor('a.unknownext')).toBe('application/octet-stream');
    expect(attachmentBlockType('avif')).toBe('image');
    expect(attachmentBlockType('ogv')).toBe('video');
    expect(attachmentBlockType('docx')).toBe('file');
  });
});

describe('converter: 任意ファイルの添付と未解決添付の扱い（#145）', () => {
  const ctx = (files: string[]): ConverterContext => ({
    sourcePath: 'Notes/A.md',
    resolveNoteLink: () => null,
    resolveAttachment: (t) => files.find((f) => f === t || f.endsWith(`/${t}`) || f === t.split('/').pop()) ?? null,
  });

  it('実在する docx は埋め込み・リンクとも添付になる', () => {
    const r = convertNote('![[資料.docx]] と [[表.xlsx]] と [md](files/報告.pptx)', ctx(['資料.docx', '表.xlsx', 'Notes/files/報告.pptx']));
    // 埋め込みは placeholder のみ、リンクは文中の表示を残す
    expect(r.markdown).toBe('⟦o2n-file-0⟧ と 表.xlsx⟦o2n-file-1⟧ と md⟦o2n-file-2⟧');
    expect(r.pendingFiles.map((f) => f.targetPath)).toEqual(['資料.docx', '表.xlsx', 'Notes/files/報告.pptx']);
  });

  it('見つからない画像埋め込みは元の表記のまま残し（プレースホルダーを残さない）、警告する', () => {
    const r = convertNote('![[無い.png]] と ![a](無い.jpg)', ctx([]));
    expect(r.markdown).toBe('![[無い.png]] と ![a](無い.jpg)');
    expect(r.pendingFiles).toHaveLength(0);
    expect(r.entries.filter((e) => e.category === 'warning')).toHaveLength(2);
  });

  it('見つからない docx へのリンクは従来通りノートリンク扱い（未解決として報告）', () => {
    const r = convertNote('[[無い.docx]]', ctx([]));
    expect(r.pendingLinks).toHaveLength(1);
    expect(r.entries.some((e) => e.category === 'unresolved_link')).toBe(true);
  });
});

describe('scanner / migrator: Markdown 形式でだけ参照された添付（#157）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-mdatt-')));
    await fs.mkdir(path.join(dir, 'Notes', 'img'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Notes', 'img', 'pic.png'), Buffer.from([0x89, 0x50]));
    await fs.writeFile(path.join(dir, 'doc.pdf'), Buffer.from('%PDF'));
    await fs.writeFile(path.join(dir, '資料.docx'), Buffer.from('PK'));
    await fs.writeFile(path.join(dir, 'Notes', 'A.md'), '# A\n\n![a](img/pic.png)\n\n[資料](../doc.pdf)\n\n![[資料.docx]]\n\n[[無い.docx]]\n');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scan は Markdown 形式の参照も添付に数え、vault 内の全ファイルを files に持つ', async () => {
    const inv = await scanVault(dir);
    expect(inv.attachments.map((a) => a.targetPath).sort()).toEqual(['Notes/img/pic.png', 'doc.pdf', '資料.docx'].sort());
    expect(inv.files?.sort()).toEqual(['Notes/img/pic.png', 'doc.pdf', '資料.docx'].sort());
    expect(inv.wikiLinks.map((l) => l.target)).toEqual(['無い.docx']);
  });

  it('移行で 3 つともアップロード・貼り付けされる', async () => {
    const mock = createMockServer();
    const { inventory, plan, api, state } = await setupMigration(dir, mock.fetchImpl);
    const report = await runMigration({ vaultPath: dir, plan, inventory, api, state, dryRun: false });
    const uploads = mock.calls.filter((c) => c.method === 'POST' && c.path === '/file_uploads').map((c) => (c.body as { filename: string; content_type: string }));
    expect(uploads.map((u) => u.filename).sort()).toEqual(['doc.pdf', 'pic.png', '資料.docx'].sort());
    expect(uploads.find((u) => u.filename === '資料.docx')?.content_type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    for (const f of ['Notes/img/pic.png', 'doc.pdf', '資料.docx']) expect(state.getFile(f)?.status).toBe('attached');
    expect(report.some((e) => e.message.includes('見つかりませんでした') && !e.message.includes('無い.docx'))).toBe(false);
  });
});

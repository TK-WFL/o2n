import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { buildAliasIndex, buildNameIndex, resolveNoteLink, scanVault } from '../scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(__dirname, '../../../../fixtures/test-vault');

describe('scanVault (fixtures/test-vault)', () => {
  it('.obsidian/ と .trash/ を除外する', async () => {
    const inv = await scanVault(VAULT);
    expect(inv.notes.some((n) => n.path.includes('.obsidian'))).toBe(false);
    expect(inv.notes.some((n) => n.path.includes('.trash'))).toBe(false);
  });

  it('.md ファイルを再帰的に列挙する', async () => {
    const inv = await scanVault(VAULT);
    const paths = inv.notes.map((n) => n.path);
    expect(paths).toContain('Note A.md');
    expect(paths).toContain('Folder1/Note B.md');
    expect(paths).toContain('日本語フォルダ/日本語ノート.md');
    expect(paths.some((p) => p.includes('絵文字'))).toBe(true);
  });

  it('.canvas をスキップリストに記録する', async () => {
    const inv = await scanVault(VAULT);
    expect(inv.skipped.some((s) => s.path.endsWith('.canvas'))).toBe(true);
  });

  it('frontmatterを解析する', async () => {
    const inv = await scanVault(VAULT);
    const note = inv.notes.find((n) => n.path === 'FrontmatterAllTypes.md');
    expect(note?.frontmatter.count).toBe(42);
    expect(note?.frontmatter.active).toBe(true);
    expect(Array.isArray(note?.frontmatter.tags)).toBe(true);
    expect((note?.frontmatter.longtext as string).length).toBeGreaterThan(2000);
  });

  it('wikilinkを抽出する', async () => {
    const inv = await scanVault(VAULT);
    const fromNoteA = inv.wikiLinks.filter((l) => l.sourcePath === 'Note A.md');
    expect(fromNoteA.some((l) => l.target === 'Note B' && !l.alias)).toBe(true);
    expect(fromNoteA.some((l) => l.alias === '表示名')).toBe(true);
    expect(fromNoteA.some((l) => l.heading === '見出し1')).toBe(true);
    expect(fromNoteA.some((l) => l.blockId === 'blockid1')).toBe(true);
  });

  it('添付ファイルの埋め込みを列挙する', async () => {
    const inv = await scanVault(VAULT);
    const attachments = inv.attachments.filter((a) => a.sourcePath === 'Note A.md');
    expect(attachments.some((a) => a.targetPath === 'Attachments/image.png')).toBe(true);
    expect(attachments.some((a) => a.targetPath === 'Attachments/document.pdf')).toBe(true);
  });

  it('同名ノートが複数ある場合はパス近接で解決し、Folder2内から見ればFolder2側を優先する', async () => {
    const inv = await scanVault(VAULT);
    // Folder1/Note B.md 内の [[Same Name]] は Folder1/Same Name.md に一意に解決できるはず
    expect(inv.warnings.some((w) => w.linkText === 'Same Name' && w.reason === 'ambiguous')).toBe(false);
  });

  it('フォルダツリーを構築する', async () => {
    const inv = await scanVault(VAULT);
    expect(inv.folderTree['Folder1']).toContain('Folder1/Note B.md');
  });
});

describe('scanVault symlinkガード（セキュリティ）', () => {
  it('vault内のsymlinkは辿らず、vault外のファイルが結果に含まれない', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-outside-'));
    const secretFile = path.join(outsideDir, 'secret.md');
    await fs.writeFile(secretFile, '# 機密情報\nvault外のファイル');

    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-symlink-vault-'));
    await fs.mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(vaultDir, 'Normal.md'), '# 通常ノート');
    await fs.symlink(outsideDir, path.join(vaultDir, 'evil-link'), 'dir');
    await fs.symlink(secretFile, path.join(vaultDir, 'evil-file.md'), 'file');

    try {
      const inv = await scanVault(vaultDir);
      const paths = inv.notes.map((n) => n.path);
      expect(paths).toContain('Normal.md');
      expect(paths.some((p) => p.includes('evil'))).toBe(false);
      expect(paths.some((p) => p.includes('secret'))).toBe(false);
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('scanVault frontmatterガード（セキュリティ）', () => {
  it.each(['js', 'javascript', 'JSON', 'toml'])('非YAML frontmatter (%s) を解析前に拒否する', async (language) => {
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-frontmatter-vault-'));
    const marker = '__o2n_frontmatter_eval_marker__';
    let executed = false;
    (globalThis as Record<string, unknown>)[marker] = () => {
      executed = true;
      return { pwned: true };
    };

    try {
      await fs.writeFile(
        path.join(vaultDir, 'Evil.md'),
        `---${language}\n${marker}()\n---\n本文`,
      );

      const inv = await scanVault(vaultDir);
      expect(executed).toBe(false);
      expect(inv.notes).toEqual([]);
      expect(inv.skipped).toEqual([{ path: 'Evil.md', reason: expect.stringContaining('YAML 以外') }]);
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  });

  it.each(['', 'yaml', 'yml'])('YAML frontmatter (%s) は引き続き解析する', async (language) => {
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-yaml-frontmatter-vault-'));
    const opener = language ? `---${language}` : '---';

    try {
      await fs.writeFile(path.join(vaultDir, 'Safe.md'), `${opener}\ntitle: Safe\ncount: 3\n---\n本文`);
      const inv = await scanVault(vaultDir);
      expect(inv.notes[0]?.frontmatter).toMatchObject({ title: 'Safe', count: 3 });
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  });

  it('frontmatterなしのノートは解析できる', async () => {
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-no-frontmatter-vault-'));

    try {
      await fs.writeFile(path.join(vaultDir, 'Plain.md'), '# Plain\n本文');
      const inv = await scanVault(vaultDir);
      expect(inv.notes[0]?.frontmatter).toEqual({});
      expect(inv.notes[0]?.content).toContain('# Plain');
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  });
});

describe('wikilink抽出のReDoS耐性（セキュリティ回帰テスト）', () => {
  it(']]で閉じない[の大量反復を含むノートでも短時間でscanを終える', async () => {
    // scanner.ts の WIKILINK_RE は converter.ts と同じ正規表現の複製で、
    // converter側だけを修正した際にこちらが取り残され、scanが1ノートで20秒以上
    // かかっていた（CodeQLはこの複製を検出していなかった）。
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-redos-scan-'));
    await fs.mkdir(path.join(dir, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attack.md'), '[[' + '[["'.repeat(50_000));
    try {
      const started = Date.now();
      await scanVault(dir);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('frontmatter aliases によるリンク解決（#77）', () => {
  const notes = [
    { path: 'Projects/Alpha.md', frontmatter: { aliases: ['α計画', 'Alpha Project'] } },
    { path: 'Beta.md', frontmatter: { aliases: 'ベータ' } },
    { path: 'Old.md', frontmatter: { alias: '旧形式' } },
    { path: 'Docs/Gamma.md', frontmatter: { aliases: ['共通'] } },
    { path: 'Sub/Delta.md', frontmatter: { aliases: ['共通', 42, null, ''] } },
    { path: 'Alpha Project.md', frontmatter: {} },
  ];
  const nameIndex = buildNameIndex(notes.map((n) => n.path));
  const aliasIndex = buildAliasIndex(notes);

  it('配列・文字列・旧形式 alias・数値を索引化し、空文字/null は無視する', () => {
    expect(aliasIndex.get('α計画')).toEqual(['Projects/Alpha.md']);
    expect(aliasIndex.get('ベータ')).toEqual(['Beta.md']);
    expect(aliasIndex.get('旧形式')).toEqual(['Old.md']);
    expect(aliasIndex.get('42')).toEqual(['Sub/Delta.md']);
    expect(aliasIndex.has('')).toBe(false);
  });

  it('[[別名]] が aliases を持つノートに解決される', () => {
    expect(resolveNoteLink('α計画', 'Home.md', nameIndex, aliasIndex).resolved).toBe('Projects/Alpha.md');
    expect(resolveNoteLink('ベータ', 'Home.md', nameIndex, aliasIndex).resolved).toBe('Beta.md');
  });

  it('ファイル名一致が alias 一致より優先される', () => {
    // "Alpha Project" はファイル名としても Alpha.md の alias としても存在する
    expect(resolveNoteLink('Alpha Project', 'Home.md', nameIndex, aliasIndex).resolved).toBe('Alpha Project.md');
  });

  it('alias が複数ノートで衝突する場合はパス近接で選び、なお曖昧なら警告する', () => {
    const near = resolveNoteLink('共通', 'Sub/Other.md', nameIndex, aliasIndex);
    expect(near.resolved).toBe('Sub/Delta.md');
    expect(near.warning).toBeUndefined();
    const far = resolveNoteLink('共通', 'X/Y.md', nameIndex, aliasIndex);
    expect(far.warning?.reason).toBe('ambiguous');
  });

  it('どちらにも無ければ not_found', () => {
    const r = resolveNoteLink('存在しない', 'Home.md', nameIndex, aliasIndex);
    expect(r.resolved).toBeNull();
    expect(r.warning?.reason).toBe('not_found');
  });
});

describe('Bases / Excalidraw の扱い（#78）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-scan-base-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('.base は skipped に理由付きで記録され、ノートにも添付にも含まれない', async () => {
    await fs.writeFile(path.join(dir, 'Tasks.base'), 'views:\n  - type: table\n');
    await fs.writeFile(path.join(dir, 'Note.md'), '# n\n');
    const inv = await scanVault(dir);
    expect(inv.skipped).toEqual([{ path: 'Tasks.base', reason: expect.stringContaining('Bases') }]);
    expect(inv.notes.map((n) => n.path)).toEqual(['Note.md']);
  });

  it('Excalidraw ノートは同名の .png があればその埋め込みに置き換えられ、excalidraw 印が付く', async () => {
    await fs.writeFile(
      path.join(dir, 'Drawing.excalidraw.md'),
      '---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n==⚠  Switch to EXCALIDRAW VIEW==\n\n```json\n{"type":"excalidraw"}\n```\n',
    );
    await fs.writeFile(path.join(dir, 'Drawing.excalidraw.png'), Buffer.from([0x89, 0x50]));
    const inv = await scanVault(dir);
    const note = inv.notes.find((n) => n.path === 'Drawing.excalidraw.md');
    expect(note?.content).toBe('![[Drawing.excalidraw.png]]\n');
    expect(note?.excalidraw).toEqual({ exportedImage: 'Drawing.excalidraw.png' });
    expect(inv.attachments.some((a) => a.sourcePath === 'Drawing.excalidraw.md' && a.targetPath === 'Drawing.excalidraw.png')).toBe(true);
    expect(inv.skipped).toEqual([]);
  });

  it('Excalidraw ノートは .svg でも可、png を優先する', async () => {
    await fs.writeFile(path.join(dir, 'D.excalidraw.md'), '---\nexcalidraw-plugin: raw\n---\n```json\n{}\n```\n');
    await fs.writeFile(path.join(dir, 'D.excalidraw.svg'), '<svg/>');
    let inv = await scanVault(dir);
    expect(inv.notes[0]?.excalidraw?.exportedImage).toBe('D.excalidraw.svg');
    await fs.writeFile(path.join(dir, 'D.excalidraw.png'), Buffer.from([0x89]));
    inv = await scanVault(dir);
    expect(inv.notes[0]?.excalidraw?.exportedImage).toBe('D.excalidraw.png');
  });

  it('書き出し画像が無い Excalidraw ノートは skipped になりノートに含まれない', async () => {
    await fs.writeFile(path.join(dir, 'Lonely.excalidraw.md'), '---\nexcalidraw-plugin: parsed\n---\n```json\n{}\n```\n');
    const inv = await scanVault(dir);
    expect(inv.notes).toEqual([]);
    expect(inv.skipped).toEqual([{ path: 'Lonely.excalidraw.md', reason: expect.stringContaining('Excalidraw') }]);
  });

  it('.canvas の理由文は従来通り', async () => {
    await fs.writeFile(path.join(dir, 'Map.canvas'), '{}');
    const inv = await scanVault(dir);
    expect(inv.skipped[0]?.reason).toContain('.canvas');
  });
});

describe('wikilink 解析の複数パイプ（#103）', () => {
  it('![[img.png|alt|300]] は添付として数えられる', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-scan-pipe-'));
    try {
      await fs.writeFile(path.join(dir, 'A.md'), '![[pic.png|alt|300]]\n| [[B\\|x]] |\n');
      await fs.writeFile(path.join(dir, 'B.md'), 'b');
      await fs.writeFile(path.join(dir, 'pic.png'), Buffer.from([1]));
      const inv = await scanVault(dir);
      expect(inv.attachments.map((a) => a.targetPath)).toEqual(['pic.png']);
      expect(inv.wikiLinks[0]).toMatchObject({ target: 'B', alias: 'x' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('スキャンの堅牢化と大文字小文字非依存の解決（#107, #108）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-scan-robust-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('.git / node_modules / 隠しディレクトリ内の .md は走査しない', async () => {
    for (const d of ['.git', 'node_modules/pkg', '.hidden', 'Docs']) await fs.mkdir(path.join(dir, d), { recursive: true });
    for (const f of ['.git/README.md', 'node_modules/pkg/README.md', '.hidden/x.md', 'Docs/ok.md']) await fs.writeFile(path.join(dir, f), '# x');
    const inv = await scanVault(dir);
    expect(inv.notes.map((n) => n.path)).toEqual(['Docs/ok.md']);
  });

  it('[[note]] は大文字小文字が違っても解決され、完全一致があればそちらを優先する', async () => {
    await fs.writeFile(path.join(dir, 'Note.md'), 'x');
    await fs.writeFile(path.join(dir, 'A.md'), '[[note]] [[NOTE.md]]');
    const inv = await scanVault(dir);
    const idx = buildNameIndex(inv.notes.map((n) => n.path));
    expect(resolveNoteLink('note', 'A.md', idx, new Map()).resolved).toBe('Note.md');
    expect(resolveNoteLink('NOTE.md', 'A.md', idx, new Map()).resolved).toBe('Note.md');
    const idx2 = buildNameIndex(['Note.md', 'note.md']);
    expect(resolveNoteLink('note', 'A.md', idx2, new Map()).resolved).toBe('note.md');
    expect(resolveNoteLink('Note', 'A.md', idx2, new Map()).resolved).toBe('Note.md');
  });

  it('alias も大文字小文字非依存', () => {
    const aliases = buildAliasIndex([{ path: 'P.md', frontmatter: { aliases: ['Project Alpha'] } }]);
    expect(resolveNoteLink('project alpha', 'A.md', new Map(), aliases).resolved).toBe('P.md');
  });

  it('同名ノートが同じ距離に複数ある曖昧なリンクは scan 時に ambiguous 警告として1件だけ報告される', async () => {
    await fs.mkdir(path.join(dir, 'X'), { recursive: true });
    await fs.mkdir(path.join(dir, 'Y'), { recursive: true });
    await fs.writeFile(path.join(dir, 'X', 'Same.md'), 'x');
    await fs.writeFile(path.join(dir, 'Y', 'Same.md'), 'y');
    await fs.writeFile(path.join(dir, 'Root.md'), '[[Same]] and again [[Same]]');
    const inv = await scanVault(dir);
    const amb = inv.warnings.filter((w) => w.reason === 'ambiguous');
    expect(amb).toHaveLength(1);
    expect(amb[0]).toMatchObject({ sourcePath: 'Root.md', linkText: 'Same' });
    expect(amb[0]?.candidates?.sort()).toEqual(['X/Same.md', 'Y/Same.md']);
  });
});

describe('ノートの並び順（#112）', () => {
  it('同じフォルダ内はファイル名の自然順、フォルダは後ろ、readdir の順序に依存しない', async () => {
    const { compareVaultPaths } = await import('../scanner.js');
    const input = ['Sub/x.md', 'b.md', 'A.md', 'note10.md', 'note2.md', 'Sub/a.md', 'Zed/1.md'];
    expect([...input].sort(compareVaultPaths)).toEqual(['A.md', 'b.md', 'note2.md', 'note10.md', 'Sub/a.md', 'Sub/x.md', 'Zed/1.md']);
  });
});

describe('中間フォルダ（#135）', () => {
  it('直下にノートが無い祖先フォルダも folderTree に空配列で登録される', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-scan-mid-'));
    try {
      await fs.mkdir(path.join(dir, 'A', 'B', 'C'), { recursive: true });
      await fs.mkdir(path.join(dir, 'P', 'X'), { recursive: true });
      await fs.writeFile(path.join(dir, 'A', 'B', 'C', 'n.md'), 'x');
      await fs.writeFile(path.join(dir, 'P', 'X', 'm.md'), 'y');
      const inv = await scanVault(dir);
      expect(Object.keys(inv.folderTree).sort()).toEqual(['', 'A', 'A/B', 'A/B/C', 'P', 'P/X']);
      expect(inv.folderTree['A']).toEqual([]);
      expect(inv.folderTree['A/B/C']).toEqual(['A/B/C/n.md']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

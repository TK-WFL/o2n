import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { buildAliasIndex, buildNameIndex, resolveNoteLink, scanVault, UnsupportedFrontmatterLanguageError } from '../scanner.js';

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

      await expect(scanVault(vaultDir)).rejects.toBeInstanceOf(UnsupportedFrontmatterLanguageError);
      expect(executed).toBe(false);
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

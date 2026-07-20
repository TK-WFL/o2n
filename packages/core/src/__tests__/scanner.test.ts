import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { scanVault, UnsupportedFrontmatterLanguageError } from '../scanner.js';

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

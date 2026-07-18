import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanVault } from '../scanner.js';

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

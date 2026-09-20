import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from '@11ty/gray-matter';
import type {
  AttachmentRef,
  NoteRecord,
  NoteResolutionWarning,
  SkippedFile,
  VaultInventory,
  WikiLink,
} from './types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '.trash', '.o2n']);

const ATTACHMENT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp',
  'pdf',
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
  'mp4', 'mov', 'webm', 'mkv',
]);

/** 変換対象外の Obsidian 固有ファイル形式と、レポートに出す理由 */
const NON_CONVERTIBLE_EXTENSIONS: Record<string, string> = {
  canvas: '非対応ファイル形式 (.canvas) はv1では変換されません',
  base: 'Obsidian Bases (.base) は変換されません（ビューの定義ファイルで、Notionのデータベースビューへの対応付けは非対象）',
};
/** Excalidraw の書き出し画像として探す拡張子（優先順） */
const EXCALIDRAW_EXPORT_EXTENSIONS = ['png', 'svg'];
const ALLOWED_FRONTMATTER_LANGUAGES = new Set(['', 'yaml', 'yml']);

export class UnsupportedFrontmatterLanguageError extends Error {
  constructor(notePath: string, language: string) {
    super(
      `Unsupported frontmatter language "${language}" in ${notePath}. ` +
        'Only YAML frontmatter is supported.',
    );
    this.name = 'UnsupportedFrontmatterLanguageError';
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function frontmatterLanguage(raw: string): string | null {
  if (!raw.startsWith('---')) return null;
  if (raw.charAt(3) === '-') return null;

  const body = raw.slice(3);
  const newlineIndex = body.search(/\r?\n/);
  if (newlineIndex === -1) return '';
  return body.slice(0, newlineIndex).trim().toLowerCase();
}

function parseNoteMatter(raw: string, notePath: string): ReturnType<typeof matter> {
  const language = frontmatterLanguage(raw);
  if (language !== null && !ALLOWED_FRONTMATTER_LANGUAGES.has(language)) {
    throw new UnsupportedFrontmatterLanguageError(notePath, language);
  }
  return matter(raw);
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // セキュリティ対策（外部レビュー指摘対応）: シンボリックリンクは辿らない。
    // vault内に悪意あるsymlinkが置かれていた場合に、vault外のファイル
    // （~/.ssh等）を読み取ってNotionに送信してしまうことを防ぐ。
    // fs.readdirのDirentはリンク先を辿らないため isDirectory()/isFile() は
    // symlinkに対して通常falseを返すが、意図を明確にするため明示的に判定する。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), root, out);
    } else if (entry.isFile()) {
      out.push(toPosix(path.relative(root, path.join(dir, entry.name))));
    }
  }
}

// ReDoS対策: converter.ts の同名定数と同じ理由で各文字クラスから `[` を除外している
// （除外前は `]]` で閉じない `[` の大量反復で二次オーダーのバックトラックが起き、
// scanコマンドが1ノートあたり20秒以上かかっていた）。
// Obsidianはファイル名に `[` `]` を使えないため、正当なwikilinkの解釈は変わらない。
const WIKILINK_RE = /(!?)\[\[([^[\]|#]+)(?:#(\^?[^[\]|]+))?(?:\|([^[\]|]+))?\]\]/g;

interface ParsedWikiLink {
  isEmbed: boolean;
  target: string;
  heading?: string;
  blockId?: string;
  alias?: string;
  raw: string;
}

function parseWikiLinks(content: string): ParsedWikiLink[] {
  const results: ParsedWikiLink[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    const [raw, bang, targetRaw, anchor, alias] = m;
    const isEmbed = bang === '!';
    const target = (targetRaw ?? '').trim();
    let heading: string | undefined;
    let blockId: string | undefined;
    if (anchor) {
      if (anchor.startsWith('^')) {
        blockId = anchor.slice(1).trim();
      } else {
        heading = anchor.trim();
      }
    }
    results.push({
      isEmbed,
      target,
      heading,
      blockId,
      alias: alias?.trim(),
      raw,
    });
  }
  return results;
}

function dirSegments(relPath: string): string[] {
  const dir = path.posix.dirname(relPath);
  return dir === '.' ? [] : dir.split('/');
}

function pathDistance(a: string, b: string): number {
  const aDirs = dirSegments(a);
  const bDirs = dirSegments(b);
  let common = 0;
  while (common < aDirs.length && common < bDirs.length && aDirs[common] === bDirs[common]) {
    common += 1;
  }
  return (aDirs.length - common) + (bDirs.length - common);
}

/**
 * ファイル名（basename、拡張子有無どちらでも）→ 候補パス一覧のインデックスを作る
 */
export function buildNameIndex(paths: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const p of paths) {
    const base = path.posix.basename(p);
    const baseNoExt = base.replace(/\.[^.]+$/, '');
    for (const key of [base, baseNoExt]) {
      const list = index.get(key) ?? [];
      list.push(p);
      index.set(key, list);
    }
  }
  return index;
}

/**
 * frontmatter の `aliases`（文字列または文字列配列。Obsidian 旧形式の `alias` も可）→ ノートパス一覧の
 * インデックスを作る。Obsidian は `[[別名]]` を aliases に一致するノートへ解決するため（#77）。
 */
export function buildAliasIndex(notes: Array<Pick<NoteRecord, 'path' | 'frontmatter'>>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const note of notes) {
    const raw = note.frontmatter.aliases ?? note.frontmatter.alias;
    const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    for (const v of values) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const key = String(v).trim();
      if (!key) continue;
      const list = index.get(key) ?? [];
      if (!list.includes(note.path)) list.push(note.path);
      index.set(key, list);
    }
  }
  return index;
}

/**
 * ノートリンクの解決: ファイル名一致を優先し、見つからなければ aliases で探す。
 * どちらも曖昧さの扱いは resolveByFilename と同じ（パス近接→警告）。
 */
export function resolveNoteLink(
  target: string,
  sourcePath: string,
  nameIndex: Map<string, string[]>,
  aliasIndex: Map<string, string[]>,
): { resolved: string | null; warning?: NoteResolutionWarning } {
  const byName = resolveByFilename(target, sourcePath, nameIndex);
  if (byName.resolved !== null) return byName;
  if (!aliasIndex.has(target.trim())) return byName;
  return resolveByFilename(target.trim(), sourcePath, aliasIndex);
}

/**
 * Obsidianの挙動に合わせたノート名解決: ファイル名一致→曖昧ならパス近接→なお曖昧なら警告
 */
export function resolveByFilename(
  target: string,
  sourcePath: string,
  nameIndex: Map<string, string[]>,
): { resolved: string | null; warning?: NoteResolutionWarning } {
  const key = path.posix.basename(target);
  const candidates = [...new Set(nameIndex.get(key) ?? [])];
  if (candidates.length === 0) {
    return {
      resolved: null,
      warning: { sourcePath, linkText: target, reason: 'not_found' },
    };
  }
  if (candidates.length === 1) {
    return { resolved: candidates[0] ?? null };
  }
  // 複数候補: パス近接（ディレクトリ距離が最小、かつ一意）を優先
  let best: string[] = [];
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = pathDistance(sourcePath, c);
    if (d < bestDistance) {
      bestDistance = d;
      best = [c];
    } else if (d === bestDistance) {
      best.push(c);
    }
  }
  if (best.length === 1) {
    return { resolved: best[0] ?? null };
  }
  return {
    resolved: best[0] ?? null,
    warning: {
      sourcePath,
      linkText: target,
      reason: 'ambiguous',
      candidates: best,
    },
  };
}

export async function scanVault(vaultPath: string): Promise<VaultInventory> {
  const allFiles: string[] = [];
  await walk(vaultPath, vaultPath, allFiles);

  const mdPaths = allFiles.filter((p) => p.endsWith('.md'));
  const nameIndex = buildNameIndex(mdPaths);
  // 添付の名前索引はvault全体で一度だけ作る（以前はリンクごとに再構築していて大規模vaultで O(リンク数×ファイル数) だった）
  const attachmentIndex = buildNameIndex(allFiles.filter((p) => !p.endsWith('.md')));

  const notes: NoteRecord[] = [];
  const wikiLinks: WikiLink[] = [];
  const attachments: AttachmentRef[] = [];
  const warnings: NoteResolutionWarning[] = [];
  const skipped: SkippedFile[] = [];
  const folderTree: Record<string, string[]> = {};
  const frontmatterKeyStats: Record<string, number> = {};

  const allFileSet = new Set(allFiles);
  for (const relPath of allFiles) {
    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    const reason = NON_CONVERTIBLE_EXTENSIONS[ext];
    if (reason) skipped.push({ path: relPath, reason });
  }

  for (const relPath of mdPaths) {
    const absPath = path.join(vaultPath, relPath);
    const raw = await fs.readFile(absPath, 'utf-8');
    const stat = await fs.stat(absPath);
    const parsed = parseNoteMatter(raw, relPath);
    const frontmatter = parsed.data ?? {};

    let content = parsed.content;
    let excalidraw: NoteRecord['excalidraw'];
    if (frontmatter['excalidraw-plugin'] !== undefined) {
      // Excalidraw の図面ノート。本文は図面 JSON（コードブロック）で Notion では意味を成さない。
      // プラグインが同名で書き出す画像（Drawing.excalidraw.png 等）があれば、それを埋め込む
      // ノートに置き換える。無ければ変換対象から外してレポートする。
      const noExt = relPath.replace(/\.md$/, '');
      const exportedImage = EXCALIDRAW_EXPORT_EXTENSIONS.map((e) => `${noExt}.${e}`).find((p) => allFileSet.has(p));
      if (!exportedImage) {
        skipped.push({
          path: relPath,
          reason: 'Excalidraw の図面ノートは変換されません（同名の .png/.svg 書き出しが見つからないため。Obsidian で「Export as PNG/SVG」して再実行すると画像として移行できます）',
        });
        continue;
      }
      content = `![[${path.posix.basename(exportedImage)}]]\n`;
      excalidraw = { exportedImage };
    }

    notes.push({
      path: relPath,
      frontmatter,
      content,
      sizeBytes: stat.size,
      ...(excalidraw ? { excalidraw } : {}),
    });

    for (const key of Object.keys(frontmatter)) {
      frontmatterKeyStats[key] = (frontmatterKeyStats[key] ?? 0) + 1;
    }

    const dir = path.posix.dirname(relPath);
    const dirKey = dir === '.' ? '' : dir;
    folderTree[dirKey] = folderTree[dirKey] ?? [];
    folderTree[dirKey].push(relPath);

    for (const link of parseWikiLinks(content)) {
      const linkExt = link.target.includes('.')
        ? link.target.split('.').pop()!.toLowerCase()
        : '';
      const isAttachment = link.isEmbed && ATTACHMENT_EXTENSIONS.has(linkExt);

      if (isAttachment) {
        const { resolved, warning } = resolveByFilename(link.target, relPath, attachmentIndex);
        if (warning) warnings.push(warning);
        attachments.push({
          sourcePath: relPath,
          targetPath: resolved,
          raw: link.raw,
          extension: linkExt,
        });
        continue;
      }

      wikiLinks.push({
        sourcePath: relPath,
        target: link.target,
        heading: link.heading,
        blockId: link.blockId,
        alias: link.alias,
        isEmbed: link.isEmbed,
        raw: link.raw,
      });
    }
  }

  return {
    vaultPath,
    notes,
    attachments,
    wikiLinks,
    skipped,
    warnings,
    folderTree,
    frontmatterKeyStats,
  };
}

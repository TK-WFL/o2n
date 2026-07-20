import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
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

const NON_CONVERTIBLE_EXTENSIONS = new Set(['canvas']);

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
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

const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#(\^?[^\]|]+))?(?:\|([^\]]+))?\]\]/g;

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

  const notes: NoteRecord[] = [];
  const wikiLinks: WikiLink[] = [];
  const attachments: AttachmentRef[] = [];
  const warnings: NoteResolutionWarning[] = [];
  const skipped: SkippedFile[] = [];
  const folderTree: Record<string, string[]> = {};
  const frontmatterKeyStats: Record<string, number> = {};

  for (const relPath of allFiles) {
    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    if (NON_CONVERTIBLE_EXTENSIONS.has(ext)) {
      skipped.push({ path: relPath, reason: `非対応ファイル形式 (.${ext}) はv1では変換されません` });
    }
  }

  for (const relPath of mdPaths) {
    const absPath = path.join(vaultPath, relPath);
    const raw = await fs.readFile(absPath, 'utf-8');
    const stat = await fs.stat(absPath);
    const parsed = matter(raw);

    notes.push({
      path: relPath,
      frontmatter: parsed.data ?? {},
      content: parsed.content,
      sizeBytes: stat.size,
    });

    for (const key of Object.keys(parsed.data ?? {})) {
      frontmatterKeyStats[key] = (frontmatterKeyStats[key] ?? 0) + 1;
    }

    const dir = path.posix.dirname(relPath);
    const dirKey = dir === '.' ? '' : dir;
    folderTree[dirKey] = folderTree[dirKey] ?? [];
    folderTree[dirKey].push(relPath);

    for (const link of parseWikiLinks(parsed.content)) {
      const linkExt = link.target.includes('.')
        ? link.target.split('.').pop()!.toLowerCase()
        : '';
      const isAttachment = link.isEmbed && ATTACHMENT_EXTENSIONS.has(linkExt);

      if (isAttachment) {
        const attachmentIndex = buildNameIndex(allFiles.filter((p) => !p.endsWith('.md')));
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

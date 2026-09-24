import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from '@11ty/gray-matter';
import { extensionOf, isFileExtension, MEDIA_EXTENSIONS } from './attachments.js';
import { MD_IMAGE_RE, MD_LINK_RE } from './converter.js';
import type {
  AttachmentRef,
  NoteRecord,
  NoteResolutionWarning,
  SkippedFile,
  VaultInventory,
  WikiLink,
} from './types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '.trash', '.o2n', 'node_modules']);
/** `.` で始まるディレクトリ（.git 等）は Obsidian も表示しないため走査しない（#108） */
const isHiddenDir = (name: string): boolean => name.startsWith('.');

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

const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** ディレクトリ階層ごとに名前順で比較する（同じフォルダ内のファイルはファイル名順、フォルダはフォルダ名順） */
export function compareVaultPaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const aLast = i === as.length - 1;
    const bLast = i === bs.length - 1;
    if (aLast !== bLast) return aLast ? -1 : 1; // 同じ階層ではファイルをフォルダより先に
    const c = pathCollator.compare(as[i]!, bs[i]!);
    if (c !== 0) return c;
  }
  return as.length - bs.length;
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
      if (EXCLUDED_DIRS.has(entry.name) || isHiddenDir(entry.name)) continue;
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
const WIKILINK_RE = /(!?)\[\[([^[\]|#]+)(?:#(\^?[^[\]|]+))?(?:\|([^[\]]*))?\]\]/g;

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
    const [raw, bang, targetRaw, anchor, aliasRaw] = m;
    const isEmbed = bang === '!';
    // converter.ts と同じ扱い: 表内の `\|` エスケープと複数パイプ（alt|幅）に対応
    const alias = aliasRaw === undefined ? undefined : (aliasRaw.split('|').map((s) => s.replace(/\\$/, '').trim()).filter((s) => !/^\d+(x\d+)?$/.test(s)).join('|') || undefined);
    const target = (targetRaw ?? '').replace(/\\$/, '').trim();
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
    addIndexKeys(index, [base, baseNoExt], p);
  }
  return index;
}

/** 大文字小文字を区別しないフォールバック用のキー接頭辞（実キーと衝突しない文字を使う） */
const CI_KEY_PREFIX = '\u0000ci:';

/**
 * 索引に実キーと、大文字小文字を畳み込んだキーの両方で登録する。解決時は実キーの完全一致を
 * 優先し、無ければ畳み込みキーで探す（macOS/Windows の Obsidian は `[[note]]` を `Note.md` に
 * 解決するため、#107）。
 */
function addIndexKeys(index: Map<string, string[]>, keys: string[], p: string): void {
  for (const key of keys) {
    for (const k of [key, CI_KEY_PREFIX + key.toLowerCase()]) {
      const list = index.get(k) ?? [];
      if (!list.includes(p)) list.push(p);
      index.set(k, list);
    }
  }
}

/** 完全一致 → 大文字小文字非依存 の順で候補を引く */
function lookupIndex(index: Map<string, string[]>, key: string): string[] {
  return index.get(key) ?? index.get(CI_KEY_PREFIX + key.toLowerCase()) ?? [];
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
      addIndexKeys(index, [key], note.path);
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
  if (lookupIndex(aliasIndex, target.trim()).length === 0) return byName;
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
  const candidates = [...new Set(lookupIndex(nameIndex, key))];
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

/** Markdown 形式の画像・リンクのうち、ローカルのファイルを指すもの: [生表記, 画像か, リンク先] */
function markdownFileRefs(content: string): Array<[string, boolean, string]> {
  const out: Array<[string, boolean, string]> = [];
  for (const m of content.matchAll(MD_IMAGE_RE)) out.push([m[0], true, m[2] ?? m[3] ?? '']);
  for (const m of content.matchAll(MD_LINK_RE)) {
    if (m.index !== undefined && m.index > 0 && content[m.index - 1] === '!') continue; // 画像は上で処理済み
    out.push([m[0], false, m[2] ?? m[3] ?? '']);
  }
  return out.filter(([, , url]) => url !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('#')).map(([r, i, u]) => [r, i, u.split('#')[0]!]);
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function scanVault(vaultPath: string): Promise<VaultInventory> {
  const allFiles: string[] = [];
  await walk(vaultPath, vaultPath, allFiles);

  // 並び順を vault の名前順（数字は数値として比較）に固定する（#112）。readdir の順序は
  // ファイルシステム依存で、Notion は作成順に子ページを並べるため、ここで決めた順が Notion 上の順になる
  allFiles.sort(compareVaultPaths);
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
    // 1ノートの読み取り失敗や非YAML frontmatter で vault 全体のスキャンを止めない（#108）。
    // 非YAML frontmatter は安全のため解析せず、そのノートだけを skipped にする
    let raw: string;
    let stat: { size: number };
    let parsed: ReturnType<typeof parseNoteMatter>;
    try {
      raw = await fs.readFile(absPath, 'utf-8');
      stat = await fs.stat(absPath);
      parsed = parseNoteMatter(raw, relPath);
    } catch (err) {
      const reason =
        err instanceof UnsupportedFrontmatterLanguageError
          ? 'frontmatter が YAML 以外の形式（js/json/toml 等）のため安全上スキップしました。YAML に直すと移行できます'
          : `読み取りに失敗したためスキップしました: ${err instanceof Error ? err.message : String(err)}`;
      skipped.push({ path: relPath, reason });
      continue;
    }
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
    // 直下にノートが無い中間フォルダ（Projects/Alpha/a.md の Projects）も登録する。
    // 登録しないと計画に現れず、Alpha がルート直下に作られて階層が平らになっていた（#135）
    if (dirKey !== '') {
      for (let parent = path.posix.dirname(dirKey); parent !== '.'; parent = path.posix.dirname(parent)) {
        folderTree[parent] = folderTree[parent] ?? [];
      }
      folderTree[''] = folderTree[''] ?? [];
    }

    for (const link of parseWikiLinks(content)) {
      const linkExt = extensionOf(link.target);
      // 添付: 画像・PDF 等の埋め込みは見つからなくても添付扱い。それ以外の拡張子（docx 等）は、
      // 埋め込み・リンクを問わず vault に実在すれば添付（#145）。見つからなければ従来通りノートリンク扱い
      if (isFileExtension(linkExt)) {
        const { resolved, warning } = resolveByFilename(link.target, relPath, attachmentIndex);
        if (resolved || (link.isEmbed && MEDIA_EXTENSIONS.has(linkExt))) {
          // 見つからない添付は converter が報告するので、ここでは曖昧さだけを報告する（二重報告を避ける）
          if (warning?.reason === 'ambiguous') warnings.push(warning);
          attachments.push({ sourcePath: relPath, targetPath: resolved, raw: link.raw, extension: linkExt });
          continue;
        }
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

    // Markdown 形式の画像・リンク（`![a](img/pic.png)`, `[資料](doc.pdf)`）も添付として数える（#157）
    for (const [raw, isImage, url] of markdownFileRefs(content)) {
      const decoded = safeDecodeUri(url);
      const ext = extensionOf(decoded);
      if (!isFileExtension(ext)) continue;
      const resolved =
        resolveByFilename(path.posix.normalize(path.posix.join(path.posix.dirname(relPath), decoded)), relPath, attachmentIndex).resolved ??
        resolveByFilename(decoded, relPath, attachmentIndex).resolved;
      if (resolved || (isImage && MEDIA_EXTENSIONS.has(ext))) {
        attachments.push({ sourcePath: relPath, targetPath: resolved, raw, extension: ext });
      }
    }
  }

  // ノートリンクの曖昧さ（同名ノートが同じ距離に複数）はここで一度だけ報告する。
  // 以前は migrator 側の解決で警告を捨てていたため、黙って先頭候補に繋がっていた（#107）
  const aliasIndex = buildAliasIndex(notes);
  const seen = new Set<string>();
  for (const link of wikiLinks) {
    const { warning } = resolveNoteLink(link.target, link.sourcePath, nameIndex, aliasIndex);
    if (!warning || warning.reason !== 'ambiguous') continue;
    const key = `${link.sourcePath}\u0000${link.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(warning);
  }

  return {
    vaultPath,
    notes,
    files: allFiles.filter((p) => !p.endsWith('.md')),
    attachments,
    wikiLinks,
    skipped,
    warnings,
    folderTree,
    frontmatterKeyStats,
  };
}

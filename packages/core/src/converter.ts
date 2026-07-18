import path from 'node:path';
import type { ConversionResult, ReportEntry } from './types.js';

/**
 * プレースホルダー形式について（仕様書§5 F4からの実装上の変更点）:
 * 仕様書は `⟦o2n:link:リンク先相対パス⟧` という単一の相対パス埋め込み形式を示すが、
 * 同一ノートへのエイリアス違いリンクや見出しリンクなど「表示名がリンクごとに異なるケース」を
 * 表現できないため、本実装では `⟦o2n:link:N⟧` / `⟦o2n:file:N⟧`（Nはノート内の出現順連番）を
 * プレースホルダーとし、実際のリンク先・表示名は ConversionResult.pendingLinks / pendingFiles に
 * 構造化データとして保持する。Pass 2 はこのNをキーに old_str/new_str を組み立てる。
 * 差分は docs/questions.md に記録済み。
 */

export interface PendingLink {
  placeholder: string;
  /** 解決済みノート相対パス（未解決の場合 null） */
  targetPath: string | null;
  /** リンク未解決時にフォールバックする表示テキスト（元の[[表記]]） */
  fallbackText: string;
  /** Pass2で解決済み時に使う表示名 */
  displayText: string;
}

export interface PendingFile {
  placeholder: string;
  targetPath: string | null;
  fallbackText: string;
}

export interface ConvertNoteResult extends ConversionResult {
  pendingLinks: PendingLink[];
  pendingFiles: PendingFile[];
  /** 元本文に⟦o2n:が含まれていたためエスケープ復元が必要か */
  needsEscapeRestore: boolean;
}

export interface ConverterContext {
  sourcePath: string;
  /** [[target]] や ![alt](path) 等の解決先ノート/添付相対パスを引く。見つからなければnull */
  resolveNoteLink: (target: string) => string | null;
  resolveAttachment: (target: string) => string | null;
}

const CALLOUT_TYPE_MAP: Record<string, { icon: string; color: string }> = {
  note: { icon: '💡', color: 'blue_bg' },
  warning: { icon: '⚠️', color: 'orange_bg' },
  tip: { icon: '💡', color: 'green_bg' },
  info: { icon: 'ℹ️', color: 'gray_bg' },
  danger: { icon: '⛔', color: 'red_bg' },
};
const DEFAULT_CALLOUT = { icon: 'ℹ️', color: 'gray_bg' };

export const ESCAPE_SENTINEL = '⟦o2n-esc:';
export const ESCAPE_TARGET = '⟦o2n:';

interface Segment {
  type: 'code' | 'text';
  content: string;
  lang?: string;
}

function splitCodeFences(content: string): Segment[] {
  const segments: Segment[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, m.index) });
    }
    segments.push({ type: 'code', content: m[0], lang: (m[1] ?? '').trim() });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return segments;
}

function convertCallouts(text: string, entries: ReportEntry[], sourcePath: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const calloutMatch = /^>\s?\[!(\w+)\]([-+]?)\s*(.*)$/.exec(line);
    if (calloutMatch) {
      const [, rawType, , titleText] = calloutMatch;
      const type = (rawType ?? '').toLowerCase();
      const style = CALLOUT_TYPE_MAP[type] ?? DEFAULT_CALLOUT;
      if (!CALLOUT_TYPE_MAP[type]) {
        entries.push({
          category: 'downgraded',
          path: sourcePath,
          message: `未知のcallout種別 "${type}" をデフォルト表示(ℹ️/gray)に変換しました`,
        });
      }
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^>\s?/.test(lines[j] ?? '')) {
        bodyLines.push((lines[j] ?? '').replace(/^>\s?/, ''));
        j += 1;
      }
      const title = (titleText ?? '').trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const body = bodyLines.join('\n').trim();
      out.push(`<callout icon="${style.icon}" color="${style.color}">**${title}**${body ? `\n${body}` : ''}</callout>`);
      i = j;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

function convertHighlights(text: string, entries: ReportEntry[], sourcePath: string): string {
  return text.replace(/==([^=\n]+)==/g, (_m, inner) => {
    entries.push({
      category: 'downgraded',
      path: sourcePath,
      message: `ハイライト "==${inner}==" を太字に降格しました`,
    });
    return `**${inner}**`;
  });
}

function stripComments(text: string, entries: ReportEntry[], sourcePath: string): string {
  let count = 0;
  const result = text.replace(/%%[\s\S]*?%%/g, () => {
    count += 1;
    return '';
  });
  if (count > 0) {
    entries.push({
      category: 'downgraded',
      path: sourcePath,
      message: `Obsidianコメントを${count}件削除しました`,
    });
  }
  return result;
}

function expandFootnotes(text: string, entries: ReportEntry[], sourcePath: string): string {
  const defRe = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
  const defs = new Map<string, string>();
  const withoutDefs = text.replace(defRe, (_m, id, body) => {
    defs.set(id, body.trim());
    return '';
  });
  if (defs.size === 0) return withoutDefs;
  const result = withoutDefs.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    const body = defs.get(id);
    if (body === undefined) return m;
    entries.push({
      category: 'downgraded',
      path: sourcePath,
      message: `脚注 [^${id}] を文中展開に降格しました`,
    });
    return ` (${body})`;
  });
  return result.replace(/\n{3,}/g, '\n\n');
}

let linkCounter = 0;
let fileCounter = 0;

function makeLinkPlaceholder(): string {
  return `⟦o2n:link:${linkCounter++}⟧`;
}
function makeFilePlaceholder(): string {
  return `⟦o2n:file:${fileCounter++}⟧`;
}

const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#(\^?[^\]|]+))?(?:\|([^\]]+))?\]\]/g;

const ATTACHMENT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp',
  'pdf',
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
  'mp4', 'mov', 'webm', 'mkv',
]);

function convertWikiLinks(
  text: string,
  ctx: ConverterContext,
  entries: ReportEntry[],
  pendingLinks: PendingLink[],
  pendingFiles: PendingFile[],
): string {
  return text.replace(WIKILINK_RE, (raw, bang, targetRaw, anchor, alias) => {
    const isEmbed = bang === '!';
    const target = targetRaw.trim();
    const ext = target.includes('.') ? target.split('.').pop()!.toLowerCase() : '';

    if (isEmbed && ATTACHMENT_EXTENSIONS.has(ext)) {
      const resolved = ctx.resolveAttachment(target);
      const placeholder = makeFilePlaceholder();
      pendingFiles.push({ placeholder, targetPath: resolved, fallbackText: raw });
      if (!resolved) {
        entries.push({ category: 'warning', path: ctx.sourcePath, message: `添付ファイル "${target}" が見つかりませんでした` });
      }
      return placeholder;
    }

    if (isEmbed && !ext) {
      // ノート埋め込み（トランスクルージョン非対応→リンク降格）
      const resolved = ctx.resolveNoteLink(target);
      const displayText = alias?.trim() || target;
      entries.push({
        category: 'downgraded',
        path: ctx.sourcePath,
        message: `ノート埋め込み "![[${target}]]" をリンクに降格しました`,
      });
      if (!resolved) {
        entries.push({ category: 'unresolved_link', path: ctx.sourcePath, message: `埋め込みリンク先 "${target}" が見つかりませんでした` });
        return `<callout icon="📎" color="gray_bg">埋め込み: ${displayText}</callout>`;
      }
      const placeholder = makeLinkPlaceholder();
      pendingLinks.push({ placeholder, targetPath: resolved, fallbackText: `${displayText}`, displayText: `埋め込み: ${displayText}` });
      return `<callout icon="📎" color="gray_bg">埋め込み: ${placeholder}</callout>`;
    }

    // 通常のノートリンク（見出し/ブロック参照/エイリアス対応）
    let displayText = alias?.trim() || target;
    let degraded = false;
    if (anchor) {
      if (anchor.startsWith('^')) {
        degraded = true;
        entries.push({ category: 'downgraded', path: ctx.sourcePath, message: `ブロック参照 "[[${target}#${anchor}]]" はページ先頭リンクに降格しました` });
      } else {
        degraded = true;
        if (!alias) displayText = `${target} > ${anchor}`;
        entries.push({ category: 'downgraded', path: ctx.sourcePath, message: `見出しリンク "[[${target}#${anchor}]]" はページ先頭リンクに降格しました` });
      }
    }

    const resolved = ctx.resolveNoteLink(target);
    const placeholder = makeLinkPlaceholder();
    pendingLinks.push({
      placeholder,
      targetPath: resolved,
      fallbackText: alias ? `[[${target}|${alias}]]` : (anchor ? `[[${target}#${anchor}]]` : `[[${target}]]`),
      displayText,
    });
    if (!resolved) {
      entries.push({ category: 'unresolved_link', path: ctx.sourcePath, message: `リンク先 "${target}" が見つかりませんでした` });
    }
    void degraded;
    return placeholder;
  });
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function convertMarkdownLinksAndImages(
  text: string,
  ctx: ConverterContext,
  entries: ReportEntry[],
  pendingLinks: PendingLink[],
  pendingFiles: PendingFile[],
): string {
  let result = text.replace(MD_IMAGE_RE, (raw, alt, url) => {
    if (/^https?:\/\//i.test(url)) return raw; // 外部URL画像はそのまま
    const decoded = decodeURIComponent(url);
    const resolved = ctx.resolveAttachment(decoded) ?? ctx.resolveAttachment(path.posix.basename(decoded));
    const placeholder = makeFilePlaceholder();
    pendingFiles.push({ placeholder, targetPath: resolved, fallbackText: raw });
    if (!resolved) {
      entries.push({ category: 'warning', path: ctx.sourcePath, message: `画像 "${decoded}" が見つかりませんでした` });
    }
    return placeholder;
  });

  result = result.replace(MD_LINK_RE, (raw, text_, url) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('#')) return raw; // 外部URL/ページ内アンカーはそのまま
    if (!url.endsWith('.md')) return raw; // md形式内部リンクのみ対象
    const decoded = decodeURIComponent(url);
    const resolved = ctx.resolveNoteLink(decoded) ?? ctx.resolveNoteLink(path.posix.basename(decoded));
    const placeholder = makeLinkPlaceholder();
    pendingLinks.push({ placeholder, targetPath: resolved, fallbackText: raw, displayText: text_ });
    if (!resolved) {
      entries.push({ category: 'unresolved_link', path: ctx.sourcePath, message: `md形式リンク先 "${decoded}" が見つかりませんでした` });
    }
    return placeholder;
  });

  return result;
}

export function convertNote(content: string, ctx: ConverterContext): ConvertNoteResult {
  linkCounter = 0;
  fileCounter = 0;
  const entries: ReportEntry[] = [];
  const pendingLinks: PendingLink[] = [];
  const pendingFiles: PendingFile[] = [];

  const needsEscapeRestore = content.includes(ESCAPE_TARGET);
  const escaped = needsEscapeRestore
    ? content.split(ESCAPE_TARGET).join(ESCAPE_SENTINEL)
    : content;

  const segments = splitCodeFences(escaped);
  const converted = segments.map((seg) => {
    if (seg.type === 'code') {
      if (seg.lang === 'dataview' || seg.lang === 'dataviewjs') {
        entries.push({
          category: 'downgraded',
          path: ctx.sourcePath,
          message: `${seg.lang}コードブロックはそのまま保持しました（実行結果は再現されません）`,
        });
      }
      return seg.content; // mermaid含め、コードブロックは常にそのまま保持
    }
    let t = seg.content;
    t = convertCallouts(t, entries, ctx.sourcePath);
    t = convertWikiLinks(t, ctx, entries, pendingLinks, pendingFiles);
    t = convertMarkdownLinksAndImages(t, ctx, entries, pendingLinks, pendingFiles);
    t = convertHighlights(t, entries, ctx.sourcePath);
    t = stripComments(t, entries, ctx.sourcePath);
    t = expandFootnotes(t, entries, ctx.sourcePath);
    return t;
  });

  return {
    markdown: converted.join(''),
    entries,
    pendingLinks,
    pendingFiles,
    needsEscapeRestore,
  };
}

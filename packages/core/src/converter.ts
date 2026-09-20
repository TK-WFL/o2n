import path from 'node:path';
import type { ConversionResult, ReportEntry } from './types.js';

/**
 * プレースホルダー形式について（仕様書§5 F4からの実装上の変更点）:
 * 仕様書は `⟦o2n:link:リンク先相対パス⟧` という単一の相対パス埋め込み形式を示すが、
 * 同一ノートへのエイリアス違いリンクや見出しリンクなど「表示名がリンクごとに異なるケース」を
 * 表現できないため、本実装では `⟦o2n-link-N⟧` / `⟦o2n-file-N⟧`（Nはノート内の出現順連番）を
 * プレースホルダーとし、実際のリンク先・表示名は ConversionResult.pendingLinks / pendingFiles に
 * 構造化データとして保持する。Pass 2 はこのNをキーに old_str/new_str を組み立てる。
 * コロンではなくハイフン区切りにしているのは、Notionのenhanced markdownが
 * old_str検索対象のシリアライズ時にコロンをバックスラッシュエスケープするため
 * （§16検証済み、2026-07-19）。差分は docs/questions.md に記録済み。
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
  /** 元本文に⟦o2n-が含まれていたためエスケープ復元が必要か */
  needsEscapeRestore: boolean;
}

export type EmbedMode = 'link' | 'inline';

export interface ConverterContext {
  sourcePath: string;
  /** [[target]] や ![alt](path) 等の解決先ノート/添付相対パスを引く。見つからなければnull */
  resolveNoteLink: (target: string) => string | null;
  resolveAttachment: (target: string) => string | null;
  /**
   * ノート埋め込み `![[Note]]` の扱い（#80）。既定 'link' はリンクに降格。'inline' は埋め込み先の
   * 本文を変換してその場に展開する（Notion にはページ間の同期ブロックを API で作る手段が無いため）。
   */
  embedMode?: EmbedMode;
  /** 'inline' 用: 埋め込み先ノート（vault相対パス）の本文（frontmatter 除く）を返す。無ければ null */
  readNote?: (notePath: string) => string | null;
  /** 'inline' 用: 埋め込み先ノートを起点にしたリンク解決コンテキストを返す（パス近接の基準を切り替える） */
  contextFor?: (notePath: string) => ConverterContext;
}

/** 埋め込みのインライン展開の最大深さ（A→B→C まで。循環は stack で検出） */
const MAX_EMBED_DEPTH = 2;

interface ConversionAccumulator {
  entries: ReportEntry[];
  pendingLinks: PendingLink[];
  pendingFiles: PendingFile[];
  needsEscapeRestore: boolean;
  /** インライン展開中のノートパス（循環検出用。先頭が最外のノート） */
  embedStack: string[];
}

/**
 * Obsidian 公式の callout 種別と別名（help/editing-and-formatting/callouts）を
 * Notion callout のアイコン/背景色に対応付ける。Obsidian 側の配色に寄せている。
 * 未知の種別は DEFAULT_CALLOUT に落とし、downgraded として報告する。
 */
const CALLOUT_STYLES = {
  note: { icon: '💡', color: 'blue_bg' },
  abstract: { icon: '📋', color: 'blue_bg' },
  info: { icon: 'ℹ️', color: 'gray_bg' },
  todo: { icon: '☑️', color: 'blue_bg' },
  tip: { icon: '🔥', color: 'green_bg' },
  success: { icon: '✅', color: 'green_bg' },
  question: { icon: '❓', color: 'yellow_bg' },
  warning: { icon: '⚠️', color: 'orange_bg' },
  failure: { icon: '❌', color: 'red_bg' },
  danger: { icon: '⚡', color: 'red_bg' },
  bug: { icon: '🐛', color: 'red_bg' },
  example: { icon: '📝', color: 'purple_bg' },
  quote: { icon: '💬', color: 'gray_bg' },
} as const satisfies Record<string, { icon: string; color: string }>;

const CALLOUT_ALIASES: Record<string, keyof typeof CALLOUT_STYLES> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  important: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  caution: 'warning',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

const CALLOUT_TYPE_MAP: Record<string, { icon: string; color: string }> = {
  ...CALLOUT_STYLES,
  ...Object.fromEntries(Object.entries(CALLOUT_ALIASES).map(([alias, canonical]) => [alias, CALLOUT_STYLES[canonical]])),
};
const DEFAULT_CALLOUT = { icon: 'ℹ️', color: 'gray_bg' };

/**
 * §16検証済み（2026-07-19）: Notionのenhanced markdownは`old_str`検索の対象となる
 * 保存済みmarkdownをシリアライズする際、コロン(:)をバックスラッシュエスケープする
 * （`⟦o2n:link:0⟧` → `⟦o2n\:link\:0⟧`）。これによりPass2の完全一致検索が失敗するため、
 * プレースホルダーにはコロンを含めず、ハイフンを使う。
 */
export const ESCAPE_SENTINEL = '⟦o2n-esc-';
export const ESCAPE_TARGET = '⟦o2n-';

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

const INLINE_CODE_SENTINEL_PREFIX = '⟦o2n-code-';

/**
 * インラインコード（`` `x` `` および `` ``x`` ``）を番兵に置き換え、復元関数を返す。
 * 番兵はリンク/添付プレースホルダーと同じ `⟦o2n-` 接頭辞を使う（本文中の同接頭辞は
 * convertNote 冒頭で退避済みなので衝突しない）。正規表現はバッククォートと非バッククォートの
 * 文字集合が排他なので線形時間で走る。
 */
function protectInlineCode(text: string): { text: string; restore: (t: string) => string } {
  const spans: string[] = [];
  const stash = (m: string): string => {
    spans.push(m);
    return `${INLINE_CODE_SENTINEL_PREFIX}${spans.length - 1}⟧`;
  };
  let out = text.replace(/``[^`\n]+(?:`[^`\n]+)*``/g, stash);
  out = out.replace(/`[^`\n]+`/g, stash);
  const restore = (t: string): string =>
    spans.length === 0 ? t : t.replace(/⟦o2n-code-(\d+)⟧/g, (_m, i: string) => spans[Number(i)] ?? _m);
  return { text: out, restore };
}

/**
 * タスクの拡張状態（`- [/]` `- [-]` `- [>]` 等、テーマ/プラグイン由来）は Notion では `[ ]`/`[x]` 以外
 * 認識されず、`[/] text` という文字列を含む箇条書きになる（実ワークスペースで確認、docs/questions.md §19）。
 * `[X]` は `[x]` に、それ以外は未完了 `[ ]` に正規化し、元の記号を `(記号)` として本文先頭に残す（#79）。
 */
function normalizeTaskStates(text: string, entries: ReportEntry[], sourcePath: string): string {
  let count = 0;
  const out = text.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([^\s\]xX])\](?=\s)/gm, (_m, prefix: string, mark: string) => {
    count += 1;
    return `${prefix}[ ] (${mark})`;
  }).replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[X\](?=\s)/gm, '$1[x]');
  if (count > 0) {
    entries.push({
      category: 'downgraded',
      path: sourcePath,
      message: `タスクの拡張状態（[/] [-] 等）${count}箇所は Notion で認識されないため未完了 [ ] に正規化し、元の記号を本文先頭に残しました`,
    });
  }
  return out;
}

/**
 * Notion の見出しは h4（`####`、2026-03-30 追加）まで。Obsidian の h5/h6 は Notion の enhanced markdown
 * パーサが自動的に heading_4 として保存する（実ワークスペースで確認、docs/questions.md §19）ため
 * 本文の書き換えは不要だが、階層が潰れることを利用者が把握できるよう `####` に正規化した上で
 * downgraded として1ノート1件だけ報告する（#73）。
 */
function normalizeHeadingDepth(text: string, entries: ReportEntry[], sourcePath: string): string {
  let count = 0;
  const out = text.replace(/^(#{5,6})(?=[ \t])/gm, () => {
    count += 1;
    return '####';
  });
  if (count > 0) {
    entries.push({
      category: 'downgraded',
      path: sourcePath,
      message: `見出しレベル5〜6（#####/######）${count}箇所は Notion の上限である見出し4に降格しました`,
    });
  }
  return out;
}

function convertCallouts(text: string, entries: ReportEntry[], sourcePath: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // ReDoS対策（CodeQL js/polynomial-redos）: 種別の後ろに空白量指定（`\s*`や`[ \t]*`）を
    // 置くと、直後の `(.*)` と文字集合が重なりバックトラックの余地が残る。
    // タイトルは後段で trim するため正規表現側で空白を消費する必要はなく、
    // 量指定子ごと削除して曖昧さを構造的に排除している。
    const calloutMatch = /^>[ \t]?\[!(\w+)\]([-+]?)(.*)$/.exec(line);
    if (calloutMatch) {
      const [, rawType, fold, titleText] = calloutMatch;
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
      // §16検証済み: callout内の改行は\nではなく<br>でないと</callout>の位置がずれて壊れる
      const body = bodyLines.join('<br>').trim();
      if (fold === '-') {
        // 折りたたみ callout（既定で閉じる）は Notion のトグルに変換する（#75）。
        // 実ワークスペース検証（2026-09-20、docs/questions.md §19）: <details> は
        // 1行に書くと認識されず、<details>/<summary>/本文/</details> を別行にすると
        // toggle ブロックになり、内側の <callout> も子ブロックとして保持される。
        // `+`（既定で開く）は通常 callout のまま（Notion の callout は常に展開表示）。
        const inner = body ? `\n<callout icon="${style.icon}" color="${style.color}">${body}</callout>` : '';
        out.push(`<details>\n<summary>**${title}**</summary>${inner}\n</details>`);
        i = j;
        continue;
      }
      out.push(`<callout icon="${style.icon}" color="${style.color}">**${title}**${body ? `<br>${body}` : ''}</callout>`);
      i = j;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

/**
 * §16検証済み（2026-07-19、実ワークスペース）: enhanced markdownの`<span color="yellow_bg">text</span>`は
 * 本物のハイライト（rich_textのcolor annotation）として保存されることを確認した。
 * 太字への降格は不要な情報劣化だったため、ネイティブハイライトに変換する（黄色をデフォルトに使用。
 * Obsidianの`==text==`自体は色を指定しないため）。
 */
/**
 * Obsidian 1.14.0（2026-09-02）の色付きハイライト: `==🔴text==` のようにハイライト先頭の
 * 色絵文字で色を指定する。絵文字は表示用の記号なので Notion 側では色だけ反映し、絵文字は除く。
 * https://obsidian.md/changelog/2026-09-02-desktop-v1.14.0/
 */
const HIGHLIGHT_COLOR_EMOJI: Record<string, string> = {
  '🔴': 'red_bg',
  '🟠': 'orange_bg',
  '🟡': 'yellow_bg',
  '🟢': 'green_bg',
  '🔵': 'blue_bg',
  '🟣': 'purple_bg',
};
const HIGHLIGHT_COLOR_PREFIX_RE = /^(🔴|🟠|🟡|🟢|🔵|🟣)\s?/u;

function convertHighlights(text: string): string {
  return text.replace(/==([^=\n]+)==/g, (_m, inner: string) => {
    const prefix = HIGHLIGHT_COLOR_PREFIX_RE.exec(inner);
    const color = prefix ? HIGHLIGHT_COLOR_EMOJI[prefix[1]!]! : 'yellow_bg';
    const body = prefix ? inner.slice(prefix[0].length) : inner;
    return body ? `<span color="${color}">${body}</span>` : _m;
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
  // ReDoS対策: `gm` により行ごとにマッチを試みるため、1行あたりのバックトラックが小さくても
  // 行数分積み上がる（`[` を除外する前は、`[^` で始まる行を2万行与えると約9.5秒かかった）。
  const defRe = /^\[\^([^[\]]+)\]:[ \t]*(.+)$/gm;
  const defs = new Map<string, string>();
  const withoutDefs = text.replace(defRe, (_m, id, body) => {
    defs.set(id, body.trim());
    return '';
  });
  if (defs.size === 0) return withoutDefs;
  // ReDoS対策（WIKILINK_RE と同じ理由で `[` を除外。脚注IDに `[` は現れない）
  const result = withoutDefs.replace(/\[\^([^[\]]+)\]/g, (m, id) => {
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
  return `⟦o2n-link-${linkCounter++}⟧`;
}
function makeFilePlaceholder(): string {
  return `⟦o2n-file-${fileCounter++}⟧`;
}

// セキュリティ対策（CodeQL js/polynomial-redos 指摘対応）: 各文字クラスから `[` を除外している。
// 除外前は `[[` の直後に `]]` で閉じない `[` の並び（例: `[["` の大量反復）を与えると、
// 先頭グループが貪欲に食べては1文字ずつ戻る二次オーダーのバックトラックが起き、
// 50,000文字程度で約10秒かかっていた（除外後は同入力で0ms）。
// Obsidianはファイル名に `[` `]` を使えないため、正当なwikilinkの解釈は変わらない。
// alias側から `|` を除外しているのも同じ理由（aliasに `|` は現れない）。
const WIKILINK_RE = /(!?)\[\[([^[\]|#]+)(?:#(\^?[^[\]|]+))?(?:\|([^[\]|]+))?\]\]/g;

const ATTACHMENT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp',
  'pdf',
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
  'mp4', 'mov', 'webm', 'mkv',
]);

/**
 * ATX 見出しの閉じ `#`（`## 見出し ##`）を取り除く。`## C#` のように空白を挟まない `#` は残す。
 * 正規表現（`[ \t]+#+$`）だと CodeQL の polynomial-redos 指摘になるため文字列走査で行う。
 */
function stripClosingHashes(title: string): string {
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end -= 1;
  if (end === title.length) return title; // 閉じ # なし
  if (end === 0) return ''; // `#` だけの見出し
  const ch = title[end - 1];
  if (ch !== ' ' && ch !== '\t') return title; // `C#` のような語尾の # は見出し文字列の一部
  return title.slice(0, end).trimEnd();
}

/**
 * 見出し指定の埋め込み `![[Note#見出し]]` 用: その見出しから、同じか浅いレベルの次の見出しの
 * 直前までを切り出す。コードブロック内の `#` 行は見出しとして扱わない。見つからなければ null。
 */
export function extractSection(content: string, heading: string): string | null {
  const wanted = heading.trim().toLowerCase();
  const lines = content.split('\n');
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (inFence) continue;
    // ReDoS対策（CodeQL js/polynomial-redos）: 見出しテキストの後ろの空白・閉じ#を正規表現で
    // 消費すると `(.+?)` と文字集合が重なる。正規表現は「#の並び＋空白1つ以上」だけを見て、
    // タイトルの整形（末尾の空白と閉じ # の除去）は文字列操作で行う
    const m = /^(#{1,6})[ \t]/.exec(line);
    if (!m) continue;
    const l = m[1]!.length;
    const title = stripClosingHashes(line.slice(l).trim());
    if (start === -1) {
      if (title.toLowerCase() === wanted) {
        start = i;
        level = l;
      }
    } else if (l <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n');
}

/**
 * `![[Note]]` / `![[Note#見出し]]` を埋め込み先の変換済み本文に置き換える（#80）。
 * 出力は「📎 caption（元ノートへのリンク）」の callout ＋ 本文 ＋ 区切り線。
 * 埋め込み先の添付・リンクのプレースホルダーは呼び出し元ノートの acc に積まれるため、
 * Pass2/3 はそれらを呼び出し元ページ上で解決する。
 */
function inlineEmbed(
  targetPath: string,
  anchor: string | undefined,
  displayText: string,
  ctx: ConverterContext,
  acc: ConversionAccumulator,
): string | null {
  const { entries } = acc;
  const label = anchor ? `${displayText}#${anchor}` : displayText;
  if (!ctx.readNote || !ctx.contextFor) return null;
  if (acc.embedStack.includes(targetPath)) {
    entries.push({ category: 'warning', path: ctx.sourcePath, message: `埋め込み "![[${label}]]" は循環しているためリンクに降格しました（${[...acc.embedStack, targetPath].join(' → ')}）` });
    return null;
  }
  if (acc.embedStack.length > MAX_EMBED_DEPTH) {
    entries.push({ category: 'warning', path: ctx.sourcePath, message: `埋め込み "![[${label}]]" は深さ ${MAX_EMBED_DEPTH} を超えるためリンクに降格しました` });
    return null;
  }
  if (anchor?.startsWith('^')) {
    entries.push({ category: 'downgraded', path: ctx.sourcePath, message: `ブロック参照の埋め込み "![[${label}]]" はブロック単位で切り出せないためリンクに降格しました` });
    return null;
  }
  const raw = ctx.readNote(targetPath);
  if (raw === null) return null;
  const body = anchor ? extractSection(raw, anchor) : raw;
  if (body === null) {
    entries.push({ category: 'warning', path: ctx.sourcePath, message: `埋め込み "![[${label}]]" の見出しが見つからないためリンクに降格しました` });
    return null;
  }

  const nestedCtx = { ...ctx.contextFor(targetPath), embedMode: 'inline' as const, readNote: ctx.readNote, contextFor: ctx.contextFor };
  const nestedAcc: ConversionAccumulator = { ...acc, embedStack: [...acc.embedStack, targetPath] };
  const converted = convertBody(body, nestedCtx, nestedAcc);
  acc.needsEscapeRestore = acc.needsEscapeRestore || nestedAcc.needsEscapeRestore;

  const captionLink = makeLinkPlaceholder();
  acc.pendingLinks.push({ placeholder: captionLink, targetPath, fallbackText: label, displayText: label });
  entries.push({ category: 'downgraded', path: ctx.sourcePath, message: `ノート埋め込み "![[${label}]]" を本文にインライン展開しました（Notion では同期されない複製になります）` });
  return `<callout icon="📎" color="gray_bg">**埋め込み: ${captionLink}**</callout>\n${converted.trim()}\n\n---\n`;
}

function convertWikiLinks(text: string, ctx: ConverterContext, acc: ConversionAccumulator): string {
  const { entries, pendingLinks, pendingFiles } = acc;
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
      const resolved = ctx.resolveNoteLink(target);
      const displayText = alias?.trim() || target;

      if (ctx.embedMode === 'inline' && resolved) {
        const inlined = inlineEmbed(resolved, anchor, displayText, ctx, acc);
        if (inlined !== null) return inlined;
        // 展開できない（循環・深さ超過・見出し不明・本文取得不可）場合はリンク降格に落ちる
      }

      // ノート埋め込み（トランスクルージョン非対応→リンク降格）。
      // §16検証済み（実ワークスペース）: <callout>はブロック要素のため、箇条書き行などに
      // インラインで出現すると周辺のcallout構造ごと壊れることが判明。calloutは使わず、
      // 他の降格ケース（見出しリンク等）と同様にプレーンなリンクテキストにする。
      entries.push({
        category: 'downgraded',
        path: ctx.sourcePath,
        message: `ノート埋め込み "![[${anchor ? `${target}#${anchor}` : target}]]" をリンクに降格しました`,
      });
      if (!resolved) {
        entries.push({ category: 'unresolved_link', path: ctx.sourcePath, message: `埋め込みリンク先 "${target}" が見つかりませんでした` });
        return `埋め込み: ${displayText}`;
      }
      const placeholder = makeLinkPlaceholder();
      pendingLinks.push({ placeholder, targetPath: resolved, fallbackText: `埋め込み: ${displayText}`, displayText: `埋め込み: ${displayText}` });
      return placeholder;
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

// ReDoS対策（WIKILINK_RE と同じ理由で `[` を除外）: 除外前は `[a` の大量反復を与えると
// 角括弧テキスト部が貪欲に食べては戻る二次オーダーのバックトラックが起き、
// 50,000反復で2〜3秒かかっていた。Markdownの入れ子リンクは元々不正な記法のため解釈は変わらない。
const MD_IMAGE_RE = /!\[([^[\]]*)\]\(([^)\s]+)\)/g;
const MD_LINK_RE = /\[([^[\]]+)\]\(([^)\s]+)\)/g;

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
  const acc: ConversionAccumulator = {
    entries: [],
    pendingLinks: [],
    pendingFiles: [],
    needsEscapeRestore: false,
    embedStack: [ctx.sourcePath],
  };
  const markdown = convertBody(content, ctx, acc);
  return {
    markdown,
    entries: acc.entries,
    pendingLinks: acc.pendingLinks,
    pendingFiles: acc.pendingFiles,
    needsEscapeRestore: acc.needsEscapeRestore,
  };
}

/** convertNote の本体。インライン展開（#80）で埋め込み先ノートにも再帰的に適用される */
function convertBody(content: string, ctx: ConverterContext, acc: ConversionAccumulator): string {
  const { entries } = acc;
  if (content.includes(ESCAPE_TARGET)) acc.needsEscapeRestore = true;
  const escaped = content.includes(ESCAPE_TARGET) ? content.split(ESCAPE_TARGET).join(ESCAPE_SENTINEL) : content;

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
    // インラインコード（`...`）の中身は変換対象外（docs/questions.md §7、#79）。
    // 先に退避して各変換を通した後で戻す。fenced code block と同じ扱い。
    const { text: withoutInlineCode, restore } = protectInlineCode(seg.content);
    let t = withoutInlineCode;
    t = normalizeHeadingDepth(t, entries, ctx.sourcePath);
    t = normalizeTaskStates(t, entries, ctx.sourcePath);
    t = convertCallouts(t, entries, ctx.sourcePath);
    t = convertWikiLinks(t, ctx, acc);
    t = convertMarkdownLinksAndImages(t, ctx, entries, acc.pendingLinks, acc.pendingFiles);
    t = convertHighlights(t);
    t = stripComments(t, entries, ctx.sourcePath);
    t = expandFootnotes(t, entries, ctx.sourcePath);
    return restore(t);
  });

  return converted.join('');
}

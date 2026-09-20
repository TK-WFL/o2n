export const MAX_PAYLOAD_BYTES = 450_000; // §4.2の500KB上限にマージンを取る
export const MAX_BLOCKS_PER_CHUNK = 900; // 1000ブロック上限にマージン

export function buildTitleProperty(text: string): { title: Array<{ text: { content: string } }> } {
  return { title: [{ text: { content: text } }] };
}

/**
 * §7.1 page_treeモード: frontmatterをページ本文冒頭のcalloutとして保持する
 */
export function buildFrontmatterMetaCallout(frontmatter: Record<string, unknown>): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return '';
  const lines = keys.map((k) => {
    const v = frontmatter[k];
    // gray-matter@2.x(js-yaml 4)は無引用のYYYY-MM-DD等をDate型にパースしていたため、
    // JSON.stringifyされた不格好な引用符付きISO文字列にならないよう先に判定していた名残。
    // gray-matter@3.x(js-yaml 5)は同じ値を文字列のまま返すため実質到達しないが、
    // 将来Date型を返す実装に戻っても壊れないよう残す。
    const rendered =
      v instanceof Date
        ? v.toISOString().slice(0, 10)
        : Array.isArray(v)
          ? v.join(', ')
          : typeof v === 'object' && v !== null
            ? JSON.stringify(v)
            : String(v);
    return `${k}: ${rendered}`;
  });
  // §16検証済み（2026-07-19）: callout内の複数行は\nではなく<br>で区切る必要がある。
  // \nのままだと</callout>が意図しない位置に挿入され、calloutが途中で閉じてしまう。
  return `<callout icon="ℹ️" color="gray_bg">${lines.join('<br>')}</callout>\n\n`;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

export interface SplitMarkdownOptions {
  /** 単一の分割不可ユニット（コードブロック等）が上限を超えて強制分割された場合に呼ばれる */
  onOversizedUnit?: (message: string) => void;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE_ROW_RE = /^\s{0,3}\|/;

/**
 * markdownを「分割してはいけない単位」に切る。各ユニットは末尾の空行まで含む生のテキストで、
 * 全ユニットを連結すると元のmarkdownに完全に一致する。
 * - fenced code block（``` / ~~~）: 開始〜対応する終了フェンスまで
 * - <callout>〜</callout>: 複数行にまたがる場合は閉じタグまで
 * - 表: 先頭が `|` の連続行
 * - それ以外: 空行までの段落
 */
export function splitMarkdownUnits(markdown: string): string[] {
  const lines = markdown.split('\n');
  const units: string[] = [];
  let i = 0;

  const takeBlankLines = (buf: string[]) => {
    while (i < lines.length && (lines[i] ?? '').trim() === '') {
      buf.push(lines[i]!);
      i += 1;
    }
  };

  while (i < lines.length) {
    const buf: string[] = [];
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      buf.push(line);
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        buf.push(l);
        i += 1;
        const close = FENCE_RE.exec(l);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length && l.trim() === close[1]) break;
      }
    } else if (/<callout\b/.test(line) && !/<\/callout>/.test(line)) {
      buf.push(line);
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        buf.push(l);
        i += 1;
        if (/<\/callout>/.test(l)) break;
      }
    } else if (TABLE_ROW_RE.test(line)) {
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!)) {
        buf.push(lines[i]!);
        i += 1;
      }
    } else if (line.trim() === '') {
      takeBlankLines(buf);
      // 先頭の空行はそれ自体をユニットにする（連結時の同一性を保つ）
      units.push(buf.join('\n'));
      continue;
    } else {
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        buf.push(lines[i]!);
        i += 1;
      }
    }
    takeBlankLines(buf);
    units.push(buf.join('\n'));
  }

  // split('\n') の仕様上、各ユニットは行配列。連結時に行区切りを復元する
  return units.map((u, idx) => (idx < units.length - 1 ? `${u}\n` : u));
}

/** ユニットのおおよそのブロック数（コードブロック/callout/表は1、段落は非空行数） */
function estimateBlocks(unit: string): number {
  const first = unit.split('\n')[0] ?? '';
  if (FENCE_RE.test(first) || /<callout\b/.test(first) || TABLE_ROW_RE.test(first)) return 1;
  return Math.max(1, unit.split('\n').filter((l) => l.trim() !== '').length);
}

/**
 * §4.2 のペイロード制限（1000ブロック・500KB）に対応するため、markdownを分割する。
 * 1個目はPOST /v1/pages用、以降はPATCH .../markdown の insert_content(position: end) で追記する。
 *
 * 以前は空行で機械的に区切っていたため、コードブロックや表の内部に空行があると
 * 2チャンク目がコードブロック外として解釈され本文が壊れていた（#68）。
 * 現在は fenced code block / <callout> / 表 を分割不可ユニットとして扱い、
 * 全チャンクを連結すると元のmarkdownに一致することを保証する。
 */
export function splitMarkdownForPayload(markdown: string, opts: SplitMarkdownOptions = {}): string[] {
  if (byteLength(markdown) <= MAX_PAYLOAD_BYTES) return [markdown];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  let currentBlocks = 0;

  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = '';
    currentBytes = 0;
    currentBlocks = 0;
  };

  for (const unit of splitMarkdownUnits(markdown)) {
    const unitBytes = byteLength(unit);
    const unitBlocks = estimateBlocks(unit);

    if (unitBytes > MAX_PAYLOAD_BYTES) {
      // 単一ユニットが上限超: 壊れることは避けられないので行単位で強制分割し、呼び出し側に知らせる
      opts.onOversizedUnit?.(
        `${Math.round(unitBytes / 1024)}KB の単一ブロック（コードブロック等）がNotionのペイロード上限を超えるため強制分割しました。Notion上で構造が崩れる可能性があります`,
      );
      flush();
      let piece = '';
      for (const l of unit.split(/(?<=\n)/)) {
        if (byteLength(piece) + byteLength(l) > MAX_PAYLOAD_BYTES && piece.length > 0) {
          chunks.push(piece);
          piece = '';
        }
        piece += l;
      }
      if (piece.length > 0) chunks.push(piece);
      continue;
    }

    // 空行を含まない長大なリスト等（1ユニットで900行超）はブロック数上限に収まらないので
    // 行単位で分割する。ネストが崩れないよう、インデントの無い行の直前で切る
    const pieces = unitBlocks > MAX_BLOCKS_PER_CHUNK ? splitUnitByLines(unit) : [unit];
    for (const piece of pieces) {
      const pieceBytes = byteLength(piece);
      const pieceBlocks = estimateBlocks(piece);
      if (current.length > 0 && (currentBytes + pieceBytes > MAX_PAYLOAD_BYTES || currentBlocks + pieceBlocks > MAX_BLOCKS_PER_CHUNK)) {
        flush();
      }
      current += piece;
      currentBytes += pieceBytes;
      currentBlocks += pieceBlocks;
    }
  }
  flush();
  return chunks;
}

function splitUnitByLines(unit: string): string[] {
  const lines = unit.split(/(?<=\n)/);
  const pieces: string[] = [];
  let buf: string[] = [];
  let lastTopLevel = -1;
  for (const l of lines) {
    if (!/^\s/.test(l)) lastTopLevel = buf.length;
    buf.push(l);
    if (buf.length >= MAX_BLOCKS_PER_CHUNK) {
      const cut = lastTopLevel > 0 ? lastTopLevel : buf.length;
      pieces.push(buf.slice(0, cut).join(''));
      buf = buf.slice(cut);
      lastTopLevel = -1;
      for (let i = 0; i < buf.length; i += 1) if (!/^\s/.test(buf[i]!)) lastTopLevel = i;
    }
  }
  if (buf.length > 0) pieces.push(buf.join(''));
  return pieces;
}

/**
 * allow_async=true を使うか。splitMarkdownForPayload のチャンクは常に MAX_PAYLOAD_BYTES 以下なので
 * 現状この関数が true を返すことはない（意図的）。非同期書き込みは完了を status_url で
 * ポーリングしてから次の insert_content を送る必要があり、その実装が無いまま有効化すると
 * 追記順序が崩れうる。将来ポーリングを実装した際に閾値を見直す。
 */
export function shouldUseAsyncWrite(markdown: string): boolean {
  return byteLength(markdown) > MAX_PAYLOAD_BYTES * 2;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv']);

export type AttachmentBlockType = 'image' | 'pdf' | 'audio' | 'video' | 'file';

export function attachmentBlockType(extension: string): AttachmentBlockType {
  const ext = extension.toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

export function buildAttachmentBlock(fileUploadId: string, extension: string): Record<string, unknown> {
  const type = attachmentBlockType(extension);
  return {
    object: 'block',
    type,
    [type]: {
      type: 'file_upload',
      file_upload: { id: fileUploadId },
    },
  };
}

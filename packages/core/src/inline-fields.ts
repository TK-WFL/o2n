import { findFenceRanges } from './converter.js';

/**
 * Dataview のインラインフィールド（#146）を本文から取り出す。
 * - 行頭の `Key:: Value`（リスト記号・引用記号の後も可。キーは `**` 等の装飾を外す）
 * - 行中の `[Key:: Value]` / `(Key:: Value)`
 * コードブロック・インラインコードの中は対象外。同じキーが複数回あれば配列にする。
 * 値は `3` → 数値、`true`/`false` → 真偽値、`[[ノート]]` → `ノート` に整える（それ以外は文字列）。
 */
export function parseInlineFields(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  const inFence = new Array<boolean>(lines.length).fill(false);
  for (const r of findFenceRanges(lines)) for (let i = r.start; i <= r.end; i += 1) inFence[i] = true;

  const raw = new Map<string, string[]>();
  const add = (key: string, value: string) => {
    const k = key.replace(/[*_~`]/g, '').trim();
    if (!k || k.length > 64 || /[[\]()|#]/.test(k)) return;
    const list = raw.get(k) ?? [];
    list.push(value.trim());
    raw.set(k, list);
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue;
    // インラインコードは同じ長さの空白で伏せて、区切りの位置がずれないようにする
    const line = lines[i]!.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
    // 行中の [key:: value] / (key:: value)。値には [[リンク]] を含められる。値の選択肢は
    // 「[[…]]（`[` で始まる）」と「括弧以外の 1 文字」で先頭文字が排他なので線形時間
    let bracketed = false;
    for (const m of line.matchAll(/[[(]([^[\]()\n:]+)::((?:\[\[[^[\]\n]*\]\]|[^[\]()\n])*)[\])]/g)) {
      add(m[1]!, m[2]!);
      bracketed = true;
    }
    if (bracketed) continue;
    // 行頭の key:: value（リスト・引用の記号は読み飛ばす）
    const body = line.replace(/^\s*(?:>\s*)*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)?/, '');
    const sep = body.indexOf('::');
    if (sep <= 0) continue;
    add(body.slice(0, sep), body.slice(sep + 2));
  }

  const out: Record<string, unknown> = {};
  for (const [k, values] of raw) {
    const coerced = values.map(coerce);
    out[k] = coerced.length === 1 ? coerced[0] : coerced;
  }
  return out;
}

function coerce(v: string): unknown {
  const linkOnly = /^\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]$/.exec(v);
  if (linkOnly) return (linkOnly[2] ?? linkOnly[1]!).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

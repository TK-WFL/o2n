import type { FrontmatterMapping } from './types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/;
const URL_RE = /^https?:\/\//i;

/**
 * §7.2 型推論規則: YAML値 → Notionプロパティ型
 */
export function inferPropertyType(key: string, sampleValues: unknown[]): FrontmatterMapping['notionPropertyType'] {
  if (key === 'title') return 'title';
  if (key === 'tags') return 'multi_select';
  if (/^(created|updated)/i.test(key)) return 'date';

  const nonNull = sampleValues.filter((v) => v !== undefined && v !== null);
  if (nonNull.length === 0) return 'rich_text';

  // gray-matter(js-yaml)は無引用の YYYY-MM-DD 等をJSのDate型にパースするため先に判定する
  const allDateInstance = nonNull.every((v) => v instanceof Date);
  if (allDateInstance) return 'date';

  const allBoolean = nonNull.every((v) => typeof v === 'boolean');
  if (allBoolean) return 'checkbox';

  const allNumber = nonNull.every((v) => typeof v === 'number');
  if (allNumber) return 'number';

  const allArrayOfString = nonNull.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (allArrayOfString) return 'multi_select';

  const allString = nonNull.every((v) => typeof v === 'string');
  if (allString) {
    const allDate = nonNull.every((v) => DATE_RE.test(v as string));
    if (allDate) return 'date';
    const allUrl = nonNull.every((v) => URL_RE.test(v as string));
    if (allUrl) return 'url';
    return 'rich_text';
  }

  // ネストしたobject等 → JSON文字列化してrich_text（+レポートは呼び出し側で記録）
  return 'rich_text';
}

export function buildFrontmatterMappingsForFolder(
  notesFrontmatter: Record<string, unknown>[],
): FrontmatterMapping[] {
  const keyValues = new Map<string, unknown[]>();
  for (const fm of notesFrontmatter) {
    for (const [k, v] of Object.entries(fm)) {
      const list = keyValues.get(k) ?? [];
      list.push(v);
      keyValues.set(k, list);
    }
  }
  return [...keyValues.entries()].map(([key, values]) => ({
    key,
    notionPropertyType: inferPropertyType(key, values),
  }));
}

/** rich_text値が2000文字を超える場合の切り詰め。全文は本文冒頭メタcalloutへ退避+レポート対象 */
export function truncateRichText(value: string, maxLen = 2000): { text: string; truncated: boolean } {
  if (value.length <= maxLen) return { text: value, truncated: false };
  return { text: value.slice(0, maxLen), truncated: true };
}

/** multi_selectの選択肢が100を超える場合、超過分をrich_textに退避 */
export function splitMultiSelectOverflow(values: string[], maxOptions = 100): { kept: string[]; overflow: string[] } {
  if (values.length <= maxOptions) return { kept: values, overflow: [] };
  return { kept: values.slice(0, maxOptions), overflow: values.slice(maxOptions) };
}

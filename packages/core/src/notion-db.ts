import type { FrontmatterMapping } from './types.js';
import type { NotionApi } from './notion-client.js';
import { splitMultiSelectOverflow, truncateRichText } from './property-mapping.js';

function propertySchema(type: FrontmatterMapping['notionPropertyType']): Record<string, unknown> {
  switch (type) {
    case 'title':
      return { title: {} };
    case 'rich_text':
      return { rich_text: {} };
    case 'number':
      return { number: {} };
    case 'checkbox':
      return { checkbox: {} };
    case 'date':
      return { date: {} };
    case 'multi_select':
      return { multi_select: {} };
    case 'url':
      return { url: {} };
    default:
      return { rich_text: {} };
  }
}

/**
 * §7.2 databaseモード: フォルダをDBとして作成する。
 * §16-4は実ワークスペースで検証済み（2026-07-19）:
 * - parentは `{ type: 'page_id', page_id }` と明示的な type が必須（省略すると400）
 * - properties は `initial_data_source.properties` 配下に置く必要がある（トップレベル不可）
 * - レスポンスの data source id は `data_sources[0].id` を使う
 */
export async function createDatabaseForFolder(
  api: NotionApi,
  parentPageId: string,
  folderTitle: string,
  mappings: FrontmatterMapping[],
): Promise<{ databaseId: string; dataSourceId: string }> {
  const properties: Record<string, unknown> = {};
  let hasTitle = false;
  for (const m of mappings) {
    properties[m.key] = propertySchema(m.notionPropertyType);
    if (m.notionPropertyType === 'title') hasTitle = true;
  }
  if (!hasTitle) {
    properties.Name = propertySchema('title');
  }

  const res = await api.createDatabase({
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: folderTitle } }],
    initial_data_source: { properties },
  });

  const withDataSources = res as { id: string; data_sources?: Array<{ id: string }> };
  const dataSourceId = withDataSources.data_sources?.[0]?.id ?? withDataSources.id;
  return { databaseId: withDataSources.id, dataSourceId };
}

export interface RowPropertyIssue {
  key: string;
  message: string;
}

export interface RowProperties {
  properties: Record<string, unknown>;
  /** Notionのプロパティ値上限で切り詰め・省略した項目（呼び出し側でレポート＋本文退避する） */
  issues: RowPropertyIssue[];
}

/** Notionのプロパティ値上限（https://developers.notion.com/reference/request-limits） */
export const RICH_TEXT_MAX_LENGTH = 2000;
export const URL_MAX_LENGTH = 2000;
export const MULTI_SELECT_MAX_OPTIONS = 100;

const DATE_START_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * DBモードの行プロパティを組み立てる。Notionの値上限（rich_text/title/url 2000字、
 * multi_select 100件）を超える値は切り詰め・省略し、`issues` で呼び出し側に知らせる。
 * 上限超過をそのまま送ると validation_error でページ作成自体が失敗する（#67）。
 */
export function buildRowProperties(
  frontmatter: Record<string, unknown>,
  mappings: FrontmatterMapping[],
  fallbackTitle: string,
): RowProperties {
  const properties: Record<string, unknown> = {};
  const issues: RowPropertyIssue[] = [];
  let hasTitle = false;

  for (const m of mappings) {
    const value = frontmatter[m.key];
    if (value === undefined || value === null) continue;
    const rendered = renderPropertyValue(m.notionPropertyType, value);
    if (rendered.issue) issues.push({ key: m.key, message: rendered.issue });
    if (rendered.value === undefined) continue;
    properties[m.key] = rendered.value;
    if (m.notionPropertyType === 'title') hasTitle = true;
  }

  if (!hasTitle) {
    properties.Name = { title: [{ text: { content: truncateRichText(fallbackTitle, RICH_TEXT_MAX_LENGTH).text } }] };
  }
  return { properties, issues };
}

function stringify(value: unknown): string {
  return typeof value === 'object' && value !== null && !(value instanceof Date) ? JSON.stringify(value) : String(value);
}

function renderPropertyValue(
  type: FrontmatterMapping['notionPropertyType'],
  value: unknown,
): { value: unknown; issue?: string } {
  switch (type) {
    case 'title':
    case 'rich_text': {
      const { text, truncated } = truncateRichText(stringify(value), RICH_TEXT_MAX_LENGTH);
      const prop = type === 'title' ? { title: [{ text: { content: text } }] } : { rich_text: [{ text: { content: text } }] };
      return truncated
        ? { value: prop, issue: `${RICH_TEXT_MAX_LENGTH}文字を超えるため切り詰めました（全文は本文冒頭のcalloutに保持）` }
        : { value: prop };
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        return { value: undefined, issue: `数値として解釈できないため省略しました（値は本文冒頭のcalloutに保持）: ${stringify(value)}` };
      }
      return { value: { number: n } };
    }
    case 'checkbox':
      return { value: { checkbox: Boolean(value) } };
    case 'date': {
      const start = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
      if (!DATE_START_RE.test(start)) {
        return { value: undefined, issue: `日付として解釈できないため省略しました（値は本文冒頭のcalloutに保持）: ${start}` };
      }
      return { value: { date: { start } } };
    }
    case 'multi_select': {
      // Obsidian は `tags: a, b` のようなカンマ区切り文字列も複数タグとして扱う（#114）
      const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
      const names = raw.map((v) => stringify(v).trim()).filter((v) => v.length > 0);
      const { kept, overflow } = splitMultiSelectOverflow(names, MULTI_SELECT_MAX_OPTIONS);
      const prop = { multi_select: kept.map((name) => ({ name })) };
      return overflow.length > 0
        ? { value: prop, issue: `選択肢が${MULTI_SELECT_MAX_OPTIONS}件を超えるため${overflow.length}件を省略しました（全件は本文冒頭のcalloutに保持）` }
        : { value: prop };
    }
    case 'url': {
      const { text, truncated } = truncateRichText(String(value), URL_MAX_LENGTH);
      return truncated
        ? { value: { url: text }, issue: `URLが${URL_MAX_LENGTH}文字を超えるため切り詰めました（全文は本文冒頭のcalloutに保持）` }
        : { value: { url: text } };
    }
    default: {
      const { text, truncated } = truncateRichText(stringify(value), RICH_TEXT_MAX_LENGTH);
      return truncated
        ? { value: { rich_text: [{ text: { content: text } }] }, issue: `${RICH_TEXT_MAX_LENGTH}文字を超えるため切り詰めました（全文は本文冒頭のcalloutに保持）` }
        : { value: { rich_text: [{ text: { content: text } }] } };
    }
  }
}

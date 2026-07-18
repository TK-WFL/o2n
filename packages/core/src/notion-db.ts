import type { FrontmatterMapping } from './types.js';
import type { NotionApi } from './notion-client.js';

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

export function buildRowProperties(
  frontmatter: Record<string, unknown>,
  mappings: FrontmatterMapping[],
  fallbackTitle: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  let hasTitle = false;

  for (const m of mappings) {
    const value = frontmatter[m.key];
    if (value === undefined) continue;
    properties[m.key] = renderPropertyValue(m.notionPropertyType, value);
    if (m.notionPropertyType === 'title') hasTitle = true;
  }

  if (!hasTitle) {
    properties.Name = { title: [{ text: { content: fallbackTitle } }] };
  }
  return properties;
}

function renderPropertyValue(type: FrontmatterMapping['notionPropertyType'], value: unknown): unknown {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: String(value) } }] };
    case 'rich_text':
      return {
        rich_text: [{ text: { content: typeof value === 'object' ? JSON.stringify(value) : String(value) } }],
      };
    case 'number':
      return { number: typeof value === 'number' ? value : Number(value) };
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'date':
      return { date: { start: value instanceof Date ? value.toISOString().slice(0, 10) : String(value) } };
    case 'multi_select':
      return {
        multi_select: (Array.isArray(value) ? value : [value]).map((v) => ({ name: String(v) })),
      };
    case 'url':
      return { url: String(value) };
    default:
      return { rich_text: [{ text: { content: String(value) } }] };
  }
}

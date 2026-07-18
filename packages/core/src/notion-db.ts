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
 * §16-4未確定: `POST /v1/databases` の data source 構造の正確な形式は
 * 実ワークスペースでの検証待ち（README参照）。ここでは
 * レスポンスに `data_sources[0].id` があればそれを、無ければ `id` 自体を
 * data source id として扱う防御的実装にしている。
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
    parent: { page_id: parentPageId },
    title: [{ type: 'text', text: { content: folderTitle } }],
    properties,
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

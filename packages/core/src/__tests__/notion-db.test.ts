import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanVault } from '../scanner.js';
import { buildFrontmatterMappingsForFolder } from '../property-mapping.js';
import { buildRowProperties, MULTI_SELECT_MAX_OPTIONS, RICH_TEXT_MAX_LENGTH } from '../notion-db.js';
import type { FrontmatterMapping } from '../types.js';

const fixtureVault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/test-vault');

function mapping(key: string, notionPropertyType: FrontmatterMapping['notionPropertyType']): FrontmatterMapping {
  return { key, notionPropertyType };
}

describe('buildRowProperties: 各型のリクエスト形状', () => {
  it('title/rich_text/number/checkbox/date/multi_select/url を Notion のプロパティ値形式にする', () => {
    const fm = {
      title: 'T',
      note: 'hello',
      count: 42,
      active: true,
      created: '2026-01-01',
      tags: ['a', 'b'],
      url: 'https://example.com',
    };
    const { properties, issues } = buildRowProperties(
      fm,
      [
        mapping('title', 'title'),
        mapping('note', 'rich_text'),
        mapping('count', 'number'),
        mapping('active', 'checkbox'),
        mapping('created', 'date'),
        mapping('tags', 'multi_select'),
        mapping('url', 'url'),
      ],
      'fallback',
    );
    expect(issues).toEqual([]);
    expect(properties).toEqual({
      title: { title: [{ text: { content: 'T' } }] },
      note: { rich_text: [{ text: { content: 'hello' } }] },
      count: { number: 42 },
      active: { checkbox: true },
      created: { date: { start: '2026-01-01' } },
      tags: { multi_select: [{ name: 'a' }, { name: 'b' }] },
      url: { url: 'https://example.com' },
    });
    expect(properties.Name).toBeUndefined();
  });

  it('title マッピングが無ければ Name にフォールバックタイトルを入れる', () => {
    const { properties } = buildRowProperties({ count: 1 }, [mapping('count', 'number')], 'My Note');
    expect(properties.Name).toEqual({ title: [{ text: { content: 'My Note' } }] });
  });

  it('frontmatter に無いキー・null は送らない', () => {
    const { properties } = buildRowProperties({ a: null }, [mapping('a', 'rich_text'), mapping('b', 'number')], 't');
    expect(properties.a).toBeUndefined();
    expect(properties.b).toBeUndefined();
  });

  it('ネストした object は JSON 文字列として rich_text に入る', () => {
    const { properties } = buildRowProperties({ nested: { k: 'v', list: [1, 2] } }, [mapping('nested', 'rich_text')], 't');
    expect(properties.nested).toEqual({ rich_text: [{ text: { content: '{"k":"v","list":[1,2]}' } }] });
  });
});

describe('buildRowProperties: Notion の値上限（#67）', () => {
  it('rich_text が 2000 文字を超える場合は切り詰めて issue を返す', () => {
    const long = 'x'.repeat(RICH_TEXT_MAX_LENGTH + 500);
    const { properties, issues } = buildRowProperties({ longtext: long }, [mapping('longtext', 'rich_text')], 't');
    const content = (properties.longtext as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]!.text.content;
    expect(content.length).toBe(RICH_TEXT_MAX_LENGTH);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.key).toBe('longtext');
    expect(issues[0]!.message).toContain('切り詰め');
  });

  it('title が 2000 文字を超える場合も切り詰める（フォールバックタイトル含む）', () => {
    const long = 'y'.repeat(RICH_TEXT_MAX_LENGTH + 1);
    const a = buildRowProperties({ title: long }, [mapping('title', 'title')], 't');
    expect((a.properties.title as { title: Array<{ text: { content: string } }> }).title[0]!.text.content.length).toBe(RICH_TEXT_MAX_LENGTH);
    expect(a.issues).toHaveLength(1);
    const b = buildRowProperties({}, [], long);
    expect((b.properties.Name as { title: Array<{ text: { content: string } }> }).title[0]!.text.content.length).toBe(RICH_TEXT_MAX_LENGTH);
  });

  it('multi_select が 100 件を超える場合は先頭 100 件だけ送り issue を返す', () => {
    const tags = Array.from({ length: MULTI_SELECT_MAX_OPTIONS + 7 }, (_, i) => `t${i}`);
    const { properties, issues } = buildRowProperties({ tags }, [mapping('tags', 'multi_select')], 't');
    expect((properties.tags as { multi_select: unknown[] }).multi_select).toHaveLength(MULTI_SELECT_MAX_OPTIONS);
    expect(issues[0]!.message).toContain('7件を省略');
  });

  it('url が 2000 文字を超える場合は切り詰める', () => {
    const url = 'https://example.com/' + 'a'.repeat(2100);
    const { properties, issues } = buildRowProperties({ url }, [mapping('url', 'url')], 't');
    expect((properties.url as { url: string }).url.length).toBe(2000);
    expect(issues).toHaveLength(1);
  });

  it('date として解釈できない値は省略して issue を返す（validation_error で行全体が失敗しないように）', () => {
    const { properties, issues } = buildRowProperties({ created: '来週' }, [mapping('created', 'date')], 't');
    expect(properties.created).toBeUndefined();
    expect(issues[0]!.message).toContain('日付として解釈できない');
  });

  it('日時付き ISO 文字列は date として通す', () => {
    const { properties, issues } = buildRowProperties({ updated: '2026-07-18T10:00:00Z' }, [mapping('updated', 'date')], 't');
    expect(properties.updated).toEqual({ date: { start: '2026-07-18T10:00:00Z' } });
    expect(issues).toEqual([]);
  });

  it('number として解釈できない値は省略して issue を返す', () => {
    const { properties, issues } = buildRowProperties({ count: 'many' }, [mapping('count', 'number')], 't');
    expect(properties.count).toBeUndefined();
    expect(issues).toHaveLength(1);
  });

  it('fixture の FrontmatterAllTypes.md（2000文字超 longtext を含む）で全型が上限内に収まる', async () => {
    const inventory = await scanVault(fixtureVault);
    const note = inventory.notes.find((n) => n.path === 'FrontmatterAllTypes.md');
    expect(note).toBeDefined();
    const mappings = buildFrontmatterMappingsForFolder([note!.frontmatter]);
    const { properties, issues } = buildRowProperties(note!.frontmatter, mappings, 'fallback');
    expect(issues.map((i) => i.key)).toEqual(['longtext']);
    for (const v of Object.values(properties)) {
      const json = JSON.stringify(v);
      for (const m of json.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) {
        expect(m[1]!.length).toBeLessThanOrEqual(RICH_TEXT_MAX_LENGTH);
      }
    }
  });
});

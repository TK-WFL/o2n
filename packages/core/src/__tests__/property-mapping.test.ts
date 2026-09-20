import { describe, expect, it } from 'vitest';
import {
  buildFrontmatterMappingsForFolder,
  inferPropertyType,
  splitMultiSelectOverflow,
  truncateRichText,
} from '../property-mapping.js';

describe('inferPropertyType: 判定マトリクス', () => {
  it.each([
    ['title', ['x'], 'title'],
    ['tags', ['a'], 'multi_select'],
    ['tags', [['a', 'b']], 'multi_select'],
    ['created', ['2026-01-01'], 'date'],
    ['updated_at', ['whatever'], 'date'],
    ['flag', [true, false], 'checkbox'],
    ['count', [1, 2.5], 'number'],
    ['list', [['a'], ['b', 'c']], 'multi_select'],
    ['when', ['2026-01-01', '2026-07-18T10:00:00Z'], 'date'],
    ['link', ['https://a.example', 'http://b.example'], 'url'],
    ['text', ['hello', 'https://mixed.example'], 'rich_text'],
    ['mixed', [1, 'one'], 'rich_text'],
    ['empty', [null, undefined], 'rich_text'],
    ['nested', [{ a: 1 }], 'rich_text'],
    ['dates', [new Date('2026-01-01')], 'date'],
  ] as const)('key=%s values=%j → %s', (key, values, expected) => {
    expect(inferPropertyType(key, [...values])).toBe(expected);
  });

  it('フォルダ内の全ノートのキーを集約してマッピングにする', () => {
    const mappings = buildFrontmatterMappingsForFolder([
      { status: 'todo', priority: 1 },
      { status: 'done', priority: 2, due: '2026-01-01' },
    ]);
    expect(mappings).toEqual([
      { key: 'status', notionPropertyType: 'rich_text' },
      { key: 'priority', notionPropertyType: 'number' },
      { key: 'due', notionPropertyType: 'date' },
    ]);
  });
});

describe('truncateRichText / splitMultiSelectOverflow', () => {
  it('上限以下はそのまま', () => {
    expect(truncateRichText('abc', 5)).toEqual({ text: 'abc', truncated: false });
    expect(splitMultiSelectOverflow(['a', 'b'], 2)).toEqual({ kept: ['a', 'b'], overflow: [] });
  });
  it('上限超は切り詰め/分割する', () => {
    expect(truncateRichText('abcdef', 4)).toEqual({ text: 'abcd', truncated: true });
    expect(splitMultiSelectOverflow(['a', 'b', 'c'], 2)).toEqual({ kept: ['a', 'b'], overflow: ['c'] });
  });
});

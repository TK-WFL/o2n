import { describe, expect, it } from 'vitest';
import { NotionApiError } from '@tk_wfl/o2n-core';
import { describeError } from './errors.js';
import { TokenMissingError } from './token.js';

describe('describeError（#116）', () => {
  it('401 はトークン再発行の案内', () => {
    expect(describeError(new NotionApiError(401, 'unauthorized', 'Notion API error 401: bad token'))).toContain('再発行');
  });
  it('404 は接続（Connect）の案内、その他はメッセージそのまま', () => {
    expect(describeError(new NotionApiError(404, 'object_not_found', 'x'))).toContain('Connect');
    expect(describeError(new NotionApiError(400, 'validation_error', 'bad'))).toBe('bad');
    expect(describeError(new TokenMissingError())).toContain('NOTION_TOKEN');
    expect(describeError('str')).toBe('str');
  });
});

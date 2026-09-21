import { describe, expect, it } from 'vitest';
import { buildReport, diffRun, renderReportMarkdown } from '../report.js';
import type { StateFile } from '../types.js';

const state: StateFile = {
  version: 2,
  parentPageId: 'root',
  notes: {
    'a.md': { status: 'done', pageUrl: 'https://n/a' },
    'b.md': { status: 'done', pageUrl: 'https://n/b' },
    'c.md': { status: 'failed', error: 'boom' },
    'd.md': { status: 'skipped' },
  },
  files: {},
};

describe('report（#118）', () => {
  it('diffRun は新規/更新/変更なし/失敗に分ける', () => {
    expect(diffRun({ 'a.md': 'done', 'b.md': 'created' }, state)).toEqual({ created: [], updated: ['b.md'], unchanged: ['a.md'], failed: ['c.md'] });
    expect(diffRun({}, state).created.sort()).toEqual(['a.md', 'b.md']);
  });

  it('レンダリングに実行メタ・今回の差分・ページURL一覧を含む', () => {
    const md = renderReportMarkdown(buildReport(state, [{ category: 'warning', path: 'c.md', message: 'x' }], { startedAt: 0, finishedAt: 65_000, apiCalls: 1234, dryRun: false, before: { 'a.md': 'done' } }), state);
    expect(md).toContain('1分5秒');
    expect(md).toContain('1,234 回');
    expect(md).toContain('新規作成: 1件 / 更新・再開: 0件 / 変更なし: 1件 / 失敗: 1件');
    expect(md).toContain('- `a.md`: https://n/a');
    expect(md).toContain('## 警告 (1件)');
    expect(md).toContain('- `c.md`: boom');
  });

  it('run が無ければ従来通り（後方互換）', () => {
    const md = renderReportMarkdown(buildReport(state, []), state);
    expect(md).not.toContain('今回の実行');
    expect(md).toContain('- 成功: 2件');
  });
});

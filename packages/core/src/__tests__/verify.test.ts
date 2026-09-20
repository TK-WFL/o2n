import { describe, expect, it } from 'vitest';
import { NotionApi, NotionClient } from '../notion-client.js';
import { deepVerifyNotes, summarizeState } from '../verify.js';
import type { StateFile, VaultInventory } from '../types.js';

function stateWith(notes: StateFile['notes']): StateFile {
  return { version: 2, parentPageId: 'root', notes, files: {} };
}

function inventoryWith(paths: string[]): VaultInventory {
  return {
    vaultPath: '/v',
    notes: paths.map((p) => ({ path: p, frontmatter: {}, content: '', sizeBytes: 0 })),
    attachments: [],
    wikiLinks: [],
    skipped: [],
    warnings: [],
    folderTree: {},
    frontmatterKeyStats: {},
  };
}

/** pageId → レスポンス（markdown 文字列 / HTTP ステータス / { trash: true }） */
function mockApi(pages: Record<string, string | number | { trash: true }>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const pathname = new URL(String(url)).pathname;
    const m = /\/pages\/([^/]+)(\/markdown)?$/.exec(pathname);
    const id = m?.[1] ?? '';
    const isMarkdown = Boolean(m?.[2]);
    calls.push(`${id}${isMarkdown ? ':md' : ''}`);
    const r = pages[id];
    if (typeof r === 'number') return new Response(JSON.stringify({ code: r === 404 ? 'object_not_found' : 'error' }), { status: r });
    if (!isMarkdown) {
      // 実機確認: ゴミ箱のページでも GET /pages は 200 で in_trash: true を返す
      return new Response(JSON.stringify({ object: 'page', id, in_trash: typeof r === 'object' }), { status: 200 });
    }
    return new Response(JSON.stringify({ object: 'page_markdown', markdown: typeof r === 'string' ? r : '' }), { status: 200 });
  }) as typeof fetch;
  const api = new NotionApi(new NotionClient({ token: 't', fetchImpl, retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } }));
  return { api, calls };
}

describe('summarizeState', () => {
  it('status ごとの件数と未着手ノートを返す', () => {
    const s = summarizeState(
      stateWith({ 'a.md': { status: 'done' }, 'b.md': { status: 'failed' }, 'c.md': { status: 'done' } }),
      inventoryWith(['a.md', 'b.md', 'c.md', 'd.md']),
    );
    expect(s.vaultNoteCount).toBe(4);
    expect(s.trackedNoteCount).toBe(3);
    expect(s.counts.done).toBe(2);
    expect(s.counts.failed).toBe(1);
    expect(s.untracked).toEqual(['d.md']);
  });
});

describe('deepVerifyNotes（#81）', () => {
  it('done かつ pageId のあるノートだけを 1 リクエストずつ照合し、正常なら不一致ゼロ', async () => {
    const { api, calls } = mockApi({ p1: '# A\n\n本文', p2: '# B\n\n![img](https://x/y.png)' });
    const state = stateWith({
      'A.md': { status: 'done', pageId: 'p1' },
      'B.md': { status: 'done', pageId: 'p2', attachedPlaceholders: ['⟦o2n-file-0⟧'] },
      'C.md': { status: 'created', pageId: 'p3' },
      'D.md': { status: 'failed' },
    });
    const result = await deepVerifyNotes(api, state);
    expect(result.checked).toBe(2);
    expect(result.issues).toEqual([]);
    expect(calls.sort()).toEqual(['p1', 'p1:md', 'p2', 'p2:md']);
  });

  it('ページが 404 なら page_missing', async () => {
    const { api } = mockApi({ p1: 404 });
    const result = await deepVerifyNotes(api, stateWith({ 'A.md': { status: 'done', pageId: 'p1' } }));
    expect(result.issues).toMatchObject([{ path: 'A.md', pageId: 'p1', kind: 'page_missing' }]);
  });

  it('ゴミ箱のページは page_in_trash（markdown は取得しない）', async () => {
    const { api, calls } = mockApi({ p1: { trash: true } });
    const result = await deepVerifyNotes(api, stateWith({ 'A.md': { status: 'done', pageId: 'p1' } }));
    expect(result.issues).toMatchObject([{ path: 'A.md', kind: 'page_in_trash' }]);
    expect(calls).toEqual(['p1']);
  });

  it('本文に ⟦o2n-…⟧ が残っていれば placeholder_left', async () => {
    const { api } = mockApi({ p1: '本文 ⟦o2n-link-3⟧ と ⟦o2n-file-1⟧ と ⟦o2n-link-3⟧' });
    const result = await deepVerifyNotes(api, stateWith({ 'A.md': { status: 'done', pageId: 'p1' } }));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ kind: 'placeholder_left' });
    expect(result.issues[0]!.message).toContain('3件');
  });

  it('添付ブロックが state の件数より少なければ attachment_shortfall（多い分は問題にしない）', async () => {
    const { api } = mockApi({ p1: '![a](u)\n<pdf src="u">x</pdf>', p2: '![a](u)\n![b](u)\n![c](u)' });
    const state = stateWith({
      'A.md': { status: 'done', pageId: 'p1', attachedPlaceholders: ['⟦o2n-file-0⟧', '⟦o2n-file-1⟧', '⟦o2n-file-2⟧'] },
      'B.md': { status: 'done', pageId: 'p2', attachedPlaceholders: ['⟦o2n-file-0⟧'] },
    });
    const result = await deepVerifyNotes(api, state);
    expect(result.issues).toMatchObject([{ path: 'A.md', kind: 'attachment_shortfall' }]);
    expect(result.issues[0]!.message).toContain('3 件あるはずですが 2 件');
  });

  it('5xx が続いた場合は fetch_error として記録し、他のノートの検査は続ける', async () => {
    const { api } = mockApi({ p1: 503, p2: 'ok' });
    const progress: string[] = [];
    const result = await deepVerifyNotes(
      api,
      stateWith({ 'A.md': { status: 'done', pageId: 'p1' }, 'B.md': { status: 'done', pageId: 'p2' } }),
      { onProgress: (_d, _t, p) => progress.push(p) },
    );
    expect(result.issues).toMatchObject([{ path: 'A.md', kind: 'fetch_error' }]);
    expect(progress).toEqual(['A.md', 'B.md']);
  });
});

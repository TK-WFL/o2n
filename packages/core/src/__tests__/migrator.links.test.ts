import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeHeading, runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-links-')));
  await fs.writeFile(path.join(tmpDir, 'Target.md'), '---\naliases: [別名]\n---\n# Target\n\n## Section: Two\n\nbody\n');
  await fs.writeFile(
    path.join(tmpDir, 'Source.md'),
    '# Source\n\n- [[Target]]\n- [[target]]\n- [[Target|表示名]]\n- [[別名]]\n- [[Target#Section Two]]\n- [[Target#無い見出し]]\n- [md](Target.md#Section%20Two)\n- [[#Local]]\n\n## Local\n',
  );
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** POST /pages の直後に、markdown 内の `## 見出し` を heading_2 ブロックとして mock に登録する */
function withHeadings(mock: ReturnType<typeof createMockServer>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const res = await mock.fetchImpl(url, init);
    if ((init?.method ?? 'GET') === 'POST' && new URL(String(url)).pathname === '/v1/pages') {
      const { id } = (await res.clone().json()) as { id: string };
      const md = String((JSON.parse(String(init!.body)) as { markdown?: string }).markdown ?? '');
      const headings = [...md.matchAll(/^## (.+)$/gm)].map((m, i) => ({
        id: `${id}-h-${i}`,
        type: 'heading_2',
        heading_2: { rich_text: [{ plain_text: m[1] }] },
      }));
      if (headings.length > 0) mock.setPageBlocks(id, [...headings, ...mock.getPageBlocks(id)]);
    }
    return res;
  }) as typeof fetch;
}

async function linkUpdates(linkStyle?: 'mention' | 'link') {
  const mock = createMockServer();
  const { inventory, plan, api, state } = await setupMigration(tmpDir, withHeadings(mock));
  if (linkStyle) plan.linkStyle = linkStyle;
  const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });
  const sourceId = state.getNote('Source.md')!.pageId!;
  const patch = mock.calls.find((c) => c.method === 'PATCH' && c.path === `/pages/${sourceId}/markdown`);
  const updates = (patch!.body as { update_content: { content_updates: Array<{ new_str: string }> } }).update_content.content_updates.map((u) => u.new_str);
  return { updates, state, report };
}

describe('ページメンションと見出しリンク（#142, #143）', () => {
  it('ノート名そのままのリンクはメンション、表示名・別名経由は URL リンク', async () => {
    const { updates, state } = await linkUpdates();
    const t = state.getNote('Target.md')!;
    expect(updates[0]).toBe(`<mention-page url="${t.pageUrl}"/>`);
    expect(updates[1]).toBe(`<mention-page url="${t.pageUrl}"/>`); // 大文字小文字違いもノート名
    expect(updates[2]).toBe(`[表示名](${t.pageUrl})`);
    expect(updates[3]).toBe(`[別名](${t.pageUrl})`);
  });

  it('見出しリンクは見出しブロックの ID 付き URL、見つからなければページ先頭にして報告', async () => {
    const { updates, state, report } = await linkUpdates();
    const t = state.getNote('Target.md')!;
    const s = state.getNote('Source.md')!;
    const anchorOf = (n: { pageUrl?: string; pageId?: string }) => `${n.pageUrl}#${`${n.pageId}-h-0`.replace(/-/g, '')}`;
    expect(updates[4]).toBe(`[Target > Section Two](${anchorOf(t)})`);
    expect(updates[5]).toBe(`[Target > 無い見出し](${t.pageUrl})`);
    expect(report.some((e) => e.message.includes('見出し "無い見出し"'))).toBe(true);
    // wikilink が先に変換されるため [[#Local]] → [md](…) の順
    expect(updates[6]).toBe(`[Local](${anchorOf(s)})`);
    expect(updates[7]).toBe(`[md](${anchorOf(t)})`);
  });

  it('linkStyle: link では従来通りすべて URL リンク', async () => {
    const { updates, state } = await linkUpdates('link');
    expect(updates[0]).toBe(`[Target](${state.getNote('Target.md')!.pageUrl})`);
  });

  it('normalizeHeading は Obsidian がリンクで置き換える記号と大文字小文字・全角を揃える', () => {
    expect(normalizeHeading('Section: Two')).toBe(normalizeHeading('section two'));
    expect(normalizeHeading('ＡＢＣ  [x]')).toBe('abc x');
  });
});

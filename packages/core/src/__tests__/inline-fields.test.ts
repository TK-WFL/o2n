import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseInlineFields } from '../inline-fields.js';
import { buildPlan } from '../planner.js';
import { scanVault } from '../scanner.js';
import { runMigration } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

describe('parseInlineFields（#146）', () => {
  it('行頭・リスト・引用・括弧の各形式を取り出し、値を整える', () => {
    expect(
      parseInlineFields(
        [
          'status:: doing',
          '- priority:: 2',
          '> **Due Date**:: 2026-10-01',
          '- [ ] task [owner:: [[Alice]]] and (done:: false)',
          'tag:: a',
          'tag:: b',
        ].join('\n'),
      ),
    ).toEqual({ status: 'doing', priority: 2, 'Due Date': '2026-10-01', owner: 'Alice', done: false, tag: ['a', 'b'] });
  });

  it('コードブロック・インラインコード内は無視し、:: を含まない行や不正なキーは対象外', () => {
    expect(parseInlineFields('```\nx:: 1\n```\n`y:: 2`\n普通の文\n[[link]]:: z\n:: noKey')).toEqual({});
  });

  it('大量の入力でも短時間で終える', () => {
    const started = Date.now();
    parseInlineFields(('[a' + '(b:: '.repeat(2000) + '\n').repeat(50) + ':'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('データベースモードでのインラインフィールド（#146）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-inline-')));
    await fs.mkdir(path.join(dir, 'Tasks'));
    for (const [n, st, pr] of [['a', 'todo', 1], ['b', 'doing', 2], ['c', 'done', 3]] as const) {
      await fs.writeFile(path.join(dir, 'Tasks', `${n}.md`), `---\nstatus: ${st}\n---\n# ${n}\n\npriority:: ${pr}\nowner:: [[Alice]]\n`);
    }
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('frontmatter が少なくてもインラインフィールドで DB 化が提案され、行のプロパティになる', async () => {
    const inv = await scanVault(dir);
    const plan = buildPlan(inv, { parentPageId: 'root-page' });
    expect(plan.folders.find((f) => f.folderPath === 'Tasks')?.mode).toBe('database');
    expect(plan.frontmatterMappings['Tasks']).toEqual([
      { key: 'priority', notionPropertyType: 'number' },
      { key: 'owner', notionPropertyType: 'rich_text' },
      { key: 'status', notionPropertyType: 'rich_text' },
    ]);

    const mock = createMockServer();
    const { inventory, api, state } = await setupMigration(dir, mock.fetchImpl);
    await runMigration({ vaultPath: dir, plan, inventory, api, state, dryRun: false });
    const rowB = mock.calls.find((c) => c.method === 'POST' && c.path === '/pages' && String((c.body as { markdown?: string }).markdown).includes('# b'));
    expect((rowB!.body as { properties: Record<string, unknown> }).properties).toMatchObject({
      priority: { number: 2 },
      owner: { rich_text: [{ text: { content: 'Alice' } }] },
      status: { rich_text: [{ text: { content: 'doing' } }] },
    });
  });

  it('inlineFields: false では従来通り frontmatter だけ', async () => {
    const inv = await scanVault(dir);
    const plan = buildPlan(inv, { parentPageId: 'root-page', inlineFields: false });
    expect(plan.folders.find((f) => f.folderPath === 'Tasks')?.mode).toBe('page_tree');
    expect(plan.inlineFields).toBe(false);
  });
});

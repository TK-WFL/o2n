import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanVault } from '../scanner.js';
import { buildPlan } from '../planner.js';
import { NotionClient, NotionApi } from '../notion-client.js';
import { StateStore, statePath } from '../state.js';
import { runMigration } from '../migrator.js';
import { createMockServer, withPageBlocksRewrite, type MockBlock } from './helpers/mock-notion.js';

let tmpDir: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-migrator-test-'));
  tmpDir = await fs.realpath(createdRoot);
  await fs.mkdir(path.join(tmpDir, 'Sub'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'Root.md'), '# Root\n\n[[Sub Note]]\n');
  await fs.writeFile(path.join(tmpDir, 'Sub', 'Sub Note.md'), '# Sub Note\n\n![[pic.png]]\n\n[[Root]]\n');
  await fs.writeFile(path.join(tmpDir, 'Sub', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('migrator 3パス統合テスト（モック）', () => {
  it('Pass1(ページ作成)→Pass2(リンク解決)→Pass3(添付解決)の順で呼ばれる', async () => {
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const pageCreateIdx = calls.findIndex((c) => c.method === 'POST' && c.path === '/pages');
    const linkPatchIdx = calls.findIndex(
      (c) => c.method === 'PATCH' && /markdown$/.test(c.path) && JSON.stringify(c.body).includes('update_content'),
    );
    const blockAppendIdx = calls.findIndex((c) => c.method === 'PATCH' && /blocks\/.+\/children$/.test(c.path));

    expect(pageCreateIdx).toBeGreaterThanOrEqual(0);
    expect(linkPatchIdx).toBeGreaterThan(pageCreateIdx);
    expect(blockAppendIdx).toBeGreaterThan(pageCreateIdx);

    const rootState = state.getNote('Root.md');
    const subState = state.getNote('Sub/Sub Note.md');
    expect(rootState?.status).toBe('done');
    expect(subState?.status).toBe('done');
  });

  it('箇条書き内の添付（bulleted_list_itemブロック）も正しく解決される（回帰テスト）', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'ListEmbed.md'),
      '# List Embed\n\n- 画像: ![[pic.png]]\n- リンク: [[Root]]\n',
    );
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(state.getNote('ListEmbed.md')?.status).toBe('done');
    expect(state.getFile('Sub/pic.png')?.status).toBe('attached');
    expect(calls.some((c) => c.method === 'DELETE' && /\/blocks\//.test(c.path))).toBe(true);
  });

  it('同じ添付ファイルへの2箇所以上の参照が両方とも解決される（回帰テスト）', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'DoubleEmbed.md'),
      '# Double Embed\n\n1つ目: ![[pic.png]]\n\n2つ目: ![[pic.png]]\n',
    );
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(state.getNote('DoubleEmbed.md')?.status).toBe('done');
    // 添付ブロック挿入(PATCH .../children)とプレースホルダー削除(DELETE)がそれぞれ2回ずつ呼ばれること
    const appendCalls = calls.filter((c) => c.method === 'PATCH' && /\/blocks\/.+\/children$/.test(c.path));
    const deleteCalls = calls.filter((c) => c.method === 'DELETE' && /\/blocks\//.test(c.path));
    expect(appendCalls.length).toBeGreaterThanOrEqual(2);
    expect(deleteCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('429を人工的に発生させてもバックオフして完走する', async () => {
    const { fetchImpl, triggerNext429, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    triggerNext429();
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(calls.some((c) => c.method === 'POST' && c.path === '/pages')).toBe(true);
    expect(state.getNote('Root.md')?.status).toBe('done');
  });

  it('dry-runでは書き込みAPIを一切呼ばない', async () => {
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', dryRun: true, fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page', { readOnly: true });

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: true });

    expect(calls.length).toBe(0);
    expect(client.callCount).toBeGreaterThan(0);
  });

  it('dry-runはstate.jsonをディスクに書き込まず、後続の本実行の判定を汚染しない（回帰テスト）', async () => {
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });

    // 1. dry-run実行（readOnly: true を渡す、CLI/MCPと同じ使い方）
    const dryClient = new NotionClient({ token: 'test', dryRun: true, fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const dryApi = new NotionApi(dryClient);
    const dryState = await StateStore.load(tmpDir, 'root-page', { readOnly: true });
    await runMigration({ vaultPath: tmpDir, plan, inventory, api: dryApi, state: dryState, dryRun: true });

    // ディスク上のstate.jsonが実際には作成されていないこと
    await expect(fs.readFile(statePath(tmpDir), 'utf-8')).rejects.toThrow();

    // 2. 本実行: 新しくstate.jsonを読み込んでも「未着手」のはずで、実際にAPIが呼ばれる
    const realClient = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const realApi = new NotionApi(realClient);
    const realState = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory, api: realApi, state: realState, dryRun: false });

    expect(calls.some((c) => c.method === 'POST' && c.path === '/pages')).toBe(true);
    expect(realState.getNote('Root.md')?.pageId).not.toMatch(/^dry-run/);
    expect(realState.getNote('Root.md')?.status).toBe('done');
  });

  it('Pass2(リンク解決)が失敗してもPass1で作成済みのページを再作成しない（回帰テスト）', async () => {
    const { fetchImpl, calls, triggerNextLinkPatch400 } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);

    // 1回目: Root.mdのPass2(リンク解決)を人工的に失敗させる
    const state1 = await StateStore.load(tmpDir, 'root-page');
    triggerNextLinkPatch400();
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state: state1, dryRun: false });

    const afterFirstRun = state1.getNote('Root.md');
    expect(afterFirstRun?.status).not.toBe('failed');
    expect(afterFirstRun?.pageId).toBeTruthy();
    const firstPageCreateCount = calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;

    // 2回目: resume。Pass1でRoot.mdのページが再作成されないこと
    const inventory2 = await scanVault(tmpDir);
    const state2 = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory: inventory2, api, state: state2, dryRun: false });

    const secondPageCreateCount = calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;
    expect(secondPageCreateCount).toBe(firstPageCreateCount);
    expect(state2.getNote('Root.md')?.pageId).toBe(afterFirstRun?.pageId);
    expect(state2.getNote('Root.md')?.status).toBe('done');
  });

  it("ノートがdoneでも、resumeで失敗した添付だけ再試行される（回帰テスト）", async () => {
    const { fetchImpl, calls, setAlwaysFailFileSend } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 }, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);

    // 1回目: 添付アップロードを常に失敗させる。ノート自体はdoneになる
    setAlwaysFailFileSend(true);
    const state1 = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state: state1, dryRun: false });

    expect(state1.getNote('Sub/Sub Note.md')?.status).toBe('done');
    expect(state1.getFile('Sub/pic.png')?.status).toBe('failed');

    // 2回目: resume。今度はアップロードを成功させる。ノートは既にdoneだが添付が再試行されること
    setAlwaysFailFileSend(false);
    const inventory2 = await scanVault(tmpDir);
    const state2 = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory: inventory2, api, state: state2, dryRun: false });

    expect(state2.getFile('Sub/pic.png')?.status).toBe('attached');
    expect(calls.some((c) => c.method === 'POST' && /\/file_uploads\/.+\/send$/.test(c.path))).toBe(true);
  });

  it('完了済みノートをresumeしても、貼り付け済み添付プレースホルダーを誤って警告しない（回帰テスト）', async () => {
    const { fetchImpl } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);

    // 1回目: 添付アップロード・貼り付けが正常に成功する
    const state1 = await StateStore.load(tmpDir, 'root-page');
    const report1 = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state: state1, dryRun: false });
    expect(state1.getFile('Sub/pic.png')?.status).toBe('attached');
    expect(report1.some((e) => e.category === 'warning' && e.message.includes('添付プレースホルダーが見つかりませんでした'))).toBe(false);

    // 2回目: resume。ノートは既にdoneで、プレースホルダーは1回目で削除済み。
    // Pass3は失敗した添付の再試行のために'done'ノートも再訪するが、
    // 既に貼り付け済みの箇所については誤警告を出してはならない。
    const inventory2 = await scanVault(tmpDir);
    const state2 = await StateStore.load(tmpDir, 'root-page');
    const report2 = await runMigration({ vaultPath: tmpDir, plan, inventory: inventory2, api, state: state2, dryRun: false });

    expect(report2.some((e) => e.category === 'warning' && e.message.includes('添付プレースホルダーが見つかりませんでした'))).toBe(false);
    expect(state2.getFile('Sub/pic.png')?.status).toBe('attached');
  });

  it('attachedPlaceholders未記録の旧state（本修正より前のバージョン）をresumeしても誤警告せず自己修復する（回帰テスト）', async () => {
    const { fetchImpl } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);

    const state1 = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state: state1, dryRun: false });

    // 本修正より前のstate.jsonを模倣: attachedPlaceholdersを持たない状態に書き換える
    const noteState = state1.getNote('Sub/Sub Note.md')!;
    await state1.setNote('Sub/Sub Note.md', { ...noteState, attachedPlaceholders: undefined });

    const inventory2 = await scanVault(tmpDir);
    const state2 = await StateStore.load(tmpDir, 'root-page');
    const report2 = await runMigration({ vaultPath: tmpDir, plan, inventory: inventory2, api, state: state2, dryRun: false });

    expect(report2.some((e) => e.category === 'warning' && e.message.includes('添付プレースホルダーが見つかりませんでした'))).toBe(false);
    expect(state2.getFile('Sub/pic.png')?.status).toBe('attached');
  });

  it('resumeは既完了ノートを二重作成しない', async () => {
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);

    const state1 = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state: state1, dryRun: false });
    const firstPageCreateCount = calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;

    const inventory2 = await scanVault(tmpDir);
    const state2 = await StateStore.load(tmpDir, 'root-page');
    await runMigration({ vaultPath: tmpDir, plan, inventory: inventory2, api, state: state2, dryRun: false });
    const secondPageCreateCount = calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;

    expect(secondPageCreateCount).toBe(firstPageCreateCount);
  });
});

describe('マルチパートアップロード', () => {
  it('パートサイズ超のファイルは part_number 付きで分割送信され、最後に /complete が呼ばれる', async () => {
    // 1 KiB のパートサイズを注入し、2.5 KiB のファイルで3パート経路を通す
    await fs.writeFile(path.join(tmpDir, 'Sub', 'big.pdf'), Buffer.alloc(2560, 1));
    await fs.writeFile(path.join(tmpDir, 'Big.md'), '# Big\n\n![[big.pdf]]\n');
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false, multipartPartSizeBytes: 1024 });

    const createIdx = calls.findIndex((c) => c.method === 'POST' && c.path === '/file_uploads' && (c.body as { filename?: string })?.filename === 'big.pdf');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(calls[createIdx]?.body).toMatchObject({ mode: 'multi_part', number_of_parts: 3, content_type: 'application/pdf' });

    const completeIdx = calls.findIndex((c, i) => i > createIdx && c.method === 'POST' && /\/file_uploads\/.+\/complete$/.test(c.path));
    expect(completeIdx).toBeGreaterThan(createIdx);

    // create と complete の間に、part_number 1..3 の send がこの順で並ぶ（他ファイルの single_part 送信は混ざらない）
    const between = calls.slice(createIdx + 1, completeIdx).filter((c) => c.method === 'POST' && /\/file_uploads\/.+\/send$/.test(c.path));
    expect(between.map((c) => c.form?.part_number)).toEqual(['1', '2', '3']);
    expect(state.getFile('Sub/big.pdf')?.status).toBe('attached');
  });

  it('パートサイズ以下のファイルは single_part で送られ /complete は呼ばれない', async () => {
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const create = calls.find((c) => c.method === 'POST' && c.path === '/file_uploads');
    expect(create?.body).toMatchObject({ mode: 'single_part' });
    expect(calls.some((c) => /\/complete$/.test(c.path))).toBe(false);
  });
});

/**
 * POST /pages 直後に、そのページのブロック構造を差し替える fetch ラッパー。
 * mock は本文中のプレースホルダー行しかブロック化しないため、100ブロック超やネスト構造を
 * 再現したいテストで使う（プレースホルダーを含まないページは対象外）。
 */
describe('添付プレースホルダーの探索（#66）', () => {
  it('100ブロック超のページでもページネーションして後半のプレースホルダーを見つける', async () => {
    // 先頭に段落を大量に置き、画像を最後に埋め込む（Notion実機では1回のGETは最大100件）
    const filler = Array.from({ length: 150 }, (_, i) => `段落 ${i}`).join('\n\n');
    await fs.writeFile(path.join(tmpDir, 'Long.md'), `# Long\n\n${filler}\n\n![[pic.png]]\n`);
    const mock = createMockServer();
    mock.setChildrenPageSize(100);
    // mock の POST /pages はプレースホルダー行しかブロック化しないので、段落ブロックを前に詰めて再現する
    const fetchImpl = withPageBlocksRewrite(mock, (id, existing) => [
      ...Array.from({ length: 150 }, (_, i): MockBlock => ({
        id: `${id}-filler-${i}`,
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: `段落 ${i}` } }] },
      })),
      ...existing,
    ]);
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(state.getNote('Long.md')?.status).toBe('done');
    expect(state.getNote('Long.md')?.attachedPlaceholders?.length).toBe(1);
    const childrenGets = mock.calls.filter((c) => c.method === 'GET' && /\/blocks\/page-.+\/children$/.test(c.path));
    // 151ブロック → 2ページ分のGETが行われている
    expect(childrenGets.length).toBeGreaterThanOrEqual(2);
    expect(mock.calls.some((c) => c.method === 'PATCH' && /\/blocks\/.+\/children$/.test(c.path))).toBe(true);
  });

  it('ネストしたリスト項目の子ブロックにあるプレースホルダーも見つける', async () => {
    await fs.writeFile(path.join(tmpDir, 'Nested.md'), '# Nested\n\n- 親\n  - ![[pic.png]]\n');
    const mock = createMockServer();
    // Notion実機の保存形態を再現: 親リスト項目(has_children) の子にプレースホルダー入りリスト項目
    const fetchImpl = withPageBlocksRewrite(mock, (id, existing) => [
      {
        id: `${id}-parent`,
        type: 'bulleted_list_item',
        has_children: true,
        bulleted_list_item: { rich_text: [{ text: { content: '親' } }] },
        children: existing.map((b) => ({ ...b, id: `${id}-child-0` })),
      },
    ]);
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(state.getNote('Nested.md')?.status).toBe('done');
    expect(state.getFile('Sub/pic.png')?.status).toBe('attached');
    // 子ブロック一覧の取得が親ブロックに対しても行われている
    expect(mock.calls.some((c) => c.method === 'GET' && /-parent\/children$/.test(c.path))).toBe(true);
    // 削除されたのは子側のプレースホルダーブロック
    expect(mock.calls.some((c) => c.method === 'DELETE' && /-child-0$/.test(c.path))).toBe(true);
  });

  it('プレースホルダーが複数あっても子ブロック一覧の取得はノートにつき1回にまとまる', async () => {
    await fs.writeFile(path.join(tmpDir, 'Multi.md'), '# Multi\n\n![[pic.png]]\n\n![[pic.png]]\n\n![[pic.png]]\n');
    const mock = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl: mock.fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    expect(state.getNote('Multi.md')?.attachedPlaceholders?.length).toBe(3);
    // ページごとの children GET は1回（3プレースホルダーで3回にならない）
    const gets = mock.calls.filter((c) => c.method === 'GET' && /\/blocks\/page-.+\/children$/.test(c.path));
    const byPage = new Map<string, number>();
    for (const g of gets) byPage.set(g.path, (byPage.get(g.path) ?? 0) + 1);
    for (const n of byPage.values()) expect(n).toBe(1);
  });
});

describe('databaseモード（#67）', () => {
  it('フォルダをDB化し、行は data_source_id 親で作成される。2000字超の値は切り詰めて本文冒頭に退避する', async () => {
    const dbDir = path.join(tmpDir, 'Tasks');
    await fs.mkdir(dbDir, { recursive: true });
    const long = 'ん'.repeat(2500);
    const fm = (status: string, extra = '') => `---\nstatus: ${status}\npriority: 1\ndue: 2026-01-01\n${extra}---\n\n本文\n`;
    await fs.writeFile(path.join(dbDir, 'A.md'), fm('todo'));
    await fs.writeFile(path.join(dbDir, 'B.md'), fm('doing'));
    await fs.writeFile(path.join(dbDir, 'C.md'), fm('done', `memo: "${long}"\n`));

    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    expect(plan.folders.find((f) => f.folderPath === 'Tasks')?.mode).toBe('database');
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const dbCreate = calls.find((c) => c.method === 'POST' && c.path === '/databases');
    expect(dbCreate?.body).toMatchObject({ parent: { type: 'page_id', page_id: 'root-page' } });
    const schema = (dbCreate?.body as { initial_data_source: { properties: Record<string, unknown> } }).initial_data_source.properties;
    expect(Object.keys(schema).sort()).toEqual(['Name', 'due', 'memo', 'priority', 'status']);

    const rows = calls.filter((c) => c.method === 'POST' && c.path === '/pages' && (c.body as { parent?: { type?: string } })?.parent?.type === 'data_source_id');
    expect(rows).toHaveLength(3);

    const rowC = rows.find((c) => String((c.body as { markdown?: string })?.markdown).includes(long));
    expect(rowC).toBeDefined();
    const props = (rowC!.body as { properties: Record<string, { rich_text?: Array<{ text: { content: string } }> }> }).properties;
    expect(props.memo!.rich_text![0]!.text.content.length).toBe(2000);
    // 退避 callout には切り詰めたキーだけが入り、正常なキーは重複しない
    const md = (rowC!.body as { markdown: string }).markdown;
    expect(md.startsWith('<callout')).toBe(true);
    expect(md).toContain(`memo: ${long}`);
    expect(md).not.toContain('status:');
    expect(report.some((e) => e.category === 'downgraded' && e.path === 'Tasks/C.md' && e.message.includes('memo'))).toBe(true);

    for (const p of ['Tasks/A.md', 'Tasks/B.md', 'Tasks/C.md']) expect(state.getNote(p)?.status).toBe('done');
  });
});

describe('aliases によるリンク解決（#77）', () => {
  it('[[別名]] は frontmatter aliases を持つノートのページリンクになり unresolved_link にならない', async () => {
    await fs.writeFile(path.join(tmpDir, 'Aliased.md'), '---\naliases:\n  - 別名A\n---\n# Aliased\n');
    await fs.writeFile(path.join(tmpDir, 'Linker.md'), '# Linker\n\n[[別名A]] と [[存在しない]]\n');
    const { fetchImpl, calls } = createMockServer();
    const inventory = await scanVault(tmpDir);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const client = new NotionClient({ token: 'test', fetchImpl, rateLimit: { concurrency: 5, interval: 10, intervalCap: 5 } });
    const api = new NotionApi(client);
    const state = await StateStore.load(tmpDir, 'root-page');

    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false });

    const aliasedPageId = state.getNote('Aliased.md')?.pageId;
    expect(aliasedPageId).toBeDefined();
    const linkPatch = calls.find(
      (c) => c.method === 'PATCH' && /markdown$/.test(c.path) && JSON.stringify(c.body).includes('別名A'),
    );
    expect(JSON.stringify(linkPatch?.body)).toContain(`notion.so/${aliasedPageId}`);
    expect(report.some((e) => e.category === 'unresolved_link' && e.message.includes('別名A'))).toBe(false);
    expect(report.some((e) => e.category === 'unresolved_link' && e.message.includes('存在しない'))).toBe(true);
  });
});

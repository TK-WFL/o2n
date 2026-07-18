import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanVault } from '../scanner.js';
import { buildPlan } from '../planner.js';
import { NotionClient, NotionApi } from '../notion-client.js';
import { StateStore, statePath } from '../state.js';
import { runMigration } from '../migrator.js';

interface CallRecord {
  method: string;
  path: string;
  body?: unknown;
}

function createMockServer() {
  const calls: CallRecord[] = [];
  let pageCounter = 0;
  const pageBlocks = new Map<string, Array<{ id: string; type: string; paragraph: { rich_text: Array<{ text: { content: string } }> } }>>();
  let failNextWith429 = false;
  let failNextLinkPatchWith400 = false;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method ?? 'GET') as string;
    const p = u.pathname.replace('/v1', '');
    const bodyText = init?.body;
    let body: unknown;
    if (typeof bodyText === 'string') {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = undefined;
      }
    }
    calls.push({ method, path: p, body });

    if (failNextWith429) {
      failNextWith429 = false;
      return new Response(JSON.stringify({ code: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    }

    if (
      failNextLinkPatchWith400 &&
      method === 'PATCH' &&
      /\/pages\/.+\/markdown$/.test(p) &&
      (body as { type?: string })?.type === 'update_content'
    ) {
      failNextLinkPatchWith400 = false;
      return new Response(JSON.stringify({ code: 'validation_error', message: 'boom' }), { status: 400 });
    }

    if (method === 'GET' && p === '/users/me') {
      return jsonResponse({ bot: { workspace_limits: { max_file_upload_size_in_bytes: 5 * 1024 * 1024 * 1024 } } });
    }

    if (method === 'POST' && p === '/pages') {
      pageCounter += 1;
      const id = `page-${pageCounter}`;
      const markdown = (body as { markdown?: string })?.markdown ?? '';
      const blocks = extractFileBlocks(markdown, id);
      pageBlocks.set(id, blocks);
      return jsonResponse({ id, url: `https://www.notion.so/${id}` });
    }

    if (method === 'PATCH' && /\/pages\/.+\/markdown$/.test(p)) {
      return jsonResponse({});
    }

    if (method === 'POST' && p === '/databases') {
      pageCounter += 1;
      const id = `db-${pageCounter}`;
      return jsonResponse({ id, data_sources: [{ id: `ds-${pageCounter}` }] });
    }

    if (method === 'GET' && /\/blocks\/.+\/children$/.test(p)) {
      const pageId = p.split('/')[2] ?? '';
      return jsonResponse({ results: pageBlocks.get(pageId) ?? [] });
    }

    if (method === 'PATCH' && /\/blocks\/.+\/children$/.test(p)) {
      return jsonResponse({ results: [{ id: 'appended-block' }] });
    }

    if (method === 'DELETE' && /\/blocks\//.test(p)) {
      return new Response(null, { status: 204 });
    }

    if (method === 'POST' && p === '/file_uploads') {
      return jsonResponse({ id: 'file-upload-1', upload_url: 'https://upload.example/1' });
    }

    if (method === 'POST' && /\/file_uploads\/.+\/send$/.test(p)) {
      return jsonResponse({ id: 'file-upload-1', status: 'uploaded' });
    }

    return jsonResponse({});
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    triggerNext429: () => { failNextWith429 = true; },
    triggerNextLinkPatch400: () => { failNextLinkPatchWith400 = true; },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function extractFileBlocks(markdown: string, pageId: string) {
  const blocks: Array<{ id: string; type: string; paragraph: { rich_text: Array<{ text: { content: string } }> } }> = [];
  const re = /⟦o2n:file:\d+⟧/g;
  let n = 0;
  for (const m of markdown.matchAll(re)) {
    blocks.push({
      id: `${pageId}-block-${n}`,
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: m[0] } }] },
    });
    n += 1;
  }
  return blocks;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-migrator-test-'));
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

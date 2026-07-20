#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  scanVault,
  runMigration,
  NotionClient,
  NotionApi,
  StateStore,
  writeReport,
  buildReport,
  reportPath,
  statePath,
  loadCredentials,
  assertObsidianVault,
  NotAnObsidianVaultError,
  type StateFile,
} from '@tk_wfl/o2n-core';
import { loadOrCreatePlan, savePlan } from './plan-store.js';
import { getJob, setJob } from './jobs.js';

const server = new McpServer({ name: 'o2n-mcp-server', version: '0.1.0' });

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

/** vaultPathが実際にObsidian vaultらしいディレクトリでなければエラーを返す（任意パスアクセス対策） */
async function guardVaultPath(vaultPath: string): Promise<{ error: ReturnType<typeof text> } | { error: null }> {
  try {
    await assertObsidianVault(vaultPath);
    return { error: null };
  } catch (err) {
    if (err instanceof NotAnObsidianVaultError) {
      return { error: text(err.message) };
    }
    throw err;
  }
}

server.tool(
  'scan_vault',
  'Obsidian vaultを走査してインベントリ要約を返す。副作用なし（読み取りのみ）。',
  { vaultPath: z.string().describe('Obsidian vaultの絶対パス') },
  async ({ vaultPath }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const inventory = await scanVault(vaultPath);
    const summary = {
      vaultPath: inventory.vaultPath,
      noteCount: inventory.notes.length,
      attachmentCount: inventory.attachments.length,
      wikiLinkCount: inventory.wikiLinks.length,
      skippedCount: inventory.skipped.length,
      warningCount: inventory.warnings.length,
      folders: Object.fromEntries(Object.entries(inventory.folderTree).map(([k, v]) => [k || '(root)', v.length])),
      frontmatterKeyStats: inventory.frontmatterKeyStats,
    };
    return text(JSON.stringify(summary, null, 2));
  },
);

server.tool(
  'get_plan',
  '現在の移行計画を返す。存在しなければ自動提案から新規生成する。副作用: 計画ファイルが未作成の場合は作成する。',
  {
    vaultPath: z.string().describe('Obsidian vaultの絶対パス'),
    parentPageId: z.string().optional().describe('移行先のNotion親ページID（未指定なら既存計画の値を使う）'),
  },
  async ({ vaultPath, parentPageId }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const plan = await loadOrCreatePlan(vaultPath, parentPageId);
    return text(JSON.stringify(plan, null, 2));
  },
);

const folderPlanSchema = z.object({
  folderPath: z.string(),
  mode: z.enum(['page_tree', 'database']),
  suggestionReason: z.string().optional(),
});

server.tool(
  'update_plan',
  '移行計画を部分更新する（folders・parentPageId・skipListなど）。',
  {
    vaultPath: z.string().describe('Obsidian vaultの絶対パス'),
    patch: z
      .object({
        parentPageId: z.string().optional(),
        folders: z.array(folderPlanSchema).optional(),
        skipList: z.array(z.string()).optional(),
      })
      .describe('計画への部分更新'),
  },
  async ({ vaultPath, patch }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const plan = await loadOrCreatePlan(vaultPath);
    if (patch.parentPageId) plan.parentPageId = patch.parentPageId;
    if (patch.folders) plan.folders = patch.folders;
    if (patch.skipList) plan.skipList = patch.skipList;
    await savePlan(vaultPath, plan);
    return text(JSON.stringify(plan, null, 2));
  },
);

server.tool(
  'start_migration',
  '移行を開始する（バックグラウンド実行）。呼び出し前に必ずユーザーへ移行内容（対象vault・移行先ページ・dry-runか否か）を提示し、' +
    '明示的な確認を得ること。ユーザーの明示的な確認なしに呼び出さないこと。進捗は migration_status で確認する。',
  {
    vaultPath: z.string().describe('Obsidian vaultの絶対パス'),
    parentPageId: z.string().describe('移行先のNotion親ページID'),
    dryRun: z.boolean().default(false).describe('trueの場合、書き込みAPIを呼ばずシミュレーションのみ行う'),
  },
  async ({ vaultPath, parentPageId, dryRun }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const resolved = path.resolve(vaultPath);
    const existing = getJob(resolved);
    if (existing?.status === 'running') {
      return text(`既に移行が実行中です（進捗 ${existing.done}/${existing.total}）。migration_status で確認してください。`);
    }

    const inventory = await scanVault(resolved);
    const plan = await loadOrCreatePlan(resolved, parentPageId);
    const estimateSeconds = Math.ceil((inventory.notes.length + inventory.attachments.length) * 3 * 0.4);

    setJob(resolved, { status: 'running', done: 0, total: inventory.notes.length, currentPath: '', startedAt: Date.now() });

    void (async () => {
      try {
        const token = process.env.NOTION_TOKEN ?? (await loadCredentials())?.token ?? (dryRun ? 'dry-run-placeholder-token' : '');
        if (!token) throw new Error('Notionと連携されていません。CLIで `o2n login` を実行するか、NOTION_TOKEN を設定してください。');
        const client = new NotionClient({ token, dryRun });
        const api = new NotionApi(client);
        const state = await StateStore.load(resolved, plan.parentPageId, { readOnly: dryRun });
        const entries = await runMigration({
          vaultPath: resolved,
          plan,
          inventory,
          api,
          state,
          dryRun,
          onProgress: (done, total, currentPath) => {
            setJob(resolved, { status: 'running', done, total, currentPath, startedAt: getJob(resolved)?.startedAt ?? Date.now() });
          },
        });
        const report = buildReport(state.snapshot, entries);
        await writeReport(resolved, report, state.snapshot);
        setJob(resolved, {
          status: 'done',
          done: inventory.notes.length,
          total: inventory.notes.length,
          currentPath: '',
          startedAt: getJob(resolved)?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
        });
      } catch (err) {
        setJob(resolved, {
          status: 'error',
          done: getJob(resolved)?.done ?? 0,
          total: inventory.notes.length,
          currentPath: '',
          error: String(err),
          startedAt: getJob(resolved)?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
        });
      }
    })();

    return text(
      `移行を開始しました（${dryRun ? 'dry-run' : '本実行'}）。対象: ${inventory.notes.length}ノート・${inventory.attachments.length}添付。` +
        `推定所要時間: 約${Math.ceil(estimateSeconds / 60)}分。migration_status で進捗を確認してください。`,
    );
  },
);

server.tool(
  'migration_status',
  '進行中/完了した移行の進捗（done / failed / pending件数、現在のパス）を返す。',
  { vaultPath: z.string().describe('Obsidian vaultの絶対パス') },
  async ({ vaultPath }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const resolved = path.resolve(vaultPath);
    const job = getJob(resolved);
    let stateSummary: Record<string, number> = {};
    try {
      const raw = await fs.readFile(statePath(resolved), 'utf-8');
      const state = JSON.parse(raw) as StateFile;
      stateSummary = Object.values(state.notes).reduce<Record<string, number>>((acc, n) => {
        acc[n.status] = (acc[n.status] ?? 0) + 1;
        return acc;
      }, {});
    } catch {
      // state.json未作成
    }
    return text(JSON.stringify({ job: job ?? { status: 'not_started' }, noteStatusCounts: stateSummary }, null, 2));
  },
);

server.tool(
  'get_report',
  'レポート（.o2n/report.md）の内容を返す。',
  { vaultPath: z.string().describe('Obsidian vaultの絶対パス') },
  async ({ vaultPath }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    try {
      const content = await fs.readFile(reportPath(vaultPath), 'utf-8');
      return text(content);
    } catch {
      return text('レポートがまだ生成されていません。start_migration の完了後に再度お試しください。');
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

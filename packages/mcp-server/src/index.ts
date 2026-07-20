#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
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
  readVaultStateFile,
  loadCredentials,
  assertObsidianVault,
  NotAnObsidianVaultError,
  VaultNotAllowedError,
  parseStateFile,
  planHash,
  type StateFile,
} from '@tk_wfl/o2n-core';
import { loadOrCreatePlan, savePlan } from './plan-store.js';
import { getJob, setJob } from './jobs.js';

const server = new McpServer({ name: 'o2n-mcp-server', version: '0.1.0' });

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

interface PreparedMigration {
  requestId: string;
  vaultPath: string;
  parentPageId: string;
  planHash: string;
  noteCount: number;
  attachmentCount: number;
  dryRun: boolean;
  createdAt: number;
}

const PREPARE_TTL_MS = 10 * 60 * 1000;
const preparedMigrations = new Map<string, PreparedMigration>();

function allowedVaultRoots(): string[] | null {
  const raw = process.env.O2N_ALLOWED_VAULTS;
  if (!raw) return null;
  const roots = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return roots.length > 0 ? roots : null;
}

function mcpWriteEnabled(): boolean {
  return process.env.O2N_ENABLE_MCP_WRITE === '1';
}

function writeTokenMatches(token: string): boolean {
  const configured = process.env.O2N_MCP_WRITE_TOKEN;
  return configured !== undefined && configured.length >= 16 && token === configured;
}

/** vaultPathが実際にObsidian vaultらしいディレクトリでなければエラーを返す（任意パスアクセス対策） */
async function guardVaultPath(vaultPath: string): Promise<{ error: ReturnType<typeof text> } | { error: null; vaultPath: string }> {
  try {
    const roots = allowedVaultRoots();
    if (!roots) {
      return { error: text('O2N_ALLOWED_VAULTS が未設定のため、MCPからのvaultアクセスを拒否しました。許可するvaultの実パスをカンマ区切りで設定してください。') };
    }
    const resolved = await assertObsidianVault(vaultPath, { allowedVaultRoots: roots });
    return { error: null, vaultPath: resolved };
  } catch (err) {
    if (err instanceof NotAnObsidianVaultError || err instanceof VaultNotAllowedError) {
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
    const inventory = await scanVault(guard.vaultPath);
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
    const plan = await loadOrCreatePlan(guard.vaultPath, parentPageId);
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
  '移行計画を部分更新する（folders・parentPageId・skipListなど）。O2N_ENABLE_MCP_WRITE=1 と確認トークンが必要。',
  {
    vaultPath: z.string().describe('Obsidian vaultの絶対パス'),
    patch: z
      .object({
        parentPageId: z.string().optional(),
        folders: z.array(folderPlanSchema).optional(),
        skipList: z.array(z.string()).optional(),
        confirmationToken: z.string().optional(),
      })
      .describe('計画への部分更新'),
  },
  async ({ vaultPath, patch }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    if (!mcpWriteEnabled()) return text('MCPからの計画更新は無効です。O2N_ENABLE_MCP_WRITE=1 を設定してください。');
    if (!patch.confirmationToken || !writeTokenMatches(patch.confirmationToken)) return text('confirmationToken が一致しないため、計画更新を拒否しました。');
    const plan = await loadOrCreatePlan(guard.vaultPath);
    if (patch.parentPageId) plan.parentPageId = patch.parentPageId;
    if (patch.folders) plan.folders = patch.folders;
    if (patch.skipList) plan.skipList = patch.skipList;
    await savePlan(guard.vaultPath, plan);
    return text(JSON.stringify(plan, null, 2));
  },
);

server.tool(
  'prepare_migration',
  '移行内容を固定し、commit_migrationで使用するrequestIdを返す。ここではNotionへの書き込みを開始しない。',
  {
    vaultPath: z.string().describe('Obsidian vaultの絶対パス'),
    parentPageId: z.string().describe('移行先のNotion親ページID'),
    dryRun: z.boolean().default(true).describe('trueの場合、書き込みAPIを呼ばずシミュレーションのみ行う'),
  },
  async ({ vaultPath, parentPageId, dryRun }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const resolved = guard.vaultPath;
    if (!dryRun && !mcpWriteEnabled()) {
      return text('MCPからの本実行は無効です。O2N_ENABLE_MCP_WRITE=1 と O2N_MCP_WRITE_TOKEN を設定し、commit_migrationで確認トークンを渡してください。');
    }

    const inventory = await scanVault(resolved);
    const plan = await loadOrCreatePlan(resolved, parentPageId);
    const request: PreparedMigration = {
      requestId: crypto.randomUUID(),
      vaultPath: resolved,
      parentPageId: plan.parentPageId,
      planHash: planHash(plan),
      noteCount: inventory.notes.length,
      attachmentCount: inventory.attachments.length,
      dryRun,
      createdAt: Date.now(),
    };
    preparedMigrations.set(request.requestId, request);

    return text(
      JSON.stringify(
        {
          requestId: request.requestId,
          vaultPath: request.vaultPath,
          parentPageId: request.parentPageId,
          dryRun: request.dryRun,
          noteCount: request.noteCount,
          attachmentCount: request.attachmentCount,
          planHash: request.planHash,
          commitInstructions: dryRun
            ? 'commit_migration に requestId を渡すとdry-runを開始します。'
            : '本実行には O2N_ENABLE_MCP_WRITE=1 と O2N_MCP_WRITE_TOKEN に一致する confirmationToken が必要です。',
        },
        null,
        2,
      ),
    );
  },
);

async function startMigrationJob(resolved: string, parentPageId: string, dryRun: boolean): Promise<string> {
  const existing = getJob(resolved);
  if (existing?.status === 'running') {
    return `既に移行が実行中です（進捗 ${existing.done}/${existing.total}）。migration_status で確認してください。`;
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
        const me = dryRun ? undefined : await api.getMe();
        const state = await StateStore.load(resolved, plan.parentPageId, {
          readOnly: dryRun,
          planHash: planHash(plan),
          notionWorkspaceId: dryRun ? undefined : (me?.bot?.workspace_name ?? 'unknown-workspace'),
          notionBotId: dryRun ? undefined : (me?.id ?? 'unknown-bot'),
          allowUnsignedState: false,
        });
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

  return (
    `移行を開始しました（${dryRun ? 'dry-run' : '本実行'}）。対象: ${inventory.notes.length}ノート・${inventory.attachments.length}添付。` +
    `推定所要時間: 約${Math.ceil(estimateSeconds / 60)}分。migration_status で進捗を確認してください。`
  );
}

server.tool(
  'commit_migration',
  'prepare_migrationで固定した内容を実行する。dry-run以外はO2N_MCP_WRITE_TOKENと一致するconfirmationTokenが必須。',
  {
    requestId: z.string().describe('prepare_migrationが返したrequestId'),
    confirmationToken: z.string().optional().describe('本実行時にO2N_MCP_WRITE_TOKENと一致している必要がある確認トークン'),
  },
  async ({ requestId, confirmationToken }) => {
    const prepared = preparedMigrations.get(requestId);
    if (!prepared) return text('requestId が見つかりません。prepare_migration をやり直してください。');
    if (Date.now() - prepared.createdAt > PREPARE_TTL_MS) {
      preparedMigrations.delete(requestId);
      return text('requestId の有効期限が切れました。prepare_migration をやり直してください。');
    }
    if (!prepared.dryRun) {
      if (!mcpWriteEnabled()) return text('MCPからの本実行は無効です。O2N_ENABLE_MCP_WRITE=1 を設定してください。');
      if (!confirmationToken || !writeTokenMatches(confirmationToken)) return text('confirmationToken が一致しないため、本実行を拒否しました。');
    }
    const inventory = await scanVault(prepared.vaultPath);
    const plan = await loadOrCreatePlan(prepared.vaultPath, prepared.parentPageId);
    if (planHash(plan) !== prepared.planHash || inventory.notes.length !== prepared.noteCount || inventory.attachments.length !== prepared.attachmentCount) {
      preparedMigrations.delete(requestId);
      return text('prepare_migration後に計画またはvault内容が変わったため、実行を拒否しました。prepare_migrationをやり直してください。');
    }
    preparedMigrations.delete(requestId);
    return text(await startMigrationJob(prepared.vaultPath, prepared.parentPageId, prepared.dryRun));
  },
);

server.tool(
  'start_migration',
  '廃止済み。安全な2段階フローの prepare_migration → commit_migration を使用してください。',
  {
    vaultPath: z.string().describe('Obsidian vaultの絶対パス'),
    parentPageId: z.string().describe('移行先のNotion親ページID'),
    dryRun: z.boolean().default(true).describe('互換性のための引数。実行はされません。'),
  },
  async () => {
    return text('start_migration は安全上の理由で無効化されました。prepare_migration で内容を固定し、commit_migration で実行してください。');
  },
);

server.tool(
  'migration_status',
  '進行中/完了した移行の進捗（done / failed / pending件数、現在のパス）を返す。',
  { vaultPath: z.string().describe('Obsidian vaultの絶対パス') },
  async ({ vaultPath }) => {
    const guard = await guardVaultPath(vaultPath);
    if (guard.error) return guard.error;
    const resolved = guard.vaultPath;
    const job = getJob(resolved);
    let stateSummary: Record<string, number> = {};
    try {
      const raw = await readVaultStateFile(resolved, 'state.json');
      const state: StateFile = parseStateFile(JSON.parse(raw));
      stateSummary = Object.values(state.notes).reduce<Record<string, number>>((acc, n) => {
        acc[n.status] = (acc[n.status] ?? 0) + 1;
        return acc;
      }, {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
      const content = await readVaultStateFile(guard.vaultPath, 'report.md');
      return text(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return text('レポートがまだ生成されていません。start_migration の完了後に再度お試しください。');
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

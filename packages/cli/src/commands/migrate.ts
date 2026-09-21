import path from 'node:path';
import {
  atomicWriteVaultStateFile,
  scanVault,
  runMigration,
  wasAbortedByBlockLimit,
  NotionClient,
  NotionApi,
  StateStore,
  writeReport,
  buildReport,
  parseMigrationPlan,
  planHash,
  readRegularFileNoFollow,
  readVaultStateFile,
  type MigrationPlan,
  type ReportEntry,
  rateLimitFromEnv,
  reportPath,
} from '@tk_wfl/o2n-core';
import { getToken } from '../token.js';

export interface MigrateCommandOptions {
  /** 省略時は <vaultPath>/.o2n/plan.json */
  plan?: string;
  quiet?: boolean;
  parent?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * 進捗表示（#116）: TTY なら同じ行を \\r で上書き、パイプ/ログなら 10% ごとに1行出す。
 * --quiet では何も出さない
 */
export function progressPrinter(quiet: boolean): (done: number, total: number, notePath: string) => void {
  if (quiet) return () => undefined;
  if (process.stdout.isTTY) {
    return (done, total, notePath) => process.stdout.write(`\r進捗: ${done}/${total} (${notePath})${' '.repeat(20)}`);
  }
  let lastBucket = -1;
  return (done, total) => {
    const bucket = total === 0 ? 10 : Math.floor((done * 10) / total);
    if (bucket !== lastBucket || done === total) {
      lastBucket = bucket;
      console.log(`進捗: ${done}/${total}`);
    }
  };
}

/** exit code: 0=全件成功, 1=一部failed, 2=致命的エラー */
export async function migrateCommand(vaultPath: string, opts: MigrateCommandOptions): Promise<number> {
  const dryRun = opts.dryRun ?? false;
  const planOption = opts.plan ?? path.join(vaultPath, '.o2n', 'plan.json');
  let plan: MigrationPlan;
  try {
    const vaultPlanPath = path.resolve(vaultPath, '.o2n', 'plan.json');
    const raw = path.resolve(planOption) === vaultPlanPath
      ? await readVaultStateFile(vaultPath, 'plan.json')
      : await readRegularFileNoFollow(planOption);
    plan = parseMigrationPlan(JSON.parse(raw));
  } catch (err) {
    const hint = opts.plan ? '' : '\n先に `o2n plan <vaultPath> --parent <NotionページID>` で計画を作成してください。';
    console.error(`計画ファイルの読み込みに失敗しました: ${planOption}\n${String(err)}${hint}`);
    return 2;
  }
  if (opts.parent) plan.parentPageId = opts.parent;

  // resumeで使えるよう vault内にも計画を保存する（dry-run は前回の本番計画を上書きしない、#110）
  if (!dryRun) {
    await atomicWriteVaultStateFile(vaultPath, 'plan.json', JSON.stringify(plan, null, 2));
  }

  const token = await getToken(dryRun);
  const inventory = await scanVault(vaultPath);
  const client = new NotionClient({ token, dryRun, rateLimit: rateLimitFromEnv() });
  const api = new NotionApi(client);
  const me = dryRun ? undefined : await api.getMe();
  const state = await StateStore.load(vaultPath, plan.parentPageId, {
    readOnly: dryRun,
    planHash: planHash(plan),
    notionWorkspaceId: dryRun ? undefined : (me?.bot?.workspace_name ?? 'unknown-workspace'),
    notionBotId: dryRun ? undefined : (me?.id ?? 'unknown-bot'),
    allowUnsignedState: false,
  });

  console.log(dryRun ? '[dry-run] 移行を開始します（書き込みAPIは呼ばれません）' : '移行を開始します');
  const total = inventory.notes.length;

  const startedAt = Date.now();
  const before = Object.fromEntries(Object.entries(state.snapshot.notes).map(([p, n]) => [p, { status: n.status, contentHash: n.contentHash }]));
  const entries: ReportEntry[] = await runMigration({
    vaultPath,
    plan,
    inventory,
    api,
    state,
    dryRun,
    onProgress: progressPrinter(opts.quiet ?? false),
  });
  if (!opts.quiet && process.stdout.isTTY) process.stdout.write('\n');
  void total;

  const report = buildReport(state.snapshot, entries, { startedAt, finishedAt: Date.now(), apiCalls: api.callCount, dryRun, before });
  await writeReport(vaultPath, report, state.snapshot, dryRun);

  const failedCount = Object.values(state.snapshot.notes).filter((n) => n.status === 'failed').length;
  console.log(`\n成功: ${report.successCount}件 / 失敗: ${failedCount}件`);
  console.log(`レポート: ${reportPath(vaultPath, dryRun)}`);
  if (wasAbortedByBlockLimit(entries)) {
    const aborted = entries.find((e) => e.category === 'aborted');
    console.error(`\n⚠ ${aborted?.message ?? '移行を中断しました'}`);
  }

  if (opts.verbose) {
    for (const e of entries) console.log(`  [${e.category}] ${e.path}: ${e.message}`);
  }

  return failedCount > 0 || wasAbortedByBlockLimit(entries) ? 1 : 0;
}

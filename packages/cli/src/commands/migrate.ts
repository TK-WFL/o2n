import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  scanVault,
  runMigration,
  NotionClient,
  NotionApi,
  StateStore,
  writeReport,
  buildReport,
  parseMigrationPlan,
  planHash,
  type MigrationPlan,
  type ReportEntry,
} from '@tk_wfl/o2n-core';
import { getToken } from '../token.js';

export interface MigrateCommandOptions {
  plan: string;
  parent?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

/** exit code: 0=全件成功, 1=一部failed, 2=致命的エラー */
export async function migrateCommand(vaultPath: string, opts: MigrateCommandOptions): Promise<number> {
  const dryRun = opts.dryRun ?? false;
  let plan: MigrationPlan;
  try {
    plan = parseMigrationPlan(JSON.parse(await fs.readFile(opts.plan, 'utf-8')));
  } catch (err) {
    console.error(`計画ファイルの読み込みに失敗しました: ${opts.plan}\n${String(err)}`);
    return 2;
  }
  if (opts.parent) plan.parentPageId = opts.parent;

  // resumeで使えるよう vault内にも計画を保存する
  const planCopyPath = path.join(vaultPath, '.o2n', 'plan.json');
  await fs.mkdir(path.dirname(planCopyPath), { recursive: true });
  await fs.writeFile(planCopyPath, JSON.stringify(plan, null, 2), 'utf-8');

  const token = await getToken(dryRun);
  const inventory = await scanVault(vaultPath);
  const client = new NotionClient({ token, dryRun });
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

  const entries: ReportEntry[] = await runMigration({
    vaultPath,
    plan,
    inventory,
    api,
    state,
    dryRun,
    onProgress: (done, t, notePath) => {
      process.stdout.write(`\r進捗: ${done}/${t} (${notePath})${' '.repeat(20)}`);
      void total;
    },
  });
  process.stdout.write('\n');

  const report = buildReport(state.snapshot, entries);
  await writeReport(vaultPath, report, state.snapshot);

  const failedCount = Object.values(state.snapshot.notes).filter((n) => n.status === 'failed').length;
  console.log(`\n成功: ${report.successCount}件 / 失敗: ${failedCount}件`);
  console.log(`レポート: ${path.join(vaultPath, '.o2n', 'report.md')}`);

  if (opts.verbose) {
    for (const e of entries) console.log(`  [${e.category}] ${e.path}: ${e.message}`);
  }

  return failedCount > 0 ? 1 : 0;
}

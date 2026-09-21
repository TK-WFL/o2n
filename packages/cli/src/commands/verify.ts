import {
  NotionApi,
  NotionClient,
  deepVerifyNotes,
  rateLimitFromEnv,
  readVaultStateFile,
  scanVault,
  summarizeState,
  type StateFile,
} from '@tk_wfl/o2n-core';
import { getToken } from '../token.js';

export interface VerifyCommandOptions {
  /** Notion の実ページを取得して照合する（1ノート1リクエスト、読み取りのみ） */
  deep?: boolean;
  /** 結果を JSON で出力する */
  json?: boolean;
}

export async function verifyCommand(vaultPath: string, opts: VerifyCommandOptions = {}): Promise<number> {
  let state: StateFile;
  try {
    state = JSON.parse(await readVaultStateFile(vaultPath, 'state.json')) as StateFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.error('state.jsonが見つかりません。先に migrate を実行してください。');
    return 2;
  }

  const inventory = await scanVault(vaultPath);
  const summary = summarizeState(state, inventory);
  const c = summary.counts;

  if (opts.json) {
    let deep: unknown;
    if (opts.deep) {
      const token = await getToken(false);
      const api = new NotionApi(new NotionClient({ token, dryRun: false, rateLimit: rateLimitFromEnv() }));
      deep = await deepVerifyNotes(api, state, { orphaned: summary.orphaned });
    }
    console.log(JSON.stringify({ ...summary, deep }, null, 2));
    const deepCount = (deep as { issues?: unknown[] } | undefined)?.issues?.length ?? 0;
    return c.failed > 0 || summary.untracked.length > 0 || deepCount > 0 ? 1 : 0;
  }

  console.log(`vaultノート数: ${summary.vaultNoteCount}`);
  console.log(`state記録ノート数: ${summary.trackedNoteCount}`);
  console.log(`  done: ${c.done} / linked: ${c.linked} / created: ${c.created} / failed: ${c.failed} / skipped: ${c.skipped}`);

  if (summary.untracked.length > 0) {
    console.log(`\n未着手のノート (${summary.untracked.length}件):`);
    for (const n of summary.untracked.slice(0, 20)) console.log(`  - ${n}`);
    if (summary.untracked.length > 20) console.log(`  ...他${summary.untracked.length - 20}件`);
  }

  if (summary.orphaned.length > 0) {
    console.log(`\nvault から削除済みのノート (${summary.orphaned.length}件。Notion 上のページは残っている可能性があります):`);
    for (const o of summary.orphaned.slice(0, 20)) console.log(`  - ${o.path}${o.pageUrl ? `  ${o.pageUrl}` : ''}`);
    if (summary.orphaned.length > 20) console.log(`  ...他${summary.orphaned.length - 20}件`);
  }

  let deepIssues = 0;
  if (opts.deep) {
    const token = await getToken(false);
    const api = new NotionApi(new NotionClient({ token, dryRun: false, rateLimit: rateLimitFromEnv() }));
    const result = await deepVerifyNotes(api, state, {
      orphaned: summary.orphaned,
      onProgress: (done, total, notePath) => {
        if (process.stdout.isTTY) process.stdout.write(`\r実ページ照合: ${done}/${total} (${notePath})${' '.repeat(20)}`);
      },
    });
    if (process.stdout.isTTY) process.stdout.write('\n');
    console.log(`\nNotion 実ページ照合: ${result.checked}件を確認、不一致 ${result.issues.length}件`);
    for (const issue of result.issues) console.log(`  [${issue.kind}] ${issue.path}: ${issue.message}`);
    deepIssues = result.issues.length;
  }

  return c.failed > 0 || summary.untracked.length > 0 || deepIssues > 0 ? 1 : 0;
}

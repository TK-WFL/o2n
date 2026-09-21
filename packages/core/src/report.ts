import path from 'node:path';
import { stateDir } from './state.js';
import type { MigrationReport, MigrationRunMeta, NoteStatus, ReportEntry, StateFile } from './types.js';
import { atomicWriteVaultStateFile } from './local-state-io.js';

/** dry-run のレポートは別ファイルに書き、本番のレポートを上書きしない（#110） */
export function reportFileName(dryRun = false): 'report.md' | 'report.dry-run.md' {
  return dryRun ? 'report.dry-run.md' : 'report.md';
}

export function reportPath(vaultPath: string, dryRun = false): string {
  return path.join(stateDir(vaultPath), reportFileName(dryRun));
}

const CATEGORY_LABEL: Record<ReportEntry['category'], string> = {
  skipped: 'スキップ',
  unresolved_link: '未解決リンク',
  oversized_file: 'サイズ超過ファイル',
  downgraded: '降格変換',
  warning: '警告',
  aborted: '中断',
};

export function buildReport(state: StateFile, entries: ReportEntry[], run?: MigrationRunMeta): MigrationReport {
  const successCount = Object.values(state.notes).filter((n) => n.status === 'done').length;
  return { successCount, entries, ...(run ? { run } : {}) };
}

/** 実行前後の state から「今回の実行で何が起きたか」を数える（#118） */
export function diffRun(before: MigrationRunMeta['before'], state: StateFile): { created: string[]; updated: string[]; unchanged: string[]; failed: string[] } {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const failed: string[] = [];
  for (const [p, n] of Object.entries(state.notes)) {
    const raw = before[p];
    const prev = raw === undefined ? undefined : typeof raw === 'string' ? { status: raw as NoteStatus } : raw;
    if (n.status === 'failed') failed.push(p);
    else if (n.status === 'skipped') continue;
    else if (prev === undefined) created.push(p);
    else if (prev.status === 'done' && n.status === 'done' && (prev.contentHash === undefined || prev.contentHash === n.contentHash)) unchanged.push(p);
    else updated.push(p);
  }
  return { created, updated, unchanged, failed };
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${s % 60}秒`;
}

export function renderReportMarkdown(report: MigrationReport, state: StateFile): string {
  const lines: string[] = [];
  lines.push('# Migration Report', '');
  lines.push(`- 成功: ${report.successCount}件`);
  const failed = Object.entries(state.notes).filter(([, n]) => n.status === 'failed');
  const skipped = Object.entries(state.notes).filter(([, n]) => n.status === 'skipped');
  lines.push(`- 失敗: ${failed.length}件`);
  lines.push(`- スキップ: ${skipped.length}件`);
  if (report.run) {
    const r = report.run;
    lines.push(`- 実行: ${new Date(r.startedAt).toISOString()} 〜 ${formatDuration(r.finishedAt - r.startedAt)}${r.dryRun ? '（dry-run）' : ''}、API呼び出し ${r.apiCalls.toLocaleString()} 回`);
  }
  lines.push('');

  if (report.run) {
    const d = diffRun(report.run.before, state);
    lines.push('## 今回の実行', '');
    lines.push(`- 新規作成: ${d.created.length}件 / 更新・再開: ${d.updated.length}件 / 変更なし: ${d.unchanged.length}件 / 失敗: ${d.failed.length}件`);
    lines.push('');
  }

  const done = Object.entries(state.notes).filter(([, n]) => n.status === 'done' && n.pageUrl);
  if (done.length > 0) {
    lines.push('<details>', `<summary>移行済みノートと Notion ページ (${done.length}件)</summary>`, '');
    for (const [p, n] of done) lines.push(`- \`${p}\`: ${n.pageUrl}`);
    lines.push('', '</details>', '');
  }

  for (const category of Object.keys(CATEGORY_LABEL) as ReportEntry['category'][]) {
    const items = report.entries.filter((e) => e.category === category);
    if (items.length === 0) continue;
    lines.push(`## ${CATEGORY_LABEL[category]} (${items.length}件)`, '');
    for (const item of items) {
      lines.push(`- \`${item.path}\`: ${item.message}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('## 失敗ノート', '');
    for (const [notePath, s] of failed) {
      lines.push(`- \`${notePath}\`: ${s.error ?? '不明なエラー'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeReport(vaultPath: string, report: MigrationReport, state: StateFile, dryRun = false): Promise<void> {
  await atomicWriteVaultStateFile(vaultPath, reportFileName(dryRun), renderReportMarkdown(report, state));
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stateDir } from './state.js';
import type { MigrationReport, ReportEntry, StateFile } from './types.js';

export function reportPath(vaultPath: string): string {
  return path.join(stateDir(vaultPath), 'report.md');
}

const CATEGORY_LABEL: Record<ReportEntry['category'], string> = {
  skipped: 'スキップ',
  unresolved_link: '未解決リンク',
  oversized_file: 'サイズ超過ファイル',
  downgraded: '降格変換',
  warning: '警告',
};

export function buildReport(state: StateFile, entries: ReportEntry[]): MigrationReport {
  const successCount = Object.values(state.notes).filter((n) => n.status === 'done').length;
  return { successCount, entries };
}

export function renderReportMarkdown(report: MigrationReport, state: StateFile): string {
  const lines: string[] = [];
  lines.push('# Migration Report', '');
  lines.push(`- 成功: ${report.successCount}件`);
  const failed = Object.entries(state.notes).filter(([, n]) => n.status === 'failed');
  const skipped = Object.entries(state.notes).filter(([, n]) => n.status === 'skipped');
  lines.push(`- 失敗: ${failed.length}件`);
  lines.push(`- スキップ: ${skipped.length}件`);
  lines.push('');

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

export async function writeReport(vaultPath: string, report: MigrationReport, state: StateFile): Promise<void> {
  const dir = stateDir(vaultPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(reportPath(vaultPath), renderReportMarkdown(report, state), 'utf-8');
}

import { promises as fs } from 'node:fs';
import { reportPath } from '@tk_wfl/o2n-core';

export async function reportCommand(vaultPath: string): Promise<number> {
  try {
    const content = await fs.readFile(reportPath(vaultPath), 'utf-8');
    console.log(content);
    return 0;
  } catch {
    console.error('レポートが見つかりません。先に migrate を実行してください。');
    return 2;
  }
}

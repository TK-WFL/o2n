import { readVaultStateFile } from '@tk_wfl/o2n-core';

export async function reportCommand(vaultPath: string): Promise<number> {
  try {
    const content = await readVaultStateFile(vaultPath, 'report.md');
    console.log(content);
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.error('レポートが見つかりません。先に migrate を実行してください。');
    return 2;
  }
}

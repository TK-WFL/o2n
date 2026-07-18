import { promises as fs } from 'node:fs';
import { scanVault, statePath, type StateFile } from '@o2n/core';

export async function verifyCommand(vaultPath: string): Promise<number> {
  let state: StateFile;
  try {
    state = JSON.parse(await fs.readFile(statePath(vaultPath), 'utf-8')) as StateFile;
  } catch {
    console.error('state.jsonが見つかりません。先に migrate を実行してください。');
    return 2;
  }

  const inventory = await scanVault(vaultPath);
  const noteStates = Object.entries(state.notes);
  const done = noteStates.filter(([, s]) => s.status === 'done').length;
  const linked = noteStates.filter(([, s]) => s.status === 'linked').length;
  const created = noteStates.filter(([, s]) => s.status === 'created').length;
  const failed = noteStates.filter(([, s]) => s.status === 'failed').length;
  const skipped = noteStates.filter(([, s]) => s.status === 'skipped').length;

  console.log(`vaultノート数: ${inventory.notes.length}`);
  console.log(`state記録ノート数: ${noteStates.length}`);
  console.log(`  done: ${done} / linked: ${linked} / created: ${created} / failed: ${failed} / skipped: ${skipped}`);

  const untracked = inventory.notes.filter((n) => !state.notes[n.path]);
  if (untracked.length > 0) {
    console.log(`\n未着手のノート (${untracked.length}件):`);
    for (const n of untracked.slice(0, 20)) console.log(`  - ${n.path}`);
    if (untracked.length > 20) console.log(`  ...他${untracked.length - 20}件`);
  }

  return failed > 0 || untracked.length > 0 ? 1 : 0;
}

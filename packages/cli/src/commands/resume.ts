import path from 'node:path';
import { migrateCommand } from './migrate.js';

export async function resumeCommand(vaultPath: string, opts: { verbose?: boolean }): Promise<number> {
  const planPath = path.join(vaultPath, '.o2n', 'plan.json');
  return migrateCommand(vaultPath, { plan: planPath, verbose: opts.verbose });
}

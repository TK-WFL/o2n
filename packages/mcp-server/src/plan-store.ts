import {
  atomicWriteVaultStateFile,
  buildPlan,
  parseMigrationPlan,
  readVaultStateFile,
  scanVault,
  type MigrationPlan,
} from '@tk_wfl/o2n-core';

export async function loadOrCreatePlan(vaultPath: string, parentPageId?: string): Promise<MigrationPlan> {
  try {
    const raw = await readVaultStateFile(vaultPath, 'plan.json');
    const plan = parseMigrationPlan(JSON.parse(raw));
    if (parentPageId) plan.parentPageId = parentPageId;
    return plan;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const inventory = await scanVault(vaultPath);
    const plan = buildPlan(inventory, { parentPageId: parentPageId ?? '' });
    await savePlan(vaultPath, plan);
    return plan;
  }
}

export async function savePlan(vaultPath: string, plan: MigrationPlan): Promise<void> {
  await atomicWriteVaultStateFile(vaultPath, 'plan.json', JSON.stringify(plan, null, 2));
}

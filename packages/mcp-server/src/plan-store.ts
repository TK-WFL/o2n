import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanVault, buildPlan, type MigrationPlan } from '@o2n/core';

function planPath(vaultPath: string): string {
  return path.join(vaultPath, '.o2n', 'plan.json');
}

export async function loadOrCreatePlan(vaultPath: string, parentPageId?: string): Promise<MigrationPlan> {
  try {
    const raw = await fs.readFile(planPath(vaultPath), 'utf-8');
    const plan = JSON.parse(raw) as MigrationPlan;
    if (parentPageId) plan.parentPageId = parentPageId;
    return plan;
  } catch {
    const inventory = await scanVault(vaultPath);
    const plan = buildPlan(inventory, { parentPageId: parentPageId ?? '' });
    await savePlan(vaultPath, plan);
    return plan;
  }
}

export async function savePlan(vaultPath: string, plan: MigrationPlan): Promise<void> {
  const p = planPath(vaultPath);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(plan, null, 2), 'utf-8');
}

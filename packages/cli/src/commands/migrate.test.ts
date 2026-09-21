import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateCommand } from './migrate.js';

let testRoot: string;
let vaultPath: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-migrate-command-'));
  testRoot = await fs.realpath(createdRoot);
  vaultPath = path.join(testRoot, 'vault');
  await fs.mkdir(vaultPath);
  await fs.writeFile(path.join(vaultPath, 'Note.md'), '# Note');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('migrateCommand plan read', () => {
  it('上位祖先symlink経由の--planを拒否する', async () => {
    const outsideDirectory = path.join(testRoot, 'outside-plan');
    const linkedAncestor = path.join(testRoot, 'linked-plan');
    const planPath = path.join(outsideDirectory, 'existing', 'plan.json');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '{"version":1}');
    await fs.symlink(outsideDirectory, linkedAncestor);

    const exitCode = await migrateCommand(vaultPath, {
      plan: path.join(linkedAncestor, 'existing', 'plan.json'),
      dryRun: true,
    });

    expect(exitCode).toBe(2);
  });
});

describe('migrateCommand dry-run（#110）', () => {
  it('dry-run は plan.json を上書きせず、レポートを report.dry-run.md に書く', async () => {
    const { buildPlan, scanVault } = await import('@tk_wfl/o2n-core');
    const inventory = await scanVault(vaultPath);
    const plan = buildPlan(inventory, { parentPageId: 'root-page' });
    const planPath = path.join(testRoot, 'plan.json');
    await fs.writeFile(planPath, JSON.stringify(plan));
    await fs.mkdir(path.join(vaultPath, '.o2n'), { recursive: true });
    await fs.writeFile(path.join(vaultPath, '.o2n', 'report.md'), 'PREVIOUS REAL RUN');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await migrateCommand(vaultPath, { plan: planPath, dryRun: true });

    expect(exitCode).toBe(0);
    expect(await fs.readFile(path.join(vaultPath, '.o2n', 'report.md'), 'utf-8')).toBe('PREVIOUS REAL RUN');
    expect(await fs.readFile(path.join(vaultPath, '.o2n', 'report.dry-run.md'), 'utf-8')).toContain('# Migration Report');
    await expect(fs.access(path.join(vaultPath, '.o2n', 'plan.json'))).rejects.toThrow();
  });
});

describe('migrateCommand --plan 省略（#116）', () => {
  it('plan.json が無ければ plan コマンドの案内付きで終了コード 2', async () => {
    const errors: string[] = [];
    (console.error as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void }).mockImplementation((...a) => errors.push(a.join(' ')));
    const exitCode = await migrateCommand(vaultPath, { dryRun: true });
    expect(exitCode).toBe(2);
    expect(errors.join('\n')).toContain('o2n plan');
  });

  it('--quiet では進捗を出さない（非TTYでも 10% ごとの行が出ない）', async () => {
    const { progressPrinter } = await import('./migrate.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    const quiet = progressPrinter(true);
    for (let i = 1; i <= 20; i += 1) quiet(i, 20, 'n');
    expect(logs).toHaveLength(0);
    const loud = progressPrinter(false);
    for (let i = 1; i <= 20; i += 1) loud(i, 20, 'n');
    spy.mockRestore();
    if (!process.stdout.isTTY) expect(logs.length).toBeLessThanOrEqual(11);
  });
});

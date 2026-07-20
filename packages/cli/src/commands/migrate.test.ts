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

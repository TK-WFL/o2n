import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreatePlan, savePlan } from './plan-store.js';

let testRoot: string;
let vaultPath: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-plan-store-'));
  testRoot = await fs.realpath(createdRoot);
  vaultPath = path.join(testRoot, 'vault');
  await fs.mkdir(vaultPath);
  await fs.writeFile(path.join(vaultPath, 'Note.md'), '# Note');
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('loadOrCreatePlan', () => {
  it('plan.jsonがENOENTの場合だけ新規作成する', async () => {
    const plan = await loadOrCreatePlan(vaultPath, 'parent-page');

    expect(plan.parentPageId).toBe('parent-page');
    const stored = JSON.parse(
      await fs.readFile(path.join(vaultPath, '.o2n', 'plan.json'), 'utf-8'),
    );
    expect(stored.parentPageId).toBe('parent-page');
  });

  it('破損JSONを握り潰して上書きしない', async () => {
    const planPath = path.join(vaultPath, '.o2n', 'plan.json');
    await fs.mkdir(path.dirname(planPath));
    await fs.writeFile(planPath, '{broken json');

    await expect(loadOrCreatePlan(vaultPath, 'parent-page')).rejects.toThrow();
    expect(await fs.readFile(planPath, 'utf-8')).toBe('{broken json');
  });
});

describe('savePlan', () => {
  it('既存plan.json symlinkを拒否しリンク先を上書きしない', async () => {
    const outsidePlan = path.join(testRoot, 'outside-plan.json');
    await fs.writeFile(outsidePlan, 'outside');
    await fs.mkdir(path.join(vaultPath, '.o2n'));
    await fs.symlink(outsidePlan, path.join(vaultPath, '.o2n', 'plan.json'));

    await expect(
      savePlan(vaultPath, {
        version: 1,
        vaultPath,
        parentPageId: 'parent-page',
        folders: [],
        frontmatterMappings: {},
        skipList: [],
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(outsidePlan, 'utf-8')).toBe('outside');
  });
});

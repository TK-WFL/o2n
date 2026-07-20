import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planCommand } from './plan.js';

let testRoot: string;
let vaultPath: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-plan-command-'));
  testRoot = await fs.realpath(createdRoot);
  vaultPath = path.join(testRoot, 'vault');
  await fs.mkdir(vaultPath);
  await fs.writeFile(path.join(vaultPath, 'Note.md'), '# Note');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('planCommand custom output', () => {
  it('--outの不足した親ディレクトリを再帰作成してplanを保存する', async () => {
    const outputPath = path.join(testRoot, 'new', 'nested', 'plan.json');

    const result = await planCommand(vaultPath, {
      out: outputPath,
      parent: 'parent-page',
      yes: true,
    });

    expect(result).toBe(outputPath);
    const plan = JSON.parse(await fs.readFile(outputPath, 'utf-8'));
    expect(plan.parentPageId).toBe('parent-page');
  });
});

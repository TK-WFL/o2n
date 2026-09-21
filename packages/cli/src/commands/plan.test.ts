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

describe('planCommand 非対話環境（#110）', () => {
  it('stdin/stdout が TTY でなく --parent も無い場合は PlanInputRequiredError', async () => {
    const { PlanInputRequiredError } = await import('./plan.js');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(planCommand(vaultPath, {})).rejects.toBeInstanceOf(PlanInputRequiredError);
  });

  it('非対話環境でも --parent があれば plan を書き、DB 提案は --yes 無しでは page_tree のまま', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await fs.mkdir(path.join(vaultPath, 'DB'));
    for (const n of ['a', 'b', 'c']) await fs.writeFile(path.join(vaultPath, 'DB', `${n}.md`), '---\nx: 1\ny: 2\nz: 3\n---\n');
    const out = path.join(testRoot, 'p.json');
    await planCommand(vaultPath, { parent: 'root', out });
    const plan = JSON.parse(await fs.readFile(out, 'utf-8')) as { folders: Array<{ folderPath: string; mode: string }> };
    expect(plan.folders.find((f) => f.folderPath === 'DB')?.mode).toBe('page_tree');
  });
});

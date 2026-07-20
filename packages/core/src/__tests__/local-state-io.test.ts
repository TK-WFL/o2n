import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteVaultStateFile,
  readVaultStateFile,
} from '../local-state-io.js';

let testRoot: string;
let vaultPath: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-local-state-'));
  vaultPath = path.join(testRoot, 'vault');
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('vault local state I/O', () => {
  it('report.md symlinkを追跡してvault外を読み取らない', async () => {
    const outsideReport = path.join(testRoot, 'secret.md');
    await fs.writeFile(outsideReport, 'outside secret');
    await fs.mkdir(path.join(vaultPath, '.o2n'));
    await fs.symlink(outsideReport, path.join(vaultPath, '.o2n', 'report.md'));

    await expect(readVaultStateFile(vaultPath, 'report.md')).rejects.toThrow();
  });

  it('plan.json symlinkを拒否し、リンク先を上書きしない', async () => {
    const outsidePlan = path.join(testRoot, 'outside-plan.json');
    await fs.writeFile(outsidePlan, 'do not replace');
    await fs.mkdir(path.join(vaultPath, '.o2n'));
    await fs.symlink(outsidePlan, path.join(vaultPath, '.o2n', 'plan.json'));

    await expect(
      atomicWriteVaultStateFile(vaultPath, 'plan.json', '{"safe":true}'),
    ).rejects.toThrow();
    expect(await fs.readFile(outsidePlan, 'utf-8')).toBe('do not replace');
  });

  it('.o2nディレクトリ自体がsymlinkなら読み書きを拒否する', async () => {
    const outsideDirectory = path.join(testRoot, 'outside-state');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'report.md'), 'outside report');
    await fs.symlink(outsideDirectory, path.join(vaultPath, '.o2n'));

    await expect(readVaultStateFile(vaultPath, 'report.md')).rejects.toThrow();
    await expect(
      atomicWriteVaultStateFile(vaultPath, 'state.json', '{"version":2}'),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(outsideDirectory, 'state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('state.jsonを同一ディレクトリへatomic writeし通常ファイルとして読める', async () => {
    await atomicWriteVaultStateFile(vaultPath, 'state.json', '{"version":2}');

    expect(await readVaultStateFile(vaultPath, 'state.json')).toBe('{"version":2}');
    const directoryStat = await fs.stat(path.join(vaultPath, '.o2n'));
    const fileStat = await fs.stat(path.join(vaultPath, '.o2n', 'state.json'));
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

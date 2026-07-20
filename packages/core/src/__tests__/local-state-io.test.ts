import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteRegularFileNoFollow,
  atomicWriteVaultStateFile,
  readRegularFileNoFollow,
  readVaultStateFile,
} from '../local-state-io.js';

let testRoot: string;
let vaultPath: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-local-state-'));
  testRoot = await fs.realpath(createdRoot);
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

  it.each(['plan.json', 'report.md', 'state.json'] as const)(
    'O_NOFOLLOWなしでも%s symlinkの読取りを拒否する',
    async (fileName) => {
      const outsideFile = path.join(testRoot, `outside-${fileName}`);
      await fs.writeFile(outsideFile, 'outside secret');
      await fs.mkdir(path.join(vaultPath, '.o2n'));
      await fs.symlink(outsideFile, path.join(vaultPath, '.o2n', fileName));

      await expect(
        readVaultStateFile(vaultPath, fileName, { noFollowFlag: 0 }),
      ).rejects.toThrow();
    },
  );

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

  it('O_NOFOLLOWなしでも任意plan pathのsymlink読取りを拒否する', async () => {
    const outsidePlan = path.join(testRoot, 'outside-custom-plan.json');
    const planLink = path.join(testRoot, 'custom-plan.json');
    await fs.writeFile(outsidePlan, '{"secret":true}');
    await fs.symlink(outsidePlan, planLink);

    await expect(
      readRegularFileNoFollow(planLink, { noFollowFlag: 0 }),
    ).rejects.toThrow();
  });

  it('custom outputの不足した親ディレクトリを安全に再帰作成する', async () => {
    const outputPath = path.join(testRoot, 'new', 'nested', 'plan.json');

    await atomicWriteRegularFileNoFollow(outputPath, '{"version":1}');

    expect(await fs.readFile(outputPath, 'utf-8')).toBe('{"version":1}');
  });

  it('相対custom outputでも不足した親ディレクトリを再帰作成する', async () => {
    const outputPath = path.join(testRoot, 'relative', 'nested', 'plan.json');
    const relativeOutputPath = path.relative(process.cwd(), outputPath);

    await atomicWriteRegularFileNoFollow(relativeOutputPath, '{"version":1}');

    expect(await fs.readFile(outputPath, 'utf-8')).toBe('{"version":1}');
  });

  it('custom outputの既存symlink祖先を拒否する', async () => {
    const outsideDirectory = path.join(testRoot, 'outside-output');
    const linkedAncestor = path.join(testRoot, 'linked-output');
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, linkedAncestor);

    await expect(
      atomicWriteRegularFileNoFollow(
        path.join(linkedAncestor, 'nested', 'plan.json'),
        '{"version":1}',
      ),
    ).rejects.toThrow();
    await expect(
      fs.lstat(path.join(outsideDirectory, 'nested', 'plan.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('symlink祖先の配下に既存directoryがあっても拒否する', async () => {
    const outsideDirectory = path.join(testRoot, 'outside-with-existing');
    const linkedAncestor = path.join(testRoot, 'linked-with-existing');
    await fs.mkdir(path.join(outsideDirectory, 'existing'), { recursive: true });
    await fs.symlink(outsideDirectory, linkedAncestor);

    await expect(
      atomicWriteRegularFileNoFollow(
        path.join(linkedAncestor, 'existing', 'new', 'plan.json'),
        '{"version":1}',
      ),
    ).rejects.toThrow();
    await expect(
      fs.lstat(path.join(outsideDirectory, 'existing', 'new', 'plan.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('複数の既存segmentを検証してからdeep nestedを作成する', async () => {
    const existingParent = path.join(testRoot, 'existing', 'segments');
    const outputPath = path.join(existingParent, 'new', 'deep', 'plan.json');
    await fs.mkdir(existingParent, { recursive: true });

    await atomicWriteRegularFileNoFollow(outputPath, '{"version":1}');

    expect(await fs.readFile(outputPath, 'utf-8')).toBe('{"version":1}');
  });
});

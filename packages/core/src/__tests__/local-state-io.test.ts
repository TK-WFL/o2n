import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteRegularFileNoFollow,
  atomicWriteVaultStateFile,
  readRegularFileNoFollow,
  readVaultStateFile,
  validateTrustedDirectoryAncestry,
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

  it('上位祖先symlink配下の既存plan読取りを拒否する', async () => {
    const outsideDirectory = path.join(testRoot, 'outside-read');
    const linkedAncestor = path.join(testRoot, 'linked-read');
    const outsidePlan = path.join(outsideDirectory, 'existing', 'plan.json');
    await fs.mkdir(path.dirname(outsidePlan), { recursive: true });
    await fs.writeFile(outsidePlan, '{"secret":true}');
    await fs.symlink(outsideDirectory, linkedAncestor);

    await expect(
      readRegularFileNoFollow(path.join(linkedAncestor, 'existing', 'plan.json')),
    ).rejects.toThrow();
  });

  it('deep absolute plan pathを正常に読み取る', async () => {
    const planPath = path.join(testRoot, 'absolute', 'deep', 'existing', 'plan.json');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '{"version":1}');

    await expect(readRegularFileNoFollow(planPath)).resolves.toBe('{"version":1}');
  });

  it('deep relative plan pathを正常に読み取る', async () => {
    const planPath = path.join(testRoot, 'relative-read', 'deep', 'plan.json');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '{"version":1}');

    await expect(
      readRegularFileNoFollow(path.relative(process.cwd(), planPath)),
    ).resolves.toBe('{"version":1}');
  });

  it.skipIf(typeof process.geteuid !== 'function')(
    'root-owned 0755 filesystem rootをtrusted ancestorとして許可する',
    async () => {
      const filesystemRoot = path.parse(testRoot).root;
      const rootStat = await fs.stat(filesystemRoot);
      expect(rootStat.uid).toBe(0);
      expect(rootStat.mode & 0o777).toBe(0o755);

      await expect(
        validateTrustedDirectoryAncestry(filesystemRoot),
      ).resolves.toBeUndefined();
    },
  );

  it('user-owned 0777 non-sticky ancestorを拒否する', async () => {
    const writableAncestor = path.join(testRoot, 'writable-ancestor');
    const planPath = path.join(writableAncestor, 'existing', 'plan.json');
    const untrustedVault = path.join(writableAncestor, 'vault');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.mkdir(untrustedVault);
    await fs.writeFile(planPath, '{"version":1}');
    await fs.chmod(writableAncestor, 0o777);

    await expect(readRegularFileNoFollow(planPath)).rejects.toThrow();
    await expect(
      atomicWriteRegularFileNoFollow(path.join(writableAncestor, 'output', 'plan.json'), '{}'),
    ).rejects.toThrow();
    await expect(
      atomicWriteVaultStateFile(untrustedVault, 'state.json', '{}'),
    ).rejects.toThrow();
  });

  it('user-owned writable sticky ancestorをroot sticky例外として扱わない', async () => {
    const writableSticky = path.join(testRoot, 'user-sticky');
    await fs.mkdir(writableSticky, { mode: 0o700 });
    await fs.chmod(writableSticky, 0o1777);

    await expect(
      validateTrustedDirectoryAncestry(writableSticky),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'root-owned sticky /tmpとcurrent-user-owned 0700 childを許可する',
    async () => {
      const canonicalTmp = await fs.realpath('/tmp');
      const tmpStat = await fs.stat(canonicalTmp);
      expect(tmpStat.uid).toBe(0);
      expect(tmpStat.mode & 0o1000).toBe(0o1000);
      const trustedChild = await fs.mkdtemp(path.join(canonicalTmp, 'o2n-trusted-'));
      try {
        await fs.chmod(trustedChild, 0o700);
        await expect(
          validateTrustedDirectoryAncestry(trustedChild),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(trustedChild, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32' || typeof process.geteuid !== 'function')(
    'root-owned sticky配下の別UID所有childを拒否する',
    async () => {
      const canonicalTmp = await fs.realpath('/tmp');
      const child = await fs.mkdtemp(path.join(canonicalTmp, 'o2n-untrusted-'));
      try {
        await fs.chmod(child, 0o700);
        await expect(
          validateTrustedDirectoryAncestry(child, process.geteuid!() + 1),
        ).rejects.toThrow();
      } finally {
        await fs.rm(child, { recursive: true, force: true });
      }
    },
  );

  it('parent open後の上位祖先差替えを外部plan読取りとして成功扱いしない', async () => {
    const safeAncestor = path.join(testRoot, 'safe-read', 'ancestor');
    const safePlan = path.join(safeAncestor, 'parent', 'plan.json');
    const movedAncestor = path.join(testRoot, 'safe-read', 'ancestor-moved');
    const outsideAncestor = path.join(testRoot, 'outside-swapped-read');
    const outsidePlan = path.join(outsideAncestor, 'parent', 'plan.json');
    await fs.mkdir(path.dirname(safePlan), { recursive: true });
    await fs.mkdir(path.dirname(outsidePlan), { recursive: true });
    await fs.writeFile(safePlan, '{"safe":true}');
    await fs.writeFile(outsidePlan, '{"secret":true}');

    await expect(
      readRegularFileNoFollow(safePlan, {
        testHooks: {
          afterParentOpen: async () => {
            await fs.rename(safeAncestor, movedAncestor);
            await fs.symlink(outsideAncestor, safeAncestor);
          },
        },
      }),
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

  it('temp open後にparentが差し替えられたら秘密を書かず別inodeをcleanupしない', async () => {
    const stateDirectory = path.join(vaultPath, '.o2n');
    const movedDirectory = path.join(vaultPath, '.o2n-moved');
    let attackerTemporary = '';

    await expect(
      atomicWriteVaultStateFile(vaultPath, 'plan.json', 'secret plan', {
        testHooks: {
          afterTemporaryOpen: async ({ temporaryPath }) => {
            await fs.rename(stateDirectory, movedDirectory);
            await fs.mkdir(stateDirectory, { mode: 0o700 });
            attackerTemporary = temporaryPath;
            await fs.writeFile(attackerTemporary, 'attacker-owned');
          },
        },
      }),
    ).rejects.toThrow();

    expect(await fs.readFile(attackerTemporary, 'utf-8')).toBe('attacker-owned');
    const movedEntries = await fs.readdir(movedDirectory);
    const openedTemporary = movedEntries.find((entry) => entry.includes('.plan.json.tmp-'));
    expect(openedTemporary).toBeDefined();
    expect(
      await fs.readFile(path.join(movedDirectory, openedTemporary!), 'utf-8'),
    ).toBe('');
  });

  it('rename直後にdestination inodeが差し替えられたら成功扱いしない', async () => {
    const replacedDestination = path.join(vaultPath, '.o2n', 'replaced-plan.json');
    let destinationPath = '';

    await expect(
      atomicWriteVaultStateFile(vaultPath, 'plan.json', 'secret plan', {
        testHooks: {
          afterRename: async (context) => {
            destinationPath = context.destinationPath;
            await fs.rename(destinationPath, replacedDestination);
            await fs.writeFile(destinationPath, 'attacker replacement');
          },
        },
      }),
    ).rejects.toThrow();

    expect(await fs.readFile(destinationPath, 'utf-8')).toBe('attacker replacement');
    expect(await fs.readFile(replacedDestination, 'utf-8')).toBe('secret plan');
  });

  it('tempへhardlinkが追加されたら秘密を書き込まない', async () => {
    const hardlinkPath = path.join(vaultPath, 'temp-hardlink');

    await expect(
      atomicWriteVaultStateFile(vaultPath, 'state.json', 'secret state', {
        testHooks: {
          afterTemporaryOpen: async ({ temporaryPath }) => {
            await fs.link(temporaryPath, hardlinkPath);
          },
        },
      }),
    ).rejects.toThrow();

    expect(await fs.readFile(hardlinkPath, 'utf-8')).toBe('');
  });

  it('owner検証なしでも0644 tempを拒否して書き込まない', async () => {
    let temporaryPath = '';

    await expect(
      atomicWriteVaultStateFile(vaultPath, 'report.md', 'secret report', {
        testHooks: {
          beforeTemporaryValidation: async (context) => {
            temporaryPath = context.temporaryPath;
            await fs.chmod(temporaryPath, 0o644);
          },
        },
      }),
    ).rejects.toThrow();

    expect(await fs.readFile(temporaryPath, 'utf-8')).toBe('');
  });

  it('owner検証なしでもrename後destinationが0644なら成功扱いしない', async () => {
    let destinationPath = '';

    await expect(
      atomicWriteVaultStateFile(vaultPath, 'report.md', 'secret report', {
        testHooks: {
          afterRename: async (context) => {
            destinationPath = context.destinationPath;
            await fs.chmod(destinationPath, 0o644);
          },
        },
      }),
    ).rejects.toThrow();

    expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o644);
  });

  it('owner検証なしのvault atomic writeでも0600を許可する', async () => {
    await atomicWriteVaultStateFile(vaultPath, 'report.md', 'safe report');

    const destinationPath = path.join(vaultPath, '.o2n', 'report.md');
    expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(destinationPath, 'utf-8')).toBe('safe report');
  });
});
